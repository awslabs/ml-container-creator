"""Unit tests for register_evaluator (BL117 native AI Registry evaluators).

All offline: the sagemaker.ai_registry SDK and the role/domain resolution are
mocked, so behavior — not any AWS state — is asserted.

Validates: Req 1.1/1.2 (REWARD_FUNCTION ARN path), Req 1.3 (name budget),
Req 2.1 (REWARD_PROMPT), Req 1.5/7 (region/SDK skip is a clear not-supported).
"""
import sys
import types

import pytest

import register_evaluator as re_mod


# ── name budget (Req 1.3) ──────────────────────────────────────────────────────

class TestNameBudget:
    def test_short_name_ok(self):
        ok, reason = re_mod.check_name_budget("math-reward")
        assert ok is True
        assert reason == ""

    def test_long_name_rejected_with_reason(self):
        ok, reason = re_mod.check_name_budget("x" * 40)
        assert ok is False
        assert "64-char" in reason or "too long" in reason

    def test_budget_is_derived_not_hardcoded(self):
        # The budget is derived from the Lambda prefix + timestamp reserve.
        name_at_budget = "x" * re_mod.EVALUATOR_NAME_BUDGET
        assert re_mod.check_name_budget(name_at_budget)[0] is True
        assert re_mod.check_name_budget(name_at_budget + "x")[0] is False


# ── native create: fake SDK (both types) ───────────────────────────────────────

def _install_fake_evaluator_sdk(created):
    """Install fake sagemaker.ai_registry.{air_constants,evaluator} modules."""
    air = types.ModuleType("sagemaker.ai_registry.air_constants")
    air.REWARD_FUNCTION = "REWARD_FUNCTION"
    air.REWARD_PROMPT = "REWARD_PROMPT"

    ev_mod = types.ModuleType("sagemaker.ai_registry.evaluator")

    class Evaluator:
        def __init__(self, **kw):
            self.arn = "arn:aws:sagemaker:us-west-2:1:hub-content/H/JsonDoc/x/1.0.0"
            self.version = "1.0.0"
            self.status = "Available"
            self.type = ("RewardPrompt" if kw.get("type") == "REWARD_PROMPT"
                         else "RewardFunction")
            self.reference = kw.get("source")

        @staticmethod
        def create(**kwargs):
            created.update(kwargs)
            return Evaluator(**kwargs)

    ev_mod.Evaluator = Evaluator

    saved = {k: sys.modules.get(k) for k in (
        "sagemaker", "sagemaker.ai_registry",
        "sagemaker.ai_registry.air_constants", "sagemaker.ai_registry.evaluator",
    )}
    sys.modules["sagemaker"] = sys.modules.get("sagemaker") or types.ModuleType("sagemaker")
    sys.modules["sagemaker.ai_registry"] = types.ModuleType("sagemaker.ai_registry")
    sys.modules["sagemaker.ai_registry.air_constants"] = air
    sys.modules["sagemaker.ai_registry.evaluator"] = ev_mod

    def cleanup():
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v

    return cleanup


class TestDeployRewardLambda:
    """The MLCC-owned --finalize deploy: stage code into the REUSED training bucket,
    zip the file AS lambda_function.py (so lambda_function.lambda_handler resolves),
    create the Lambda with the dual-trust role, return its ARN. Fixes the SDK path's
    NoSuchBucket + handler-mismatch + role breakages. All offline (fake boto3)."""

    def _install_fake_boto3(self, monkeypatch, captured):
        class _ResourceConflict(Exception):
            pass

        class _LambdaClient:
            exceptions = types.SimpleNamespace(ResourceConflictException=_ResourceConflict)

            def create_function(self, **kw):
                captured["create"] = kw
                return {"FunctionArn": f"arn:aws:lambda:us-west-2:1:function:{kw['FunctionName']}"}

        class _S3Client:
            def upload_file(self, local, bucket, key):
                captured["s3"] = {"local": local, "bucket": bucket, "key": key}

        class _StsClient:
            def get_caller_identity(self):
                return {"Account": "111122223333"}

        def _client(svc, region_name=None):
            return {"lambda": _LambdaClient(), "s3": _S3Client(),
                    "sts": _StsClient()}[svc]

        fake = types.ModuleType("boto3")
        fake.client = _client
        monkeypatch.setitem(sys.modules, "boto3", fake)

    def test_deploy_uses_core_evaluators_prefix_handler_and_role(self, monkeypatch, tmp_path):
        # Bucket consolidation R3.9: the backup goes to the CORE bucket under
        # evaluators/<name>/ (key from s3_layout), not the frozen training bucket.
        captured = {}
        self._install_fake_boto3(monkeypatch, captured)
        monkeypatch.setenv("CORE_S3_BUCKET", "zz-core-x")
        monkeypatch.setenv("S3_BUCKET", "zz-legacy-training")
        f = tmp_path / "math-reward.py"
        f.write_text("def handler(e, c=None):\n    return []\nlambda_handler = handler\n")

        arn = re_mod._deploy_reward_lambda(
            name="math-reward", local_py=str(f),
            role_arn="arn:aws:iam::1:role/mlcc-reward-lambda-role-us-west-2",
            region="us-west-2",
        )
        assert captured["s3"]["bucket"] == "zz-core-x"
        assert captured["s3"]["key"] == "evaluators/math-reward/lambda_function.py"
        # Created with the dual-trust role and the standard handler name.
        assert captured["create"]["Role"].endswith("mlcc-reward-lambda-role-us-west-2")
        assert captured["create"]["Handler"] == "lambda_function.lambda_handler"
        assert arn.startswith("arn:aws:lambda:")

    def test_evaluator_bucket_never_derived_from_account(self, monkeypatch):
        # Bucket consolidation R2.1: with no profile key there is NO convention-built
        # fallback name (formerly mlcc-training-<sts account>-<region>).
        captured = {}
        self._install_fake_boto3(monkeypatch, captured)
        monkeypatch.delenv("S3_BUCKET", raising=False)
        monkeypatch.delenv("TRAINING_S3_BUCKET", raising=False)
        monkeypatch.delenv("CORE_S3_BUCKET", raising=False)
        assert re_mod._resolve_evaluator_bucket("us-west-2") is None

    def test_deploy_skips_backup_without_profile_bucket(self, monkeypatch, tmp_path):
        captured = {}
        self._install_fake_boto3(monkeypatch, captured)
        monkeypatch.delenv("CORE_S3_BUCKET", raising=False)
        monkeypatch.delenv("S3_BUCKET", raising=False)
        monkeypatch.delenv("TRAINING_S3_BUCKET", raising=False)
        f = tmp_path / "math-reward.py"
        f.write_text("def handler(e, c=None):\n    return []\nlambda_handler = handler\n")
        arn = re_mod._deploy_reward_lambda(
            name="math-reward", local_py=str(f),
            role_arn="arn:aws:iam::1:role/mlcc-reward-lambda-role-us-west-2",
            region="us-west-2",
        )
        assert "s3" not in captured  # best-effort backup skipped, no guessed bucket
        assert arn.startswith("arn:aws:lambda:")


class TestCreateEvaluatorNative:
    def test_reward_function_passes_type_and_source(self, monkeypatch):
        created = {}
        cleanup = _install_fake_evaluator_sdk(created)
        monkeypatch.setattr(re_mod, "check_ai_registry_available", lambda: True, raising=False)
        # check_ai_registry_available lives on ai_registry_native; patch there.
        import ai_registry_native
        monkeypatch.setattr(ai_registry_native, "check_ai_registry_available", lambda: True)
        try:
            info = re_mod._create_evaluator_native(
                name="rf", source="arn:aws:lambda:us-west-2:1:function:rf",
                evaluator_type="reward_function", region="us-west-2",
                role="arn:role", domain_id="d-1",
            )
        finally:
            cleanup()
        assert created["type"] == "REWARD_FUNCTION"
        assert created["source"] == "arn:aws:lambda:us-west-2:1:function:rf"
        assert created["role"] == "arn:role"
        assert created["domain_id"] == "d-1"
        assert info["type"] == "RewardFunction"
        assert info["domain_tagged"] is True

    def test_reward_prompt_passes_prompt_type(self, monkeypatch):
        created = {}
        cleanup = _install_fake_evaluator_sdk(created)
        import ai_registry_native
        monkeypatch.setattr(ai_registry_native, "check_ai_registry_available", lambda: True)
        try:
            info = re_mod._create_evaluator_native(
                name="jp", source="s3://b/judge.txt",
                evaluator_type="reward_prompt", region="us-east-1",
            )
        finally:
            cleanup()
        assert created["type"] == "REWARD_PROMPT"
        assert info["type"] == "RewardPrompt"
        assert "domain_id" not in created
        assert info["domain_tagged"] is False

    def test_unsupported_region_skips(self):
        import ai_registry_native
        with pytest.raises(ai_registry_native.NativeRegistrySkipped) as ei:
            re_mod._create_evaluator_native(
                name="rf", source="arn:...", evaluator_type="reward_function",
                region="eu-central-1",
            )
        assert "does not support" in str(ei.value)

    def test_missing_sdk_skips_with_upgrade_message(self, monkeypatch):
        import ai_registry_native
        monkeypatch.setattr(ai_registry_native, "check_ai_registry_available", lambda: False)
        with pytest.raises(ai_registry_native.NativeRegistrySkipped) as ei:
            re_mod._create_evaluator_native(
                name="rf", source="arn:...", evaluator_type="reward_function",
                region="us-west-2",
            )
        assert "upgrade sagemaker" in str(ei.value)


# ── list/resolve via the AI Registry SDK (B) ──────────────────────────────────
# The list/resolve paths use the SDK's own Evaluator.get_all()/get(), NOT a
# boto3 hub-name guess — the real SDK-created hub has an opaque generated id, so
# guessing AiRegistry-<region>-<account> always missed. These tests fake the SDK
# Evaluator so behavior — classification, type-filter, not-found — is asserted
# offline without AWS.

class _FakeEvaluator:
    """A fake sagemaker.ai_registry Evaluator object (what get_all/get return)."""
    def __init__(self, name, type, version="1.0.0", arn=None, reference=None):
        self.name = name
        self.type = type  # SDK form: "RewardFunction" / "RewardPrompt"
        self.version = version
        self.arn = arn or f"arn:...:{name}"
        self.reference = reference or f"s3://b/{name}.txt"


def _install_fake_evaluator_registry(monkeypatch, items, by_name=None):
    """Patch Evaluator.get_all / Evaluator.get on a fake SDK module.

    items: list[_FakeEvaluator] returned by get_all (filtered by type= here to
    mirror the real SDK). by_name: optional {name: _FakeEvaluator|None} for get().
    """
    import sys
    import types as _types
    ev_mod = sys.modules.get("sagemaker.ai_registry.evaluator") \
        or _types.ModuleType("sagemaker.ai_registry.evaluator")
    air = sys.modules.get("sagemaker.ai_registry.air_constants") \
        or _types.ModuleType("sagemaker.ai_registry.air_constants")
    air.REWARD_FUNCTION = "RewardFunction"
    air.REWARD_PROMPT = "RewardPrompt"

    class Evaluator:
        @staticmethod
        def get_all(type=None, max_results=None, sagemaker_session=None):
            if type is None:
                return list(items)
            return [e for e in items if e.type == type]

        @staticmethod
        def get(name, sagemaker_session=None):
            table = by_name if by_name is not None else {e.name: e for e in items}
            if name not in table:
                raise RuntimeError(f"ResourceNotFound: {name} does not exist")
            return table[name]

    ev_mod.Evaluator = Evaluator
    sys.modules["sagemaker"] = sys.modules.get("sagemaker") or _types.ModuleType("sagemaker")
    sys.modules["sagemaker.ai_registry"] = sys.modules.get("sagemaker.ai_registry") \
        or _types.ModuleType("sagemaker.ai_registry")
    sys.modules["sagemaker.ai_registry.evaluator"] = ev_mod
    sys.modules["sagemaker.ai_registry.air_constants"] = air


class TestListEvaluators:
    def test_lists_and_classifies_by_type(self, monkeypatch):
        import register_resolve as rr
        _install_fake_evaluator_registry(monkeypatch, [
            _FakeEvaluator("math-rf", "RewardFunction", arn="arn:rf"),
            _FakeEvaluator("clarity-judge", "RewardPrompt", arn="arn:rp"),
        ])
        out = rr._list_evaluators_native("us-west-2")
        types_by_name = {e["name"]: e["type"] for e in out}
        assert types_by_name == {"math-rf": "reward_function", "clarity-judge": "reward_prompt"}

    def test_filters_to_requested_type(self, monkeypatch):
        import register_resolve as rr
        _install_fake_evaluator_registry(monkeypatch, [
            _FakeEvaluator("math-rf", "RewardFunction"),
            _FakeEvaluator("clarity-judge", "RewardPrompt"),
        ])
        prompts = rr._list_evaluators_native("us-west-2", evaluator_type="reward_prompt")
        assert [e["name"] for e in prompts] == ["clarity-judge"]
        funcs = rr._list_evaluators_native("us-west-2", evaluator_type="reward_function")
        assert [e["name"] for e in funcs] == ["math-rf"]

    def test_carries_version_arn_reference(self, monkeypatch):
        import register_resolve as rr
        _install_fake_evaluator_registry(monkeypatch, [
            _FakeEvaluator("clarity-judge", "RewardPrompt", version="4.0.0",
                           arn="arn:hub/clarity-judge/4.0.0", reference="s3://b/j.txt"),
        ])
        out = rr._list_evaluators_native("us-west-2")
        assert out == [{
            "name": "clarity-judge", "type": "reward_prompt", "version": "4.0.0",
            "arn": "arn:hub/clarity-judge/4.0.0", "reference": "s3://b/j.txt",
        }]

    def test_empty_registry_returns_empty_list(self, monkeypatch):
        import register_resolve as rr
        _install_fake_evaluator_registry(monkeypatch, [])
        assert rr._list_evaluators_native("us-west-2") == []


class TestResolveEvaluatorNative:
    def test_resolves_existing(self, monkeypatch):
        import register_resolve as rr
        _install_fake_evaluator_registry(monkeypatch, [
            _FakeEvaluator("clarity-judge", "RewardPrompt", version="4.0.0",
                           reference="s3://b/j.txt"),
        ])
        got = rr._resolve_evaluator_native("clarity-judge", "us-west-2")
        assert got["name"] == "clarity-judge"
        assert got["type"] == "reward_prompt"
        assert got["reference"] == "s3://b/j.txt"
        assert got["version"] == "4.0.0"

    def test_not_found_returns_none(self, monkeypatch):
        import register_resolve as rr
        _install_fake_evaluator_registry(monkeypatch, [], by_name={})
        assert rr._resolve_evaluator_native("missing", "us-west-2") is None


# ── resolve_domain_id: top-level key AND moduleOutputs fallback ────────────────

class TestResolveDomainId:
    def test_prefers_top_level_domain_id(self, monkeypatch):
        import ai_registry_native as arn
        monkeypatch.setattr(arn, "_active_profile_data", lambda: {"domainId": "d-top"})
        assert arn.resolve_domain_id() == "d-top"

    def test_falls_back_to_module_outputs(self, monkeypatch):
        # The bootstrap denormalizer may not have backfilled the top-level key
        # (module provisioned before that step, or add-module short-circuited),
        # but moduleOutputs carries the DomainId. Resolution must find it.
        import ai_registry_native as arn
        monkeypatch.setattr(arn, "_active_profile_data", lambda: {
            "moduleOutputs": {"sagemaker-domain": {"DomainId": "d-fallback"}}
        })
        assert arn.resolve_domain_id() == "d-fallback"

    def test_top_level_wins_over_module_outputs(self, monkeypatch):
        import ai_registry_native as arn
        monkeypatch.setattr(arn, "_active_profile_data", lambda: {
            "domainId": "d-top",
            "moduleOutputs": {"sagemaker-domain": {"DomainId": "d-fallback"}},
        })
        assert arn.resolve_domain_id() == "d-top"

    def test_none_when_neither_present(self, monkeypatch):
        import ai_registry_native as arn
        monkeypatch.setattr(arn, "_active_profile_data", lambda: {
            "moduleOutputs": {"core": {"CoreBucket": "b"}}  # domain not provisioned
        })
        assert arn.resolve_domain_id() is None

    def test_handles_malformed_module_outputs(self, monkeypatch):
        import ai_registry_native as arn
        # sagemaker-domain present but not a dict → must not crash, returns None.
        monkeypatch.setattr(arn, "_active_profile_data", lambda: {
            "moduleOutputs": {"sagemaker-domain": "oops-not-a-dict"}
        })
        assert arn.resolve_domain_id() is None
