#!/bin/bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# eks-contract.sh — Vanilla-EKS cluster-contract preflight for do/deploy.d/eks (BL156).
#
# PATTERN: Shared library helper (single source of truth), mirroring
#   aws-preflight.sh (ADR-007 sourced-lib pattern). This is the FIRST
#   implementation of consume-don't-provision (ADR-012): a plain-EKS deploy
#   requires a set of CLUSTER-PROVIDED capabilities (pod identity, a CSI driver,
#   and the PV/StorageClass backing a mount) that MLCC DETECTS + VALIDATES +
#   FAILS FAST on — it does NOT provision them. The ONE write a plain-EKS deploy
#   performs (the mlcc-eks-inference-sa ServiceAccount) stays in deploy.d/eks,
#   not here; this lib is strictly read-only (describe/get/list only).
# COLLABORATORS: sourced by deploy.d/eks AFTER the unconditional cluster
#   connectivity verify and BEFORE the ServiceAccount block + manifest apply;
#   pairs with aws-preflight.sh (credentials) and the BL155 storage mount.
# DATA-FLOW ROLE: reads do/config-derived env (STAGED_MODEL_PATH,
#   EKS_INFERENCE_ROLE_ARN / _PROFILE_eksInferenceRoleArn, EKS_MODEL_MOUNT,
#   EKS_STORAGE_CLASS, HP_NAMESPACE, HP_CLUSTER_NAME/EKS cluster name, AWS_REGION)
#   and queries live cluster state; it writes nothing.
# See: docs/deployments.md (Vanilla-EKS cluster contract),
#   docs/adr/ADR-012-consume-dont-provision-clusters.md,
#   docs/adr/ADR-007-do-script-contract-enforcement.md
#
# Usage:
#   source "${SCRIPT_DIR}/lib/eks-contract.sh"
#   _eks_contract_preflight            # runs every applicable element; exits 4 on a required miss
#
# Exit convention: a REQUIRED missing/ mismatched element exits 4 — the
# deploy.d/eks PRECONDITION convention (same class as its ECR-image exit 4), NOT
# aws-preflight's exit 1 (credentials) nor script-contract's exit 3 (guard).
# CONDITIONAL elements not needed by this deploy (e.g. the CSI element on the
# emptyDir path) are SKIPPED silently. Detector-query TRANSPORT errors fail
# CLOSED (surface the error + exit 4) rather than passing blind.

# The SA that an S3-staged plain-EKS pod runs under (created by deploy.d/eks).
: "${EKS_INFERENCE_SA:=mlcc-eks-inference-sa}"

# ── Element 1: pod identity (Req 2) ───────────────────────────────────────────
# Applies ONLY for an S3-staged model (STAGED_MODEL_PATH set) — the pod must
# `aws s3 sync` the weights itself, so it needs an AWS identity. An HF-source
# model needs none → skip with an info line. For the S3 case: REQUIRE a
# resolvable role ARN AND pod identity via EITHER IRSA (the cluster's IAM OIDC
# provider associated) OR EKS Pod Identity (the agent addon + an association for
# the inference SA). Neither → fail fast listing BOTH remediations. Queries live
# state only, so a created AND a BYO/adopted cluster are validated identically
# (no provisioning branch — the v1.9 create-only-branch trap).
_eks_contract_identity() {
    if [ -z "${STAGED_MODEL_PATH:-}" ]; then
        echo "ℹ️  Cluster contract — identity: HuggingFace-source deploy, no AWS identity needed (skip)."
        return 0
    fi

    echo "🔍 Cluster contract — identity (S3-staged model needs pod AWS credentials)..."

    local role_arn="${EKS_INFERENCE_ROLE_ARN:-${_PROFILE_eksInferenceRoleArn:-}}"
    if [ -z "${role_arn}" ]; then
        echo "❌ Cluster contract: no EKS inference role is set, but this deploy uses an S3-staged model."
        echo "   The pod would fail to download it ('Unable to locate credentials')."
        echo "   Satisfy the contract (BYO cluster), e.g.:"
        echo "     eksctl create iamserviceaccount --cluster <eks-cluster> --namespace ${HP_NAMESPACE:-default} \\"
        echo "       --name ${EKS_INFERENCE_SA} --attach-policy-arn <s3-read-policy> --approve"
        echo "   then set EKS_INFERENCE_ROLE_ARN in do/config — or provision the 'eks' bootstrap module."
        echo "   See docs/deployments.md#vanilla-eks-cluster-contract."
        exit 4
    fi

    # Pod identity: accept IRSA OR EKS Pod Identity (either satisfies Req 2).
    if _eks_identity_has_irsa; then
        echo "✅ Cluster contract — identity: role ${role_arn} + an associated IAM OIDC provider (IRSA)."
        return 0
    fi
    if _eks_identity_has_pod_identity; then
        echo "✅ Cluster contract — identity: role ${role_arn} + an EKS Pod Identity association."
        return 0
    fi

    echo "❌ Cluster contract: a role is set (${role_arn}) but the cluster grants the pod NO AWS identity."
    echo "   Provide EITHER of the following on the cluster (BYO), then redeploy:"
    echo "   • IRSA — associate an IAM OIDC provider with the cluster:"
    echo "       eksctl utils associate-iam-oidc-provider --cluster <eks-cluster> --approve"
    echo "     and ensure ${EKS_INFERENCE_SA}'s role trusts that provider; OR"
    echo "   • EKS Pod Identity — install the Pod Identity agent addon and create an association:"
    echo "       aws eks create-pod-identity-association --cluster-name <eks-cluster> \\"
    echo "         --namespace ${HP_NAMESPACE:-default} --service-account ${EKS_INFERENCE_SA} --role-arn ${role_arn}"
    echo "   Or provision the 'eks' bootstrap module. See docs/deployments.md#vanilla-eks-cluster-contract."
    exit 4
}

# IRSA: the cluster's OIDC issuer (describe-cluster) must appear as an associated
# IAM OIDC provider (list-open-id-connect-providers). The provider ARN encodes
# the issuer host+path, so match on the scheme-stripped issuer.
_eks_identity_has_irsa() {
    local cluster="${EKS_CLUSTER_NAME:-${HP_CLUSTER_NAME:-}}"
    [ -n "${cluster}" ] || return 1

    local _region_arg=""
    [ -n "${AWS_REGION:-}" ] && _region_arg="--region ${AWS_REGION}"

    local issuer
    issuer=$(aws eks describe-cluster --name "${cluster}" ${_region_arg} \
        --query 'cluster.identity.oidc.issuer' --output text 2>/dev/null) || return 1
    [ -n "${issuer}" ] && [ "${issuer}" != "None" ] || return 1
    local issuer_host="${issuer#https://}"

    local providers
    providers=$(aws iam list-open-id-connect-providers \
        --query 'OpenIDConnectProviderList[].Arn' --output text 2>/dev/null) || return 1

    case "${providers}" in
        *"${issuer_host}"*) return 0 ;;
        *) return 1 ;;
    esac
}

# EKS Pod Identity: an association for the inference SA in the deploy namespace.
_eks_identity_has_pod_identity() {
    local cluster="${EKS_CLUSTER_NAME:-${HP_CLUSTER_NAME:-}}"
    [ -n "${cluster}" ] || return 1

    local _region_arg=""
    [ -n "${AWS_REGION:-}" ] && _region_arg="--region ${AWS_REGION}"

    local assoc
    assoc=$(aws eks list-pod-identity-associations --cluster-name "${cluster}" ${_region_arg} \
        --namespace "${HP_NAMESPACE:-default}" \
        --query "associations[?serviceAccount=='${EKS_INFERENCE_SA}'] | [0].associationId" \
        --output text 2>/dev/null) || return 1
    [ -n "${assoc}" ] && [ "${assoc}" != "None" ]
}

# ── Element 2: storage — CSI driver + volume backing (Req 3) ──────────────────
# Applies ONLY when EKS_MODEL_MOUNT is set (s3|ebs|fsx — the BL156 OQ-3
# provisional mount-path trigger that BL155 consumes). Unset → the emptyDir path
# → SKIP. When set: (a) DETECT the required CSI driver by presence; (b) DETECT
# the CLUSTER-PROVIDED volume backing the namespaced PVC that BL155 emits — a
# static S3-CSI PV (s3) or a StorageClass (ebs|fsx). MLCC emits ONLY the PVC
# (BL155 OQ-2 / ADR-012); it never provisions the PV/StorageClass, so their
# absence is a contract failure the operator must satisfy.
_eks_contract_storage_csi() {
    local mount="${EKS_MODEL_MOUNT:-}"
    if [ -z "${mount}" ]; then
        return 0
    fi

    echo "🔍 Cluster contract — storage (EKS_MODEL_MOUNT=${mount})..."

    local driver=""
    case "${mount}" in
        s3)  driver="s3.csi.aws.com" ;;
        ebs) driver="ebs.csi.aws.com" ;;
        fsx) driver="fsx.csi.aws.com" ;;
        *)
            echo "❌ Cluster contract: unknown EKS_MODEL_MOUNT='${mount}' (expected s3|ebs|fsx)."
            echo "   See docs/deployments.md#vanilla-eks-cluster-contract."
            exit 4
            ;;
    esac

    # (a) CSI driver presence (by the CSIDriver object — a transport error fails
    #     closed via the explicit error branch below, not a silent pass).
    local csidrivers
    csidrivers=$(kubectl get csidriver -o name 2>/dev/null) || {
        echo "❌ Cluster contract: could not query CSI drivers (kubectl get csidriver failed)."
        echo "   Verify kubectl connectivity and RBAC, then redeploy."
        exit 4
    }
    case "${csidrivers}" in
        *"${driver}"*) : ;;
        *)
            echo "❌ Cluster contract: the ${driver} CSI driver is not installed (required for EKS_MODEL_MOUNT=${mount})."
            _eks_csi_driver_remediation "${mount}" "${driver}"
            exit 4
            ;;
    esac
    echo "   ✓ CSI driver present: ${driver}"

    # (b) Volume backing — cluster-provided, matching the selected mode.
    if [ "${mount}" = "s3" ]; then
        _eks_contract_s3_pv || exit 4
    else
        _eks_contract_storage_class "${mount}" || exit 4
    fi

    echo "✅ Cluster contract — storage: ${driver} + a matching cluster-provided volume backing."
}

# s3 backing: a STATIC PersistentVolume on s3.csi.aws.com whose bucket+prefix
# matches STAGED_MODEL_PATH. MLCC emits only the PVC that binds it (BL155 OQ-2).
_eks_contract_s3_pv() {
    local staged="${STAGED_MODEL_PATH:-}"
    if [ -z "${staged}" ]; then
        # BL155 also guards this, but keep the contract self-consistent: an S3
        # mount with no staged prefix has nothing to bind.
        echo "❌ Cluster contract: EKS_MODEL_MOUNT=s3 but STAGED_MODEL_PATH is unset — run do/stage first."
        return 1
    fi

    # Parse s3://<bucket>/<prefix...> → bucket + prefix (prefix may be empty).
    local no_scheme="${staged#s3://}"
    local bucket="${no_scheme%%/*}"
    local prefix=""
    case "${no_scheme}" in
        */*) prefix="${no_scheme#*/}" ;;
    esac
    prefix="${prefix%/}"

    # Enumerate static S3-CSI PVs and match bucketName + (optional) prefix mount
    # option. JSON over jsonpath so we can inspect mountOptions robustly.
    local pv_json
    pv_json=$(kubectl get pv -o json 2>/dev/null) || {
        echo "❌ Cluster contract: could not query PersistentVolumes (kubectl get pv failed)."
        echo "   Verify kubectl connectivity and RBAC, then redeploy."
        return 1
    }

    local matched
    matched=$(BUCKET="${bucket}" PREFIX="${prefix}" python3 -c '
import json, os, sys
bucket = os.environ["BUCKET"]
prefix = os.environ["PREFIX"]
try:
    data = json.load(sys.stdin)
except Exception:
    print("no")
    sys.exit(0)
for item in data.get("items", []):
    csi = (item.get("spec") or {}).get("csi") or {}
    if csi.get("driver") != "s3.csi.aws.com":
        continue
    attrs = csi.get("volumeAttributes") or {}
    if attrs.get("bucketName") != bucket:
        continue
    # Prefix, when the deploy has one, must be honored by a --prefix mount option
    # (mountpoint-S3 static-PV convention). No prefix → bucket match suffices.
    if not prefix:
        print("yes"); sys.exit(0)
    opts = csi.get("mountOptions") or item.get("spec", {}).get("mountOptions") or []
    joined = " ".join(opts) if isinstance(opts, list) else str(opts)
    if ("prefix %s" % prefix) in joined or ("prefix=%s" % prefix) in joined or prefix in joined:
        print("yes"); sys.exit(0)
print("no")
' <<<"${pv_json}" 2>/dev/null) || matched="no"

    if [ "${matched}" = "yes" ]; then
        echo "   ✓ Cluster-provided static S3-CSI PV found for s3://${bucket}/${prefix}"
        return 0
    fi

    echo "❌ Cluster contract: no cluster-provided static S3-CSI PersistentVolume matches s3://${bucket}/${prefix}."
    echo "   MLCC emits only the namespaced PVC; the cluster must pre-create the static PV (ADR-012)."
    echo "   Pre-create a PV with:"
    echo "     spec.csi.driver: s3.csi.aws.com"
    echo "     spec.csi.volumeAttributes.bucketName: ${bucket}"
    [ -n "${prefix}" ] && echo "     spec.mountOptions: [\"prefix ${prefix}/\"]"
    echo "     spec.accessModes: [ReadOnlyMany]"
    echo "   See docs/deployments.md#vanilla-eks-cluster-contract."
    return 1
}

# ebs|fsx backing: the target StorageClass must exist (EKS_STORAGE_CLASS, else
# the cluster default). MLCC emits only the PVC that references it (BL155 OQ-2).
_eks_contract_storage_class() {
    local mount="${1}"
    local sc="${EKS_STORAGE_CLASS:-}"

    local sc_json
    sc_json=$(kubectl get storageclass -o json 2>/dev/null) || {
        echo "❌ Cluster contract: could not query StorageClasses (kubectl get storageclass failed)."
        echo "   Verify kubectl connectivity and RBAC, then redeploy."
        return 1
    }

    local found
    found=$(WANT="${sc}" python3 -c '
import json, os, sys
want = os.environ["WANT"]
try:
    data = json.load(sys.stdin)
except Exception:
    print(""); sys.exit(0)
items = data.get("items", [])
if want:
    for sc in items:
        if (sc.get("metadata") or {}).get("name") == want:
            print(want); sys.exit(0)
    print(""); sys.exit(0)
# No explicit class → the cluster default (annotation).
for sc in items:
    ann = (sc.get("metadata") or {}).get("annotations") or {}
    if ann.get("storageclass.kubernetes.io/is-default-class") == "true":
        print((sc.get("metadata") or {}).get("name") or ""); sys.exit(0)
print("")
' <<<"${sc_json}" 2>/dev/null) || found=""

    if [ -n "${found}" ]; then
        echo "   ✓ StorageClass present: ${found}"
        return 0
    fi

    if [ -n "${sc}" ]; then
        echo "❌ Cluster contract: StorageClass '${sc}' (EKS_STORAGE_CLASS) does not exist on the cluster."
        echo "   Create it (or point EKS_STORAGE_CLASS at an existing ${mount} StorageClass), then redeploy."
    else
        echo "❌ Cluster contract: no default StorageClass on the cluster for EKS_MODEL_MOUNT=${mount}."
        echo "   Mark a ${mount} StorageClass default (storageclass.kubernetes.io/is-default-class=true)"
        echo "   or set EKS_STORAGE_CLASS in do/config to a named class, then redeploy."
    fi
    echo "   MLCC emits only the namespaced PVC; the StorageClass is cluster-provided (ADR-012)."
    echo "   See docs/deployments.md#vanilla-eks-cluster-contract."
    return 1
}

_eks_csi_driver_remediation() {
    local mount="${1}" driver="${2}"
    case "${mount}" in
        s3)
            echo "   Install the Mountpoint-S3 CSI driver, e.g.:"
            echo "     aws eks create-addon --cluster-name <eks-cluster> --addon-name aws-mountpoint-s3-csi-driver"
            ;;
        ebs)
            echo "   Install the EBS CSI driver, e.g.:"
            echo "     aws eks create-addon --cluster-name <eks-cluster> --addon-name aws-ebs-csi-driver"
            ;;
        fsx)
            echo "   Install the FSx CSI driver (Helm chart aws-fsx-csi-driver)."
            ;;
    esac
    echo "   Or provision the 'eks' bootstrap module. See docs/deployments.md#vanilla-eks-cluster-contract."
}

# ── Element 3: ephemeral-storage fail-fast (emptyDir path only) — BL155 Req 1 ──
# Applies ONLY on the emptyDir path (no HP_MODEL_HOSTPATH, no EKS_MODEL_MOUNT):
# that path stores the model on the node ROOT volume, which on a GPU node is
# typically a small EBS root (~89 GiB observed) that a large model cannot fit —
# a NODE-CONFIG issue that otherwise surfaces as a silent kubelet eviction loop
# AFTER the pod schedules. This check compares the model footprint
# (HP_EPHEMERAL_STORAGE else HP_GPU_COUNT*20Gi) against the allocatable
# ephemeral-storage of the GPU-capable nodes the pod can land on, and (OQ-3)
# hard-fails ONLY when the LARGEST such node still cannot fit it — i.e. no node
# can host it. An unreadable/empty node list WARNS and proceeds (fail-open on an
# indeterminate signal). On the hostPath / CSI-mount path it SKIPS (the model
# does not draw from the node root).
_eks_storage_capacity_preflight() {
    # Skip on any non-emptyDir path.
    if [ -n "${HP_MODEL_HOSTPATH:-}" ] || [ -n "${EKS_MODEL_MOUNT:-}" ]; then
        return 0
    fi

    echo "🔍 Cluster contract — node ephemeral-storage capacity (emptyDir model path)..."

    # Model footprint in GiB: the explicit override, else the HP_GPU_COUNT*20Gi
    # proxy the Deployment template uses (keep the two in lockstep).
    local gpu="${HP_GPU_COUNT:-1}"
    local need_gib="${HP_EPHEMERAL_STORAGE:-}"
    need_gib="${need_gib%Gi}"
    if [ -z "${need_gib}" ]; then
        need_gib=$(( gpu * 20 ))
    fi

    # Query the MAX allocatable ephemeral-storage across GPU-capable nodes. The
    # value is a Kubernetes quantity (usually Ki) → convert to GiB. An empty list
    # or a query error → indeterminate → warn + proceed (fail-open).
    local max_gib
    max_gib=$(NEED="${need_gib}" python3 -c '
import json, subprocess, sys
try:
    out = subprocess.run(
        ["kubectl", "get", "nodes",
         "-l", "nvidia.com/gpu.present=true",
         "-o", "json"],
        capture_output=True, text=True, timeout=30)
    data = json.loads(out.stdout) if out.returncode == 0 and out.stdout.strip() else {"items": []}
    items = data.get("items", [])
    # Fall back to ALL nodes when the GPU label is absent (some clusters do not
    # set nvidia.com/gpu.present); still "GPU-capable" is approximated by the
    # presence of an nvidia.com/gpu allocatable entry.
    if not items:
        out2 = subprocess.run(["kubectl", "get", "nodes", "-o", "json"],
                              capture_output=True, text=True, timeout=30)
        data = json.loads(out2.stdout) if out2.returncode == 0 and out2.stdout.strip() else {"items": []}
        items = [n for n in data.get("items", [])
                 if "nvidia.com/gpu" in ((n.get("status") or {}).get("allocatable") or {})]
    def to_gib(q):
        if not q:
            return 0.0
        q = str(q)
        units = {"Ki": 1/(1024**2), "Mi": 1/1024, "Gi": 1.0, "Ti": 1024.0,
                 "K": 1000/(1024**3), "M": 1000**2/(1024**3), "G": 1000**3/(1024**3),
                 "T": 1000**4/(1024**3)}
        for u, f in units.items():
            if q.endswith(u):
                try:
                    return float(q[:-len(u)]) * f
                except ValueError:
                    return 0.0
        try:
            return float(q) / (1024**3)  # bare bytes
        except ValueError:
            return 0.0
    best = 0.0
    for n in items:
        alloc = (n.get("status") or {}).get("allocatable") or {}
        best = max(best, to_gib(alloc.get("ephemeral-storage")))
    print("" if not items else str(int(best)))
except Exception:
    print("")  # indeterminate → caller warns + proceeds
' 2>/dev/null) || max_gib=""

    if [ -z "${max_gib}" ]; then
        echo "⚠️  Could not determine GPU-node ephemeral-storage (no readable GPU nodes); skipping the capacity check."
        echo "   If the model does not fit the node root volume, the pod may hit a DiskPressure eviction loop."
        return 0
    fi

    if [ "${max_gib}" -lt "${need_gib}" ]; then
        echo "❌ Cluster contract: no GPU node can fit the model on its root volume."
        echo "   Needed (emptyDir): ~${need_gib}Gi   Largest GPU node allocatable: ~${max_gib}Gi"
        echo "   The default emptyDir path stores the model on the node ROOT volume, which is too small."
        echo "   Remediations (pick one):"
        echo "   • Mount the instance-store NVMe as the kubelet root, or set HP_MODEL_HOSTPATH to a node-local NVMe base."
        echo "   • Use a PVC mount:  EKS_MODEL_MOUNT=ebs|fsx  (download the model to a larger CSI volume)."
        echo "   • Use an S3-CSI stream:  EKS_MODEL_MOUNT=s3  (no local download; requires a staged model)."
        echo "   • Or override HP_EPHEMERAL_STORAGE if the footprint estimate is wrong."
        echo "   See docs/deployments.md#large-models-and-multi-gpu-on-plain-eks."
        exit 4
    fi

    echo "   ✓ Largest GPU node (~${max_gib}Gi) fits the model footprint (~${need_gib}Gi)."
}

# ── BL155 mount-mode guards — Req 3.2 / 3.4 ───────────────────────────────────
# Cheap precondition checks for the CSI mount path, run before the render:
#   • EKS_MODEL_MOUNT=s3 needs a staged model (an HF model has no S3 prefix).
#   • The mount modes are WRAPPER-engine-only (vllm/sglang/tensorrt-llm), whose
#     code/serve pre-mounted-artifact detection is verified; a Model-B engine
#     (lmi/djl/llama-cpp) loads via its DLC and is NOT known to honor a mount at
#     /opt/ml/model, so reject it with guidance (OQ-4 deferred).
_eks_mount_guards() {
    local mount="${EKS_MODEL_MOUNT:-}"
    [ -n "${mount}" ] || return 0

    if [ "${mount}" = "s3" ] && [ -z "${STAGED_MODEL_PATH:-}" ]; then
        echo "❌ EKS_MODEL_MOUNT=s3 requires a staged model (STAGED_MODEL_PATH), but none is set."
        echo "   An S3-CSI mount streams the staged S3 prefix read-only — a HuggingFace-source model has no prefix to mount."
        echo "   Run ./do/stage first (or use EKS_MODEL_MOUNT=ebs|fsx to download to a CSI volume)."
        exit 4
    fi

    case "${MODEL_SERVER:-vllm}" in
        vllm|sglang|tensorrt-llm|trtllm) : ;;
        *)
            echo "❌ EKS_MODEL_MOUNT=${mount} is supported only for the wrapper engines (vllm/sglang/tensorrt-llm)."
            echo "   MODEL_SERVER='${MODEL_SERVER:-}' loads via its own DLC and is not known to honor a model pre-mounted"
            echo "   at /opt/ml/model, so MLCC will not claim a mount for it. Use the emptyDir or HP_MODEL_HOSTPATH path,"
            echo "   or see OQ-4 (Model-B mount support, deferred). See docs/deployments.md#vanilla-eks-cluster-contract."
            exit 4
            ;;
    esac
}

# ── The single contract gate ──────────────────────────────────────────────────
# Runs every element in order; each detects → validates → fails fast (exit 4) or
# skips. Read-only: no element issues a create/apply/install verb.
# NOTE on ordering: identity + CSI + mount-guards depend only on do/config values
# available before the ServiceAccount block, so they run in this gate (early).
# The ephemeral-storage capacity check (_eks_storage_capacity_preflight) depends
# on the deploy-time-RESOLVED HP_GPU_COUNT (auto-detected from the instance type
# later in deploy.d/eks), so the driver calls it SEPARATELY after that resolution
# but still before the manifest apply.
_eks_contract_preflight() {
    echo "🔒 Vanilla-EKS cluster-contract preflight (consume-don't-provision, ADR-012)..."
    _eks_mount_guards
    _eks_contract_identity
    _eks_contract_storage_csi
    echo "✅ Cluster contract satisfied."
}
