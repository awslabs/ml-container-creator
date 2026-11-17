# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
"""Price resolver + cost math (Wave 9: R7 price resolver, R8 cost, R9 Bedrock).

Purpose: the ONLY source of $/hour and $/token figures in MLCC. Every price
comes from the AWS Price List API (``pricing:GetProducts``) or from a snapshot
that this module's own ``snapshot`` command generated from that API. Each
figure carries its source and retrieval date. A lookup that does not yield
exactly one on-demand USD price is a miss (NULL plus a reason), never a guess.

Lookup order (R7.2), per (instance, region, target):
    1. project cache   .mlcc/pricing-cache.json   (entries <= 24 h old)
    2. Pricing API     GetProducts via the us-east-1 Price List endpoint
    3. snapshot        .mlcc/pricing-snapshot.json (copied at generate time from
                       servers/lib/catalogs/pricing-snapshot.json)
    4. NULL            with the reasons from steps 2 and 3

The Price List service + component and the billed instance-count basis are
DERIVED from the target descriptor's ``pricing`` block (targets.d, ADR-008);
this module only knows per-SERVICE Price List conventions (attribute names),
never per-target ones.

Price List facts (Task 1, live GetProducts, 2026-10-26):
    AmazonSageMaker  instanceName=ml.<f>.<s>, regionCode, component in
                     {Hosting, AsyncInf, BatchTransform, Cluster}; one product,
                     OnDemand term only, unit "Hrs".
    AmazonEC2        instanceType=<f>.<s> (no "ml."), regionCode,
                     operatingSystem=Linux, tenancy=Shared, preInstalledSw=NA,
                     capacitystatus=Used -> one product; OnDemand unit "Hrs".
    AmazonBedrock    model=<Price List model name>, regionCode,
                     feature="On-demand Inference", inferenceType in
                     {"Input tokens", "Output tokens"}; unit "1K tokens".

Stdlib + lazily imported boto3 only (no new runtime dependency). Clients are
injectable so unit tests never touch the network.

CLI:
    pricing.py resolve --instance ml.g5.xlarge --region us-west-2 --target realtime-inference [--no-api]
    pricing.py bedrock-prices --model "Gemma 3 12B" --region us-west-2 [--no-api]
    pricing.py snapshot --out servers/lib/catalogs/pricing-snapshot.json [--regions r1,r2]
    pricing.py verify-bedrock <hf-model-id> <bedrock-model-id> --price-list-model "<name>" --catalog <file>

IAM: pricing:GetProducts (runtime + snapshot); bedrock:ListFoundationModels
(verify-bedrock only); sagemaker:DescribeEndpoint (realtime instance count).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

# ── Constants ─────────────────────────────────────────────────────────────────

# The Price List Query API is served from a few regions only; us-east-1 is the
# endpoint used for every lookup regardless of the run's region.
PRICING_API_REGION = 'us-east-1'
CACHE_TTL = timedelta(hours=24)

SOURCE_API = 'pricing-api'
SOURCE_CACHE = 'pricing-api-cache'
SOURCE_SNAPSHOT = 'snapshot'
SNAPSHOT_SOURCE_LABEL = 'AWS Price List GetProducts'

CACHE_FILENAME = 'pricing-cache.json'
SNAPSHOT_FILENAME = 'pricing-snapshot.json'
BEDROCK_CATALOG_FILENAME = 'bedrock-equivalents.json'

# Set to 1 to skip every live AWS call (Pricing, DescribeEndpoint): cache and
# snapshot only. Dry-run writes use the same offline mode.
OFFLINE_ENV = 'MLCC_PRICING_OFFLINE'

# Per-SERVICE Price List conventions (attribute names; not per-target).
_SERVICE_RULES = {
    'AmazonSageMaker': {
        'instance_field': 'instanceName',
        'strip_ml_prefix': False,
        'uses_component': True,
        'extra_filters': (),
    },
    'AmazonEC2': {
        'instance_field': 'instanceType',
        'strip_ml_prefix': True,
        'uses_component': False,
        'extra_filters': (
            ('operatingSystem', 'Linux'),
            ('tenancy', 'Shared'),
            ('preInstalledSw', 'NA'),
            ('capacitystatus', 'Used'),
        ),
    },
}

_HOURLY_UNITS = {'Hrs': 1.0}
# Bedrock token units normalized to "per 1M tokens"; any other unit is a miss.
_TOKEN_UNITS_PER_1M = {'1K tokens': 1000.0, '1M tokens': 1.0}

BEDROCK_SERVICE = 'AmazonBedrock'
BEDROCK_FEATURE = 'On-demand Inference'
BEDROCK_TOKEN_TYPES = {'input': 'Input tokens', 'output': 'Output tokens'}

COST_CAVEAT = (
    'Assumes sustained utilization during billed hours; idle and '
    'scale-to-zero time are not included (BL202 / Wave 10).'
)

_INSTANCE_RE = re.compile(r'^ml\.[a-z0-9-]+\.[a-z0-9]+$')
_REGION_RE = re.compile(r'^[a-z]{2}(-[a-z]+)+-\d+$')


class PriceMiss(Exception):
    """A lookup that did not produce exactly one usable on-demand price."""


# ── Paths ─────────────────────────────────────────────────────────────────────


def _project_root() -> str:
    # <project>/do/lib/python -> <project>  (source tree: templates/do/lib/python -> repo)
    return os.path.normpath(os.path.join(_HERE, '..', '..', '..'))


def _source_catalogs_dir() -> str:
    # Source tree only: templates/do/lib/python -> repo/servers/lib/catalogs
    return os.path.normpath(os.path.join(_HERE, '..', '..', '..', '..', 'servers', 'lib', 'catalogs'))


def default_cache_path() -> str:
    return os.path.join(_project_root(), '.mlcc', CACHE_FILENAME)


def _first_existing(paths):
    for p in paths:
        if p and os.path.isfile(p):
            return p
    return None


def default_snapshot_path() -> str | None:
    """Generated project: .mlcc/pricing-snapshot.json; source tree fallback:
    servers/lib/catalogs/pricing-snapshot.json."""
    root = _project_root()
    return _first_existing([
        os.path.join(root, '.mlcc', SNAPSHOT_FILENAME),
        os.path.join(_source_catalogs_dir(), SNAPSHOT_FILENAME),
    ])


def default_bedrock_catalog_path() -> str | None:
    root = _project_root()
    return _first_existing([
        os.path.join(root, '.mlcc', BEDROCK_CATALOG_FILENAME),
        os.path.join(_source_catalogs_dir(), BEDROCK_CATALOG_FILENAME),
    ])


# ── JSON helpers ──────────────────────────────────────────────────────────────


def _load_json(path) -> dict:
    """Read a JSON object; absent / unparseable files are treated as empty."""
    if not path:
        return {}
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        print(f'⚠️  pricing: ignoring unreadable {path}: {exc}', file=sys.stderr)
        return {}


def _atomic_write_json(path: str, data: dict) -> None:
    """Write JSON via temp file + rename so a reader never sees a partial file."""
    directory = os.path.dirname(path) or '.'
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.pricing-', suffix='.json', dir=directory)
    try:
        os.chmod(tmp, 0o644)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, sort_keys=True)
            f.write('\n')
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def _parse_iso(value) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _offline() -> bool:
    return os.environ.get(OFFLINE_ENV, '').strip().lower() in ('1', 'true', 'yes')


# ── Descriptor-derived spec ───────────────────────────────────────────────────


def pricing_spec(target: str, targets_dir: str | None = None) -> dict:
    """Return the target descriptor's pricing block (service, component,
    instance_count). Raises PriceMiss when the target or block is missing."""
    import target_manifest  # local helper (same directory)

    try:
        spec = target_manifest.pricing(target, targets_dir)
    except target_manifest.ManifestError as exc:
        raise PriceMiss(f'unknown target {target!r}: {exc}') from exc
    if not spec.get('service'):
        raise PriceMiss(f'target {target!r} declares no pricing block')
    if spec['service'] not in _SERVICE_RULES:
        raise PriceMiss(f'unsupported pricing service {spec["service"]!r}')
    return spec


def instance_cache_key(service: str, component: str | None, instance: str, region: str) -> str:
    return f'{service}/{component or "-"}/{region}/{instance}'


def bedrock_cache_key(price_list_model: str, region: str, token_type: str) -> str:
    return f'{BEDROCK_SERVICE}/{price_list_model}/{region}/{token_type}'


def build_instance_filters(instance: str, region: str, spec: dict) -> tuple[str, list]:
    """Return (ServiceCode, Filters) for an instance-hour lookup."""
    service = spec['service']
    rules = _SERVICE_RULES[service]
    value = instance
    if rules['strip_ml_prefix'] and value.startswith('ml.'):
        value = value[3:]
    filters = [
        {'Type': 'TERM_MATCH', 'Field': rules['instance_field'], 'Value': value},
        {'Type': 'TERM_MATCH', 'Field': 'regionCode', 'Value': region},
    ]
    if rules['uses_component']:
        if not spec.get('component'):
            raise PriceMiss(f'{service} pricing needs a component in the target descriptor')
        filters.append({'Type': 'TERM_MATCH', 'Field': 'component', 'Value': spec['component']})
    for field, val in rules['extra_filters']:
        filters.append({'Type': 'TERM_MATCH', 'Field': field, 'Value': val})
    return service, filters


def build_bedrock_filters(price_list_model: str, region: str, token_type: str) -> list:
    return [
        {'Type': 'TERM_MATCH', 'Field': 'model', 'Value': price_list_model},
        {'Type': 'TERM_MATCH', 'Field': 'regionCode', 'Value': region},
        {'Type': 'TERM_MATCH', 'Field': 'feature', 'Value': BEDROCK_FEATURE},
        {'Type': 'TERM_MATCH', 'Field': 'inferenceType', 'Value': BEDROCK_TOKEN_TYPES[token_type]},
    ]


# ── Price List parsing ────────────────────────────────────────────────────────


def parse_single_price(price_list, unit_scale: dict) -> tuple[float, str]:
    """Extract exactly one on-demand USD price from a GetProducts PriceList.

    ``price_list`` items are JSON strings (as boto3 returns them) or dicts.
    ``unit_scale`` maps an accepted unit to the factor applied to the USD value.
    Returns (normalized_usd, unit). Raises PriceMiss with reason 'not-found',
    'ambiguous (...)', 'unsupported unit ...' or 'non-positive price'.
    Only terms.OnDemand is read (no Reserved / Savings Plans, OQ-9.4).
    """
    values = set()
    units = set()
    unsupported = set()
    for item in price_list or []:
        try:
            product = json.loads(item) if isinstance(item, str) else item
        except ValueError:
            continue
        on_demand = (product.get('terms') or {}).get('OnDemand') or {}
        for term in on_demand.values():
            for dim in (term.get('priceDimensions') or {}).values():
                unit = dim.get('unit', '')
                usd = (dim.get('pricePerUnit') or {}).get('USD')
                if usd is None:
                    continue
                if unit not in unit_scale:
                    unsupported.add(unit)
                    continue
                try:
                    values.add(round(float(usd) * unit_scale[unit], 10))
                except (TypeError, ValueError):
                    continue
                units.add(unit)
    if not values:
        if unsupported:
            raise PriceMiss(f'unsupported unit {sorted(unsupported)}')
        raise PriceMiss('not-found')
    if len(values) > 1:
        raise PriceMiss(f'ambiguous ({len(values)} distinct on-demand prices)')
    value = values.pop()
    if value <= 0:
        raise PriceMiss('non-positive price')
    return value, sorted(units)[0]


def _get_products(client, service_code: str, filters: list) -> list:
    out = []
    kwargs = {'ServiceCode': service_code, 'Filters': filters, 'MaxResults': 100}
    while True:
        resp = client.get_products(**kwargs)
        out.extend(resp.get('PriceList', []) or [])
        token = resp.get('NextToken')
        if not token:
            return out
        kwargs['NextToken'] = token


def _pricing_client(client=None):
    if client is not None:
        return client
    import boto3
    from botocore.config import Config

    return boto3.client(
        'pricing', region_name=PRICING_API_REGION,
        config=Config(retries={'max_attempts': 5, 'mode': 'standard'}, read_timeout=30, connect_timeout=10),
    )


def _api_error_reason(exc: Exception) -> str:
    text = str(exc)
    if 'AccessDenied' in text or 'not authorized' in text:
        return f'AccessDenied (needs pricing:GetProducts): {text[:160]}'
    return f'{type(exc).__name__}: {text[:160]}'


# ── Resolution core (cache -> API -> snapshot -> NULL) ────────────────────────


def _resolve_key(key, fetch, *, cache_path, snapshot_path, allow_api, now):
    """Shared lookup chain. ``fetch`` returns (usd, unit) or raises.

    Returns dict {usd, unit, source, as_of, reason[, fallback_reason]}; usd
    None on a miss. ``fallback_reason`` explains why the snapshot was used.
    """
    now = now or _now_utc()
    reasons = []

    cache = _load_json(cache_path) if cache_path else {}
    hit = cache.get(key)
    if isinstance(hit, dict) and isinstance(hit.get('usd'), (int, float)) and hit['usd'] > 0:
        as_of = _parse_iso(hit.get('as_of'))
        if as_of is not None and now - as_of <= CACHE_TTL:
            return {'usd': float(hit['usd']), 'unit': hit.get('unit'), 'source': SOURCE_CACHE,
                    'as_of': hit.get('as_of'), 'reason': None}

    if allow_api and not _offline():
        try:
            usd, unit = fetch()
            as_of = _iso(now)
            if cache_path:
                try:
                    cache = _load_json(cache_path)
                    cache[key] = {'usd': usd, 'unit': unit, 'as_of': as_of, 'source': SOURCE_API}
                    _atomic_write_json(cache_path, cache)
                except OSError:
                    pass  # cache write failure is non-fatal (design §10)
            return {'usd': usd, 'unit': unit, 'source': SOURCE_API, 'as_of': as_of, 'reason': None}
        except PriceMiss as exc:
            reasons.append(f'pricing-api: {exc}')
        except Exception as exc:  # creds / throttle / network
            reasons.append(f'pricing-api: {_api_error_reason(exc)}')
    else:
        reasons.append('pricing-api: skipped (offline)')

    snap = _load_json(snapshot_path) if snapshot_path else {}
    entry = (snap.get('entries') or {}).get(key)
    if isinstance(entry, dict) and isinstance(entry.get('usd'), (int, float)) and entry['usd'] > 0 \
            and entry.get('as_of'):
        return {'usd': float(entry['usd']), 'unit': entry.get('unit'), 'source': SOURCE_SNAPSHOT,
                'as_of': entry.get('as_of'), 'reason': None, 'fallback_reason': '; '.join(reasons)}
    reasons.append('snapshot: no entry' if snapshot_path else 'snapshot: not available')

    return {'usd': None, 'unit': None, 'source': None, 'as_of': None, 'reason': '; '.join(reasons)}


def resolve_instance_price(instance: str, region: str, target: str, *, client=None,
                           cache_path: str | None = None, snapshot_path: str | None = None,
                           allow_api: bool = True, now: datetime | None = None,
                           targets_dir: str | None = None) -> dict:
    """Resolve the on-demand USD/hour for (instance, region, target).

    Returns {usd_per_hour, source, as_of, component, service, region, instance,
    reason}. usd_per_hour is None (with reason) on any miss.
    """
    result = {'usd_per_hour': None, 'source': None, 'as_of': None, 'component': None,
              'service': None, 'region': region, 'instance': instance, 'reason': None}
    if not instance or not _INSTANCE_RE.match(instance):
        result['reason'] = f'invalid instance type {instance!r} (expected ml.<family>.<size>)'
        return result
    if not region or not _REGION_RE.match(region):
        result['reason'] = f'invalid region {region!r}'
        return result
    try:
        spec = pricing_spec(target, targets_dir)
        service, filters = build_instance_filters(instance, region, spec)
    except PriceMiss as exc:
        result['reason'] = str(exc)
        return result
    result['service'] = service
    result['component'] = spec.get('component') or service

    def fetch():
        return parse_single_price(_get_products(_pricing_client(client), service, filters), _HOURLY_UNITS)

    got = _resolve_key(instance_cache_key(service, spec.get('component'), instance, region), fetch,
                       cache_path=cache_path, snapshot_path=snapshot_path, allow_api=allow_api, now=now)
    result.update({'usd_per_hour': got['usd'], 'source': got['source'], 'as_of': got['as_of'],
                   'reason': got['reason'], 'fallback_reason': got.get('fallback_reason')})
    return result


def resolve_bedrock_prices(price_list_model: str, region: str, *, client=None,
                           cache_path: str | None = None, snapshot_path: str | None = None,
                           allow_api: bool = True, now: datetime | None = None) -> dict:
    """Resolve Bedrock on-demand input/output prices, normalized to USD per 1M
    tokens, in ``region`` only (no cross-region substitution, R9.2).

    Returns {input_usd_per_1m, output_usd_per_1m, source, as_of, region, reason};
    both prices None on any miss.
    """
    out = {'input_usd_per_1m': None, 'output_usd_per_1m': None, 'source': None,
           'as_of': None, 'region': region, 'reason': None}
    if not price_list_model:
        out['reason'] = 'no Price List model name'
        return out
    got = {}
    for token_type in ('input', 'output'):
        filters = build_bedrock_filters(price_list_model, region, token_type)

        def fetch(filters=filters):
            return parse_single_price(_get_products(_pricing_client(client), BEDROCK_SERVICE, filters),
                                      _TOKEN_UNITS_PER_1M)

        got[token_type] = _resolve_key(bedrock_cache_key(price_list_model, region, token_type), fetch,
                                       cache_path=cache_path, snapshot_path=snapshot_path,
                                       allow_api=allow_api, now=now)
        if got[token_type]['usd'] is None:
            out['reason'] = f'{token_type} price: {got[token_type]["reason"]}'
            return out
    out['input_usd_per_1m'] = got['input']['usd']
    out['output_usd_per_1m'] = got['output']['usd']
    sources = {got['input']['source'], got['output']['source']}
    out['source'] = sources.pop() if len(sources) == 1 else '+'.join(sorted(sources))
    out['as_of'] = min(got['input']['as_of'], got['output']['as_of'])
    return out


# ── Cost (R8) ─────────────────────────────────────────────────────────────────


def compute_cost(usd_per_hour, instance_count, output_tps):
    """USD per 1M output tokens = usd/h x count x 1e6 / (3600 x output tok/s).

    Returns None when any input is missing or non-positive (never a guess).
    """
    try:
        usd = float(usd_per_hour)
        count = float(instance_count)
        tps = float(output_tps)
    except (TypeError, ValueError):
        return None
    if usd <= 0 or count <= 0 or tps <= 0 or math.isnan(tps):
        return None
    return round(usd * count * 1e6 / (3600.0 * tps), 4)


def _positive_int(value):
    try:
        n = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def compute_instance_count(target: str, *, gpus_per_instance=None, env=None, endpoint_name=None,
                           region=None, sm_client=None, allow_api: bool = True,
                           targets_dir: str | None = None) -> tuple:
    """Billed instance count for one run (R8.2), derived from the descriptor's
    pricing.instance_count block. Returns (count | None, reason | None).

    endpoint-current: DescribeEndpoint ProductionVariants[0].CurrentInstanceCount.
    replicas: ceil(replicas x gpus_per_replica / gpus_per_instance); a
    gpus_per_replica of 'auto' (or unset) means one whole instance per replica.
    """
    env = env if env is not None else os.environ
    try:
        spec = pricing_spec(target, targets_dir)
    except PriceMiss as exc:
        return None, str(exc)
    basis_block = spec.get('instance_count') or {}
    basis = basis_block.get('basis')

    if basis == 'endpoint-current':
        if not endpoint_name:
            return None, 'no endpoint name for DescribeEndpoint'
        if not allow_api or _offline():
            return None, 'DescribeEndpoint skipped (offline)'
        try:
            if sm_client is None:
                import boto3
                sm_client = boto3.client('sagemaker', region_name=region)
            resp = sm_client.describe_endpoint(EndpointName=endpoint_name)
            variants = resp.get('ProductionVariants') or []
            count = _positive_int(variants[0].get('CurrentInstanceCount')) if variants else None
            if count is None:
                return None, 'endpoint reports no CurrentInstanceCount'
            return count, None
        except Exception as exc:
            return None, f'DescribeEndpoint failed: {str(exc)[:160]}'

    if basis == 'replicas':
        replicas = _positive_int(env.get(basis_block.get('replicas_var', ''), ''))
        if replicas is None:
            return None, f'{basis_block.get("replicas_var")} is not a positive integer'
        raw_gpr = str(env.get(basis_block.get('gpus_per_replica_var', ''), '') or '').strip().lower()
        if raw_gpr in ('', 'auto'):
            return replicas, None
        gpr = _positive_int(raw_gpr)
        gpi = _positive_int(gpus_per_instance)
        if gpr is None:
            return None, f'{basis_block.get("gpus_per_replica_var")}={raw_gpr!r} is not a positive integer'
        if gpi is None:
            return None, 'GPUs per instance unknown (instance not in catalog)'
        return int(math.ceil(replicas * gpr / float(gpi))), None

    return None, f'instance count basis {basis!r} has no benchmark derivation'


# ── Bedrock comparison (R9) ───────────────────────────────────────────────────


def load_bedrock_catalog(path: str | None = None) -> dict:
    """Return {hf model id: entry} from bedrock-equivalents.json (or {})."""
    data = _load_json(path if path else default_bedrock_catalog_path())
    models = data.get('models')
    return models if isinstance(models, dict) else {}


def bedrock_comparison(model_name: str, *, adapter_name: str | None, region: str,
                       input_seq_len_avg, output_seq_len_avg, catalog: dict | None = None,
                       price_resolver=None) -> dict:
    """Bedrock cost per 1M output tokens at the measured input:output ratio.

    Exact-key catalog lookup only (no name similarity). Returns
    {bedrock_model_id, bedrock_cost_per_1m_tokens, reason, input_usd_per_1m,
    output_usd_per_1m, source, as_of, ratio}; on any gap the cost is None and
    reason explains it ("no Bedrock equivalent (<reason>)" when rendered).
    """
    out = {'bedrock_model_id': None, 'bedrock_cost_per_1m_tokens': None, 'reason': None,
           'input_usd_per_1m': None, 'output_usd_per_1m': None, 'source': None, 'as_of': None,
           'ratio': None}
    if adapter_name:
        out['reason'] = 'adapter run'
        return out
    catalog = load_bedrock_catalog() if catalog is None else catalog
    entry = catalog.get(model_name) if model_name else None
    if not isinstance(entry, dict) or not entry.get('bedrockModelId'):
        out['reason'] = 'no verified mapping'
        return out
    if region not in (entry.get('verifiedRegions') or []):
        out['reason'] = f'not verified as on-demand in {region}'
        return out
    try:
        isl = float(input_seq_len_avg)
        osl = float(output_seq_len_avg)
    except (TypeError, ValueError):
        out['reason'] = 'measured sequence lengths unknown'
        return out
    if osl <= 0 or isl < 0:
        out['reason'] = 'measured sequence lengths unknown'
        return out
    resolver = price_resolver or resolve_bedrock_prices
    prices = resolver(entry.get('priceListModel'), region)
    if prices.get('input_usd_per_1m') is None or prices.get('output_usd_per_1m') is None:
        out['reason'] = f'no on-demand price in {region}: {prices.get("reason")}'
        return out
    ratio = isl / osl
    out.update({
        'bedrock_model_id': entry['bedrockModelId'],
        'bedrock_cost_per_1m_tokens': round(prices['output_usd_per_1m'] + prices['input_usd_per_1m'] * ratio, 4),
        'input_usd_per_1m': prices['input_usd_per_1m'],
        'output_usd_per_1m': prices['output_usd_per_1m'],
        'source': prices.get('source'),
        'as_of': prices.get('as_of'),
        'ratio': round(ratio, 4),
    })
    return out


# ── Formatting (R8.4 / R8.5 / R9.4) ───────────────────────────────────────────


def _concurrency_label(concurrency) -> str:
    try:
        return f'@ concurrency {int(concurrency)} (measured)'
    except (TypeError, ValueError):
        return '@ concurrency ? (measured)'


def _date(as_of) -> str:
    return str(as_of)[:10] if as_of else 'unknown date'


def format_cost_line(cost, concurrency, *, instance_type=None, instance_count=None,
                     component=None, usd_per_hour=None, price_source=None, price_as_of=None,
                     reason=None, peak=False) -> str:
    """One cost line: "$12.10 / 1M output tokens @ concurrency 2 (measured) ·
    ml.g7.12xlarge ×1 Cluster $8.9104/h, pricing-api 2026-10-26"."""
    label = _concurrency_label(concurrency)
    tag = ' — peak sustained in this sweep' if peak else ''
    if cost is None:
        return f'cost: n/a {label}{tag} ({reason or "price or throughput unavailable"})'
    count = f' ×{instance_count}' if instance_count is not None else ''
    rate = f' ${usd_per_hour:.4f}/h' if isinstance(usd_per_hour, (int, float)) else ''
    src = f', {price_source} {_date(price_as_of)}' if price_source else ''
    return (f'${cost:,.2f} / 1M output tokens {label}{tag} · '
            f'{instance_type or "?"}{count} {component or ""}{rate}{src}').rstrip()


def format_bedrock_line(result: dict, concurrency) -> str:
    label = _concurrency_label(concurrency)
    if not result or result.get('bedrock_cost_per_1m_tokens') is None:
        return f'Bedrock: no Bedrock equivalent ({(result or {}).get("reason") or "unknown"})'
    return (f'Bedrock {result["bedrock_model_id"]}: ${result["bedrock_cost_per_1m_tokens"]:,.4f} '
            f'/ 1M output tokens {label} at measured input:output {result["ratio"]} · '
            f'in ${result["input_usd_per_1m"]:.4f}/1M, out ${result["output_usd_per_1m"]:.4f}/1M, '
            f'{result.get("source")} {_date(result.get("as_of"))}')


def peak_sustained(records: list) -> dict | None:
    """The record with the highest output tokens/s (R8.4), or None when < 2."""
    if not records or len(records) < 2:
        return None
    best = None
    for r in records:
        try:
            tps = float(r.get('output_token_throughput_tps') or 0)
        except (TypeError, ValueError):
            continue
        if best is None or tps > float(best.get('output_token_throughput_tps') or 0):
            best = r
    return best


def cost_summary_lines(records: list) -> list:
    """Human summary for a write: one line per level, the peak-sustained line
    when the write covers >= 2 levels, the Bedrock line(s) and the caveat."""
    lines = []

    def _line(r, peak=False):
        return format_cost_line(
            r.get('cost_per_1m_tokens'), r.get('concurrency'), instance_type=r.get('instance_type'),
            instance_count=r.get('instance_count'), component=r.get('price_component'),
            usd_per_hour=r.get('price_usd_per_hour'), price_source=r.get('price_source'),
            price_as_of=r.get('price_as_of'), reason=r.get('_cost_reason'), peak=peak)

    for r in records:
        lines.append(_line(r))
        if r.get('_bedrock') is not None:
            lines.append('  ' + format_bedrock_line(r['_bedrock'], r.get('concurrency')))
    best = peak_sustained(records)
    if best is not None:
        lines.append(_line(best, peak=True))
    lines.append(COST_CAVEAT)
    stz = scale_to_zero_caveat()
    if stz:
        lines.append(stz)
    return lines


def scale_to_zero_caveat(target: str | None = None, scale_to_zero: str | None = None) -> str:
    """Wave 10 (ADR-014 R6.1): when SCALE_TO_ZERO=true for an enabled target,
    the trade-off line that follows COST_CAVEAT (savings only on idle stretches
    longer than the scale-in delay; each wake costs the reference cold start).
    Target and opt-in default to the do/config environment. '' otherwise, and
    on any error (the cost lines never fail a benchmark write)."""
    try:
        import scale_to_zero as _stz
        return _stz.cost_caveat(
            target if target is not None else os.environ.get('DEPLOYMENT_TARGET'),
            scale_to_zero if scale_to_zero is not None else os.environ.get('SCALE_TO_ZERO'))
    except Exception:  # noqa: BLE001 - advisory line only
        return ''


# ── Snapshot + verify-bedrock (live, read-only) ───────────────────────────────


def _catalog_gpu_instances(instances_path: str) -> list:
    data = _load_json(instances_path)
    catalog = data.get('catalog') or {}
    return sorted(k for k, v in catalog.items() if isinstance(v, dict) and (v.get('gpus') or 0) > 0)


def _catalog_regions(regions_path: str) -> list:
    try:
        with open(regions_path, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []
    return [r['code'] for r in data if isinstance(r, dict) and r.get('code')]


def _descriptor_specs(targets_dir: str | None = None) -> list:
    """Distinct (service, component) pairs declared by the target descriptors."""
    import target_manifest

    seen = []
    for t in target_manifest.list_targets(targets_dir):
        spec = target_manifest.pricing(t, targets_dir)
        pair = (spec.get('service'), spec.get('component'))
        if pair[0] and pair not in seen:
            seen.append(pair)
    return seen


def build_snapshot(*, instances: list, regions: list, specs: list, bedrock_catalog: dict,
                   client=None, now: datetime | None = None, log=None) -> dict:
    """Query the live Price List API and return the snapshot document.

    SageMaker: one paginated query per (region, component) and the catalog GPU
    instances picked from it. EC2: one query per (region, instance). Bedrock:
    every mapped model x verified region x {input, output}. Entries that do not
    parse to exactly one price are omitted (counted in ``misses``).
    """
    client = _pricing_client(client)
    now = now or _now_utc()
    as_of = _iso(now)
    entries = {}
    misses = 0
    log = log or (lambda msg: None)

    for service, component in specs:
        for region in regions:
            if service == 'AmazonSageMaker':
                filters = [{'Type': 'TERM_MATCH', 'Field': 'regionCode', 'Value': region},
                           {'Type': 'TERM_MATCH', 'Field': 'component', 'Value': component}]
                try:
                    products = _get_products(client, service, filters)
                except Exception as exc:
                    log(f'{service}/{component}/{region}: {_api_error_reason(exc)}')
                    continue
                by_instance = {}
                for item in products:
                    p = json.loads(item) if isinstance(item, str) else item
                    name = ((p.get('product') or {}).get('attributes') or {}).get('instanceName')
                    if name:
                        by_instance.setdefault(name, []).append(p)
                for inst in instances:
                    if inst not in by_instance:
                        continue
                    try:
                        usd, unit = parse_single_price(by_instance[inst], _HOURLY_UNITS)
                    except PriceMiss:
                        misses += 1
                        continue
                    entries[instance_cache_key(service, component, inst, region)] = {
                        'usd': usd, 'unit': unit, 'as_of': as_of, 'source': SOURCE_API}
            else:
                spec = {'service': service, 'component': component}
                for inst in instances:
                    _svc, filters = build_instance_filters(inst, region, spec)
                    try:
                        usd, unit = parse_single_price(_get_products(client, service, filters), _HOURLY_UNITS)
                    except PriceMiss:
                        misses += 1
                        continue
                    except Exception as exc:
                        log(f'{service}/{region}/{inst}: {_api_error_reason(exc)}')
                        continue
                    entries[instance_cache_key(service, component, inst, region)] = {
                        'usd': usd, 'unit': unit, 'as_of': as_of, 'source': SOURCE_API}
            log(f'{service}/{component or "-"}/{region}: {len(entries)} entries so far')

    for _hf_id, entry in sorted((bedrock_catalog or {}).items()):
        model = entry.get('priceListModel')
        for region in entry.get('verifiedRegions') or []:
            for token_type in ('input', 'output'):
                try:
                    usd, unit = parse_single_price(
                        _get_products(client, BEDROCK_SERVICE, build_bedrock_filters(model, region, token_type)),
                        _TOKEN_UNITS_PER_1M)
                except PriceMiss:
                    misses += 1
                    continue
                except Exception as exc:
                    log(f'{BEDROCK_SERVICE}/{model}/{region}: {_api_error_reason(exc)}')
                    continue
                entries[bedrock_cache_key(model, region, token_type)] = {
                    'usd': usd, 'unit': 'USD per 1M tokens', 'as_of': as_of, 'source': SOURCE_API}

    return {
        'generatedAt': as_of,
        'source': SNAPSHOT_SOURCE_LABEL,
        'pricingEndpointRegion': PRICING_API_REGION,
        'generatedBy': 'templates/do/lib/python/pricing.py snapshot',
        'misses': misses,
        'entries': dict(sorted(entries.items())),
    }


# One ListFoundationModels response per region per process (verify-bedrock --batch).
_LISTING_CACHE: dict = {}


def verify_bedrock(hf_id: str, bedrock_model_id: str, price_list_model: str, *, regions: list,
                   bedrock_client_factory=None, price_resolver=None, now: datetime | None = None,
                   log=None) -> dict:
    """Verify a mapping against live bedrock:ListFoundationModels per region.

    Records the regions where ``bedrock_model_id`` is listed with ON_DEMAND in
    inferenceTypesSupported. Rejects (PriceMiss) when no region qualifies or the
    Price List model has no on-demand price in any verified region.
    """
    log = log or (lambda msg: None)
    if bedrock_client_factory is None:
        import boto3
        from botocore.config import Config

        def bedrock_client_factory(region):
            return boto3.client('bedrock', region_name=region, config=Config(
                connect_timeout=5, read_timeout=20, retries={'max_attempts': 2}))

    if not regions:
        raise PriceMiss('no regions to check (regions.json not found?)')
    verified = []
    for region in regions:
        if region not in _LISTING_CACHE:
            try:
                _LISTING_CACHE[region] = bedrock_client_factory(region).list_foundation_models()
            except Exception as exc:
                log(f'{region}: ListFoundationModels unavailable ({type(exc).__name__})')
                _LISTING_CACHE[region] = None
        resp = _LISTING_CACHE[region]
        if resp is None:
            continue
        for summary in resp.get('modelSummaries', []) or []:
            if summary.get('modelId') == bedrock_model_id and \
                    'ON_DEMAND' in (summary.get('inferenceTypesSupported') or []):
                verified.append(region)
                break
    if not verified:
        raise PriceMiss(f'{bedrock_model_id} is not listed ON_DEMAND in any checked region')
    resolver = price_resolver or (lambda m, r: resolve_bedrock_prices(m, r, allow_api=True))
    priced = [r for r in verified if resolver(price_list_model, r).get('input_usd_per_1m') is not None]
    if not priced:
        raise PriceMiss(f'Price List model {price_list_model!r} has no on-demand price in {verified}')
    return {
        'bedrockModelId': bedrock_model_id,
        'priceListModel': price_list_model,
        'verifiedAt': _iso(now or _now_utc()),
        'verifiedRegions': sorted(verified),
        'pricedRegions': sorted(priced),
        'verifiedBy': 'pricing.py verify-bedrock (bedrock:ListFoundationModels, ON_DEMAND)',
    }


# ── CLI ───────────────────────────────────────────────────────────────────────


def _cli(argv=None) -> int:
    repo_catalogs = _source_catalogs_dir()
    parser = argparse.ArgumentParser(prog='pricing.py', description=__doc__.split('\n\n')[0])
    sub = parser.add_subparsers(dest='command', required=True)

    p = sub.add_parser('resolve', help='Resolve one instance-hour price')
    p.add_argument('--instance', required=True)
    p.add_argument('--region', required=True)
    p.add_argument('--target', required=True)
    p.add_argument('--no-api', action='store_true')

    p = sub.add_parser('bedrock-prices', help='Resolve Bedrock on-demand token prices')
    p.add_argument('--model', required=True, help='Price List model attribute (e.g. "Gemma 3 12B")')
    p.add_argument('--region', required=True)
    p.add_argument('--no-api', action='store_true')

    p = sub.add_parser('snapshot', help='Regenerate the pricing snapshot from the live API')
    p.add_argument('--out', default=os.path.join(repo_catalogs, SNAPSHOT_FILENAME))
    p.add_argument('--instances', default=os.path.join(repo_catalogs, 'instances.json'))
    p.add_argument('--regions-file', default=os.path.join(repo_catalogs, 'regions.json'))
    p.add_argument('--regions', default='', help='Comma list overriding regions.json')
    p.add_argument('--bedrock-catalog', default=os.path.join(repo_catalogs, BEDROCK_CATALOG_FILENAME))

    p = sub.add_parser('verify-bedrock', help='Add a Bedrock mapping verified against live ListFoundationModels')
    p.add_argument('hf_id', nargs='?')
    p.add_argument('bedrock_model_id', nargs='?')
    p.add_argument('--price-list-model', default='')
    p.add_argument('--batch', default='', help='File of "hf_id|bedrock_model_id|price list model" lines')
    p.add_argument('--catalog', default=os.path.join(repo_catalogs, BEDROCK_CATALOG_FILENAME))
    p.add_argument('--regions-file', default=os.path.join(repo_catalogs, 'regions.json'))
    p.add_argument('--regions', default='')

    args = parser.parse_args(argv)

    if args.command == 'resolve':
        print(json.dumps(resolve_instance_price(
            args.instance, args.region, args.target, cache_path=default_cache_path(),
            snapshot_path=default_snapshot_path(), allow_api=not args.no_api), indent=2))
        return 0
    if args.command == 'bedrock-prices':
        print(json.dumps(resolve_bedrock_prices(
            args.model, args.region, cache_path=default_cache_path(),
            snapshot_path=default_snapshot_path(), allow_api=not args.no_api), indent=2))
        return 0

    def _log(msg):
        print(f'  {msg}', file=sys.stderr)

    if args.command == 'snapshot':
        regions = [r for r in args.regions.split(',') if r] or _catalog_regions(args.regions_file)
        if not regions:
            print(f'❌ no regions (looked in {args.regions_file})', file=sys.stderr)
            return 2
        doc = build_snapshot(
            instances=_catalog_gpu_instances(args.instances), regions=regions,
            specs=_descriptor_specs(), bedrock_catalog=load_bedrock_catalog(args.bedrock_catalog), log=_log)
        _atomic_write_json(args.out, doc)
        print(json.dumps({'out': args.out, 'entries': len(doc['entries']), 'misses': doc['misses'],
                          'generatedAt': doc['generatedAt']}))
        return 0
    if args.command == 'verify-bedrock':
        regions = [r for r in args.regions.split(',') if r] or _catalog_regions(args.regions_file)
        mappings = []
        if args.batch:
            with open(args.batch, encoding='utf-8') as f:
                for line in f:
                    parts = [x.strip() for x in line.split('|')]
                    if len(parts) == 3 and all(parts) and not parts[0].startswith('#'):
                        mappings.append(tuple(parts))
        elif args.hf_id and args.bedrock_model_id and args.price_list_model:
            mappings.append((args.hf_id, args.bedrock_model_id, args.price_list_model))
        else:
            print('usage: verify-bedrock <hf_id> <bedrock_model_id> --price-list-model NAME | --batch FILE',
                  file=sys.stderr)
            return 2
        rc = 0
        for hf_id, bedrock_id, pl_model in mappings:
            try:
                entry = verify_bedrock(hf_id, bedrock_id, pl_model, regions=regions, log=_log)
            except PriceMiss as exc:
                print(f'❌ {hf_id}: rejected: {exc}', file=sys.stderr)
                rc = 1
                continue
            doc = _load_json(args.catalog)
            doc.setdefault('description', 'HF model id -> Bedrock model id. Entries are written ONLY by '
                           'pricing.py verify-bedrock after a live bedrock:ListFoundationModels check; '
                           'never inferred by name similarity (Wave 9 R9.1).')
            doc.setdefault('models', {})[hf_id] = entry
            doc['models'] = dict(sorted(doc['models'].items()))
            _atomic_write_json(args.catalog, doc)
            print(json.dumps({hf_id: entry}))
        return rc
    return 2


if __name__ == '__main__':
    sys.exit(_cli())
