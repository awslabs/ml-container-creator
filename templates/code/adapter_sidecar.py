#!/usr/bin/env python3
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""
Adapter Sidecar — SageMaker AI adapter contract implementation.

Lightweight aiohttp HTTP server that sits between SageMaker (port 8080) and the
model server (port 8081). Implements POST /adapters and DELETE /adapters by
translating them into the model server's native LoRA API, while proxying all
other traffic transparently.

Configuration (environment variables):
    MODEL_SERVER_PORT  - Internal model server port (default: 8081)
    MODEL_SERVER_TYPE  - Model server type: vllm or sglang (default: vllm)
    SIDECAR_PORT       - Port sidecar listens on (default: 8080)
    MAX_LORAS          - Maximum concurrent adapters (default: 64)
    HEALTH_POLL_INTERVAL - Seconds between health polls (default: 2)
    HEALTH_TIMEOUT     - Seconds to wait for model server readiness (default: 600)
    ADAPTER_ALLOWED_ROOTS - os.pathsep-separated list of absolute directories
                         that adapter `src` paths must resolve inside, after
                         symlinks are followed (default: /opt/ml, where SageMaker
                         stages model and adapter artifacts). Relative entries are
                         ignored; if no valid root remains, every load is refused.
    ADAPTER_MAX_EXTRACT_BYTES - Upper bound on the total uncompressed size of an
                         adapter tar.gz archive (default: 21474836480 = 20 GiB).
    ADAPTER_MAX_EXTRACT_MEMBERS - Upper bound on the number of entries in an
                         adapter tar.gz archive (default: 10000).

Security model:
    - Adapter mutations are only accepted through POST/DELETE /adapters. The
      model server's own adapter-mutation endpoints
      (MODEL_SERVER_ADAPTER_MUTATION_PATHS) are refused by the catch-all proxy
      with HTTP 403.
    - `src` must canonicalize into one of ADAPTER_ALLOWED_ROOTS, and every
      artifact-resolution failure returns the same generic client error; the
      detailed reason is written to the server-side stderr log only.
    - tar.gz archives are validated member by member before anything is
      extracted (regular files and directories only, no absolute or `..`
      paths, no links/devices/fifos, nothing escaping the extraction dir).
"""

import asyncio
import os
import posixpath
import re
import tarfile
import time
import zlib
from datetime import datetime, timezone
from urllib.parse import unquote

from aiohttp import web, ClientSession, ClientTimeout


# ── Configuration ─────────────────────────────────────────────────────────────

MODEL_SERVER_PORT = int(os.environ.get('MODEL_SERVER_PORT', '8081'))
MODEL_SERVER_TYPE = os.environ.get('MODEL_SERVER_TYPE', 'vllm')
SIDECAR_PORT = int(os.environ.get('SIDECAR_PORT', '8080'))
MAX_LORAS = int(os.environ.get('MAX_LORAS', '64'))
HEALTH_POLL_INTERVAL = int(os.environ.get('HEALTH_POLL_INTERVAL', '2'))
HEALTH_TIMEOUT = int(os.environ.get('HEALTH_TIMEOUT', '600'))

MODEL_SERVER_BASE = f'http://localhost:{MODEL_SERVER_PORT}'


def _parse_allowed_roots(value):
    """Parse ADAPTER_ALLOWED_ROOTS into a tuple of canonical absolute dirs."""
    roots = []
    for entry in (value or '').split(os.pathsep):
        entry = entry.strip()
        if not entry or '\x00' in entry or not os.path.isabs(entry):
            continue
        roots.append(os.path.realpath(entry))
    return tuple(roots)


ADAPTER_ALLOWED_ROOTS = _parse_allowed_roots(os.environ.get('ADAPTER_ALLOWED_ROOTS', '/opt/ml'))
ADAPTER_MAX_EXTRACT_BYTES = int(os.environ.get('ADAPTER_MAX_EXTRACT_BYTES', str(20 * 1024 ** 3)))
ADAPTER_MAX_EXTRACT_MEMBERS = int(os.environ.get('ADAPTER_MAX_EXTRACT_MEMBERS', '10000'))

# Adapter names are passed to the model server as identifiers and appear in logs.
ADAPTER_NAME_PATTERN = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}')

# The single message returned to clients for any artifact-resolution failure.
# Distinct messages would let a caller probe the container filesystem.
ADAPTER_ARTIFACT_ERROR = 'Adapter artifacts not found or not usable'

# Model-server endpoints that mutate the set of loaded adapters, per server
# type. The sidecar's /adapters routes are the only supported way to load or
# unload adapters (they enforce MAX_LORAS and ArtifactResolver confinement), so
# the catch-all proxy refuses these paths. The union across all server types is
# blocked so a mislabelled MODEL_SERVER_TYPE cannot reopen the bypass.
MODEL_SERVER_ADAPTER_MUTATION_PATHS = {
    'vllm': ('/v1/load_lora_adapter', '/v1/unload_lora_adapter'),
    'sglang': ('/load_lora_adapter', '/unload_lora_adapter'),
}
BLOCKED_PROXY_PATHS = frozenset(
    path.lower()
    for paths in MODEL_SERVER_ADAPTER_MUTATION_PATHS.values()
    for path in paths
)


# ── Logging ───────────────────────────────────────────────────────────────────

def log(message, stream='stdout'):
    """Emit a log message with ISO 8601 timestamp and [adapter-sidecar] prefix."""
    ts = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    line = f'{ts} [adapter-sidecar] {message}'
    if stream == 'stderr':
        import sys
        print(line, file=sys.stderr)
    else:
        print(line)


# ── Artifact Resolution ───────────────────────────────────────────────────────

class AdapterArtifactError(FileNotFoundError):
    """Raised for every adapter artifact resolution failure.

    str(error) is always the generic ADAPTER_ARTIFACT_ERROR so it is safe to
    return to clients; the specific reason is kept in `detail` for server-side
    logging only.
    """

    def __init__(self, detail):
        super().__init__(ADAPTER_ARTIFACT_ERROR)
        self.detail = detail

    def __str__(self):
        return ADAPTER_ARTIFACT_ERROR


def _is_within(root, candidate):
    """True if canonical `candidate` equals or is inside canonical `root`."""
    try:
        return os.path.commonpath([root, candidate]) == root
    except ValueError:
        return False


def _confine(path, allowed_roots):
    """Canonicalize `path` (following symlinks) and require it to be inside an allowed root.

    Returns the canonical path. Raises AdapterArtifactError otherwise.
    """
    candidate = os.path.realpath(path)
    for root in allowed_roots:
        if _is_within(root, candidate):
            return candidate
    raise AdapterArtifactError(f'path resolves outside ADAPTER_ALLOWED_ROOTS: {path!r} -> {candidate!r}')


class ArtifactResolver:
    """Resolves adapter artifacts from a source path.

    Handles three cases:
    1. Path contains a single tar.gz file — extract in place, return directory
    2. Path contains adapter_config.json — use directory directly
    3. Path does not exist or is empty — raise AdapterArtifactError

    Every path (src, the tar file inside it, and the extraction directory) must
    canonicalize into one of ADAPTER_ALLOWED_ROOTS.
    """

    @staticmethod
    def resolve(src, allowed_roots=None):
        """Resolve the adapter artifact path.

        Args:
            src: Absolute filesystem path where SageMaker placed adapter artifacts.
            allowed_roots: Canonical directories src must resolve into
                (default: ADAPTER_ALLOWED_ROOTS).

        Returns:
            Canonical directory path containing adapter files.

        Raises:
            AdapterArtifactError: For any failure (outside the allowed roots,
                missing, not a directory, empty, no recognizable artifacts,
                unsafe or corrupt archive). str() is always generic.
        """
        roots = ADAPTER_ALLOWED_ROOTS if allowed_roots is None else allowed_roots

        if not isinstance(src, str) or not src:
            raise AdapterArtifactError('src is empty')
        if '\x00' in src:
            raise AdapterArtifactError('src contains a NUL byte')
        if not os.path.isabs(src):
            raise AdapterArtifactError(f'src is not an absolute path: {src!r}')

        candidate = _confine(src, roots)

        if not os.path.exists(candidate):
            raise AdapterArtifactError(f'path does not exist: {candidate!r}')

        # If src is a file (direct tar.gz path), extract it next to itself
        if os.path.isfile(candidate):
            if not candidate.endswith('.tar.gz'):
                raise AdapterArtifactError(f'path is a file but not a .tar.gz archive: {candidate!r}')
            extract_dir = _confine(os.path.dirname(candidate), roots)
            ArtifactResolver._extract_or_reject(candidate, extract_dir)
            return extract_dir

        if not os.path.isdir(candidate):
            raise AdapterArtifactError(f'path is not a directory: {candidate!r}')

        try:
            contents = os.listdir(candidate)
        except OSError as e:
            raise AdapterArtifactError(f'cannot list directory {candidate!r}: {e}')
        if not contents:
            raise AdapterArtifactError(f'directory is empty: {candidate!r}')

        # Directory already contains extracted adapter files
        if 'adapter_config.json' in contents:
            return candidate

        # Directory contains a single tar.gz file
        tar_files = [f for f in contents if f.endswith('.tar.gz')]
        if len(tar_files) == 1:
            tar_path = _confine(os.path.join(candidate, tar_files[0]), roots)
            if not os.path.isfile(tar_path):
                raise AdapterArtifactError(f'archive is not a regular file: {tar_path!r}')
            ArtifactResolver._extract_or_reject(tar_path, candidate)
            return candidate

        raise AdapterArtifactError(
            f'directory has no adapter_config.json and not exactly one .tar.gz: {candidate!r}'
        )

    @staticmethod
    def _extract_or_reject(tar_path, extract_dir):
        """Extract, converting any extraction failure into AdapterArtifactError."""
        try:
            ArtifactResolver._extract_tar_gz(tar_path, extract_dir)
        except RuntimeError as e:
            raise AdapterArtifactError(str(e))

    @staticmethod
    def _validate_members(tar, extract_dir):
        """Return the archive's members if all are safe; raise RuntimeError otherwise.

        Rejects the whole archive when any member is absolute, contains a '..'
        component, is anything other than a regular file or directory (symlink,
        hardlink, device, fifo, ...), or would land outside extract_dir. Also
        enforces ADAPTER_MAX_EXTRACT_MEMBERS and ADAPTER_MAX_EXTRACT_BYTES.
        """
        members = []
        total_bytes = 0
        for member in tar:
            members.append(member)
            if len(members) > ADAPTER_MAX_EXTRACT_MEMBERS:
                raise RuntimeError(f'archive has more than {ADAPTER_MAX_EXTRACT_MEMBERS} members')
            name = member.name
            if '\x00' in name or name.startswith('/') or os.path.isabs(name):
                raise RuntimeError(f'archive member has an absolute path: {name!r}')
            if '..' in name.replace('\\', '/').split('/'):
                raise RuntimeError(f'archive member contains a .. component: {name!r}')
            if not (member.isreg() or member.isdir()):
                raise RuntimeError(f'archive member is not a regular file or directory: {name!r}')
            target = os.path.realpath(os.path.join(extract_dir, name))
            if not _is_within(extract_dir, target):
                raise RuntimeError(f'archive member escapes the extraction directory: {name!r}')
            if member.isreg():
                total_bytes += member.size
                if total_bytes > ADAPTER_MAX_EXTRACT_BYTES:
                    raise RuntimeError(f'archive exceeds {ADAPTER_MAX_EXTRACT_BYTES} uncompressed bytes')
        return members

    @staticmethod
    def _extract_tar_gz(tar_path, extract_dir):
        """Safely extract a tar.gz archive to the specified directory.

        All members are validated before anything is written, on every Python
        version; filter='data' is additionally applied where available.

        Args:
            tar_path: Path to the tar.gz file.
            extract_dir: Directory to extract files into.

        Raises:
            RuntimeError: If the archive is unsafe, corrupt, or extraction fails.
        """
        extract_dir = os.path.realpath(extract_dir)
        try:
            with tarfile.open(tar_path, 'r:gz') as tar:
                members = ArtifactResolver._validate_members(tar, extract_dir)
                if hasattr(tarfile, 'data_filter'):
                    tar.extractall(path=extract_dir, members=members, filter='data')
                else:
                    tar.extractall(path=extract_dir, members=members)
        except RuntimeError:
            raise
        except (tarfile.TarError, OSError, EOFError, zlib.error) as e:
            raise RuntimeError(f'Failed to extract tar.gz archive {tar_path}: {e}')


# ── Request Validation ────────────────────────────────────────────────────────

def is_valid_adapter_name(name):
    """True if `name` is a well-formed adapter identifier."""
    return isinstance(name, str) and ADAPTER_NAME_PATTERN.fullmatch(name) is not None


def proxy_path_rejection_reason(raw_path):
    """Classify a raw request target for the catch-all proxy.

    Args:
        raw_path: The request target exactly as received (may include a query
            string and percent-encoding).

    Returns:
        None if the request may be forwarded, otherwise a short reason string
        (for server-side logs) explaining why it is refused.
    """
    path = (raw_path or '').split('?', 1)[0].split('#', 1)[0]
    if not path.startswith('/'):
        return 'request target is not an origin-form path'
    lowered = path.lower()
    if '%2f' in lowered or '%5c' in lowered or '\\' in path:
        return 'encoded slash or backslash in path'
    decoded = unquote(path)
    if unquote(decoded) != decoded:
        return 'multiply percent-encoded path'
    if '\x00' in decoded or '\\' in decoded:
        return 'NUL or backslash in decoded path'
    collapsed = re.sub('/+', '/', decoded)
    if any(segment in ('.', '..') for segment in collapsed.split('/')):
        return 'dot segment in path'
    normalized = posixpath.normpath(collapsed)
    if normalized != '/':
        normalized = normalized.rstrip('/')
    if normalized.lower() in BLOCKED_PROXY_PATHS:
        return 'model-server adapter mutation endpoint (use /adapters)'
    return None


# ── Model Server Client (Strategy Pattern) ────────────────────────────────────

class ModelServerClient:
    """Strategy interface for model server native LoRA API translation.

    Subclasses implement the specific HTTP calls for each model server type.
    """

    def __init__(self, session, base_url):
        self.session = session
        self.base_url = base_url

    async def load_adapter(self, name, path):
        """Load a LoRA adapter into the model server.

        Args:
            name: Adapter identifier.
            path: Resolved filesystem path to adapter artifacts.

        Returns:
            dict with response data from the model server.

        Raises:
            RuntimeError: If the model server returns an error or is unreachable.
        """
        raise NotImplementedError

    async def unload_adapter(self, name):
        """Unload a LoRA adapter from the model server.

        Args:
            name: Adapter identifier.

        Returns:
            dict with response data from the model server.

        Raises:
            RuntimeError: If the model server returns an error or is unreachable.
        """
        raise NotImplementedError


class VLLMClient(ModelServerClient):
    """vLLM-specific adapter API translation.

    Load: POST /v1/load_lora_adapter {"lora_name": name, "lora_path": path}
    Unload: POST /v1/unload_lora_adapter {"lora_name": name}
    """

    async def load_adapter(self, name, path):
        """Load a LoRA adapter via vLLM's native API."""
        url = f'{self.base_url}/v1/load_lora_adapter'
        payload = {'lora_name': name, 'lora_path': path}
        try:
            async with self.session.post(url, json=payload) as resp:
                body = await resp.text()
                if resp.status == 200:
                    return {'status': 'success', 'response': body}
                raise RuntimeError(f'vLLM load_lora_adapter failed (HTTP {resp.status}): {body}')
        except RuntimeError:
            raise
        except Exception as e:
            raise RuntimeError(f'Failed to connect to vLLM: {e}')

    async def unload_adapter(self, name):
        """Unload a LoRA adapter via vLLM's native API."""
        url = f'{self.base_url}/v1/unload_lora_adapter'
        payload = {'lora_name': name}
        try:
            async with self.session.post(url, json=payload) as resp:
                body = await resp.text()
                if resp.status == 200:
                    return {'status': 'success', 'response': body}
                raise RuntimeError(f'vLLM unload_lora_adapter failed (HTTP {resp.status}): {body}')
        except RuntimeError:
            raise
        except Exception as e:
            raise RuntimeError(f'Failed to connect to vLLM: {e}')


class SGLangClient(ModelServerClient):
    """SGLang-specific adapter API translation. (Deferred)

    SGLang support is deferred to a follow-up. This placeholder raises
    NotImplementedError for both load and unload operations.
    """

    async def load_adapter(self, name, path):
        """Load a LoRA adapter via SGLang's native API. (Not yet implemented)"""
        raise NotImplementedError('SGLang adapter loading is not yet implemented')

    async def unload_adapter(self, name):
        """Unload a LoRA adapter via SGLang's native API. (Not yet implemented)"""
        raise NotImplementedError('SGLang adapter unloading is not yet implemented')


def create_model_server_client(session, base_url, server_type):
    """Factory function to create the appropriate ModelServerClient.

    Args:
        session: aiohttp.ClientSession for HTTP calls.
        base_url: Model server base URL (e.g., http://localhost:8081).
        server_type: Model server type ('vllm' or 'sglang').

    Returns:
        ModelServerClient instance.
    """
    if server_type == 'vllm':
        return VLLMClient(session, base_url)
    elif server_type == 'sglang':
        return SGLangClient(session, base_url)
    else:
        raise ValueError(f'Unsupported model server type: {server_type}')


# ── State ─────────────────────────────────────────────────────────────────────

adapter_registry = {}
model_server_ready = False


# ── Health Polling (Readiness Gating) ─────────────────────────────────────────

async def poll_model_server_health(app):
    """Background task that polls the model server health endpoint.

    Sets model_server_ready to True once the health endpoint returns 200.
    After HEALTH_TIMEOUT seconds, logs a warning and sets ready to True
    to avoid indefinite blocking.
    """
    global model_server_ready
    session = app['session']
    start_time = time.monotonic()

    log(f'Starting health polling — interval={HEALTH_POLL_INTERVAL}s, timeout={HEALTH_TIMEOUT}s')

    while True:
        elapsed = time.monotonic() - start_time

        # Timeout: log warning and begin accepting requests
        if elapsed >= HEALTH_TIMEOUT:
            log(f'Health timeout reached ({HEALTH_TIMEOUT}s) — model server did not become ready. Accepting requests anyway.', stream='stderr')
            model_server_ready = True
            return

        try:
            async with session.get(f'{MODEL_SERVER_BASE}/health', timeout=ClientTimeout(total=5)) as resp:
                if resp.status == 200:
                    model_server_ready = True
                    log('Model server is ready (health endpoint returned 200)')
                    return
        except Exception:
            pass

        await asyncio.sleep(HEALTH_POLL_INTERVAL)


# ── Handlers ──────────────────────────────────────────────────────────────────

async def handle_ping(request):
    """GET /ping — readiness gating.

    Returns 503 until model server health endpoint returns 200.
    Once ready, proxies /ping to the model server.
    """
    if not model_server_ready:
        return web.Response(status=503, text='Service Unavailable')

    # Proxy to model server health endpoint
    session = request.app['session']
    try:
        async with session.get(f'{MODEL_SERVER_BASE}/health') as resp:
            body = await resp.read()
            return web.Response(status=resp.status, body=body,
                                headers={'Content-Type': resp.headers.get('Content-Type', 'text/plain')})
    except Exception as e:
        log(f'Health proxy to model server failed — error={e}', stream='stderr')
        return web.Response(status=503, text='Model server unreachable')


async def handle_adapters_post(request):
    """POST /adapters — load a LoRA adapter."""
    name = request.query.get('name')
    src = request.query.get('src')

    if not name:
        return web.json_response({'status': 'error', 'error': 'Missing required query parameter: name'}, status=400)
    if not is_valid_adapter_name(name):
        return web.json_response({'status': 'error', 'error': 'Invalid adapter name'}, status=400)
    if not src:
        return web.json_response({'status': 'error', 'error': 'Missing required query parameter: src'}, status=400)

    # Check MAX_LORAS limit before any filesystem work. Re-loading a name that is
    # already registered replaces it and does not consume an extra slot.
    if name not in adapter_registry and len(adapter_registry) >= MAX_LORAS:
        return web.json_response(
            {'status': 'error', 'adapter': name, 'error': f'Maximum concurrent adapters ({MAX_LORAS}) reached'},
            status=507
        )

    # Resolve adapter artifacts. Every failure maps to one generic client error;
    # the specific reason goes to the server-side log only.
    try:
        resolved_path = ArtifactResolver.resolve(src)
    except AdapterArtifactError as e:
        log(f'Adapter artifact resolution failed — name={name}, src={src!r}, reason={e.detail}', stream='stderr')
        return web.json_response({'status': 'error', 'adapter': name, 'error': ADAPTER_ARTIFACT_ERROR}, status=404)

    # Call model server native LoRA API
    client = request.app['model_server_client']
    try:
        await client.load_adapter(name, resolved_path)
    except (RuntimeError, NotImplementedError) as e:
        log(f'Adapter load failed — name={name}, src={src!r}, error={e}', stream='stderr')
        return web.json_response(
            {'status': 'error', 'adapter': name, 'error': 'Model server failed to load adapter'}, status=500
        )

    # Register adapter and respond. The resolved filesystem path is logged but
    # not returned: SageMaker only needs the status, and echoing it would leak
    # container layout to the caller.
    adapter_registry[name] = resolved_path
    log(f'Adapter loaded — name={name}, src={src!r}, resolved_path={resolved_path}')
    return web.json_response({'status': 'loaded', 'adapter': name})


async def handle_adapters_delete(request):
    """DELETE /adapters — unload a LoRA adapter."""
    name = request.query.get('name')

    if not name:
        return web.json_response({'status': 'error', 'error': 'Missing required query parameter: name'}, status=400)
    if not is_valid_adapter_name(name):
        return web.json_response({'status': 'error', 'error': 'Invalid adapter name'}, status=400)

    # Call model server native LoRA API
    client = request.app['model_server_client']
    try:
        await client.unload_adapter(name)
    except (RuntimeError, NotImplementedError) as e:
        log(f'Adapter unload failed — name={name}, error={e}', stream='stderr')
        return web.json_response(
            {'status': 'error', 'adapter': name, 'error': 'Model server failed to unload adapter'}, status=500
        )

    # Remove from registry and respond
    adapter_registry.pop(name, None)
    log(f'Adapter unloaded — name={name}')
    return web.json_response({'status': 'unloaded', 'adapter': name})


async def handle_proxy(request):
    """Proxy all non-/adapters requests to the model server transparently.

    Requests targeting the model server's adapter-mutation API (see
    BLOCKED_PROXY_PATHS), or using ambiguous path encodings, are refused with
    HTTP 403 and never forwarded.
    """
    reason = proxy_path_rejection_reason(request.raw_path)
    if reason is not None:
        log(f'Proxy request refused — method={request.method}, path={request.raw_path!r}, reason={reason}',
            stream='stderr')
        return web.json_response({'status': 'error', 'error': 'Forbidden'}, status=403)

    session = request.app['session']
    target_url = f'{MODEL_SERVER_BASE}{request.path_qs}'

    try:
        body = await request.read()
        async with session.request(
            method=request.method,
            url=target_url,
            headers={k: v for k, v in request.headers.items() if k.lower() != 'host'},
            data=body if body else None
        ) as resp:
            resp_body = await resp.read()
            response_headers = {k: v for k, v in resp.headers.items()
                                if k.lower() not in ('transfer-encoding', 'content-encoding', 'content-length')}
            return web.Response(status=resp.status, body=resp_body, headers=response_headers)
    except Exception as e:
        log(f'Proxy to model server failed — method={request.method}, path={request.raw_path!r}, error={e}',
            stream='stderr')
        return web.json_response({'status': 'error', 'error': 'Model server unreachable'}, status=500)


# ── Application Setup ─────────────────────────────────────────────────────────

async def on_startup(app):
    """Create HTTP session, model server client, and start health polling background task."""
    app['session'] = ClientSession()
    app['model_server_client'] = create_model_server_client(app['session'], MODEL_SERVER_BASE, MODEL_SERVER_TYPE)
    app['health_task'] = asyncio.create_task(poll_model_server_health(app))
    log(f'Sidecar started — port={SIDECAR_PORT}, model_server_port={MODEL_SERVER_PORT}, '
        f'model_server_type={MODEL_SERVER_TYPE}, max_loras={MAX_LORAS}')


async def on_cleanup(app):
    """Cleanup HTTP session and cancel background tasks."""
    app['health_task'].cancel()
    try:
        await app['health_task']
    except asyncio.CancelledError:
        pass
    await app['session'].close()


def create_app():
    """Create and configure the aiohttp application."""
    app = web.Application()

    # Register routes
    app.router.add_get('/ping', handle_ping)
    app.router.add_post('/adapters', handle_adapters_post)
    app.router.add_delete('/adapters', handle_adapters_delete)

    # Catch-all proxy for everything else
    app.router.add_route('*', '/{path:.*}', handle_proxy)

    # Lifecycle hooks
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    return app


if __name__ == '__main__':
    app = create_app()
    web.run_app(app, host='0.0.0.0', port=SIDECAR_PORT, print=None)
