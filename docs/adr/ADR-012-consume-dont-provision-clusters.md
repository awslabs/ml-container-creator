<!--
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
-->
# ADR-012: Consume-Don't-Provision for EKS / HyperPod clusters

## Status

Accepted (v2.0, 2026-09-29). Codifies a principle reached across the v1.9 plain-EKS
deploys and the v2.0 EKS/HyperPod work, and crystallized by the
HyperPod-provisioning deprecation (BL143 → BL162 spike). It governs the vanilla-EKS
deploy-time work (BL155–BL161) and the HyperPod provisioning spike (BL162), and sets the
default posture for any future cluster-backed deploy target.

## Context

MLCC deploys models to two cluster-backed targets: `eks` (plain Kubernetes) and
`hyperpod-eks` (SageMaker HyperPod on EKS). The open question each raised was the same:
**does MLCC PROVISION the cluster, or does it CONSUME a cluster someone else provisioned?**

Two hard lessons pushed the answer to "consume":

1. **Vanilla EKS (the Kimi-K3 lesson).** Users increasingly want to deploy to an EKS
   cluster they already own and configured. MLCC cannot assume it created the cluster, its
   IAM/OIDC, its storage drivers, or its node capacity. The model-storage failure
   (ephemeral-storage is the node's ~89 GiB root EBS, not the instance NVMe) was a
   NODE-CONFIG / cluster-contract issue, not an MLCC bug — MLCC's job is to detect and
   fail-fast with precise guidance, not to reconfigure the node.

2. **HyperPod provisioning (the BL143 rehearsal).** MLCC's hand-rolled HyperPod cluster
   CREATION path produced a cluster the inference operator could not use — it registered
   but never issued `CreateEndpoint`. The root cause lives in AWS's compiled provisioning
   Lambda and cannot be reconstructed by hand-assembling add-on config. The `hyperpod`
   bootstrap (provisioning) module was deprecated. Decisively, `do/deploy --target
   hyperpod-eks` then drove a real SageMaker endpoint to `InService` against a
   console/CFT-provisioned HP-native cluster (2026-09-29) — proving the DEPLOY path works
   when MLCC consumes a correctly-provisioned cluster. The thing MLCC could NOT do reliably
   was provision; the thing it CAN do is consume + validate + deploy.

The common failure mode both lessons share: when MLCC tries to own provisioning, a silent
mismatch (a missing node config, a cluster-level inference capability only AWS's Lambda
attaches, an operator-resolved name that doesn't match the convention) surfaces as an
UNTRACEABLE failure — a pod loop, an endpoint that never creates, a swallowed error
(BL141). Consuming a documented contract and failing fast moves that failure class to
deploy-time preflight with a precise message.

## Decision

**MLCC CONSUMES and VALIDATES a cluster against a documented contract; it does not
provision it. Where MLCC must name a resource the cluster's control plane resolves by
convention, MLCC adheres to the service's naming convention, not its own.**

Concretely:

1. **BYO is the first-class path; bootstrapping is optional convenience.** For `--target
   eks` the cluster is treated as bring-your-own, pre-configured infrastructure that MLCC
   CONSUMES, DETECTS gaps in, and FAILS FAST against. The `eks` bootstrap module is an
   optional convenience for users who want MLCC to stand a cluster up — never a
   prerequisite. The same posture is the default for HyperPod: a console/CFT-provisioned
   HP-native cluster is the supported substrate; MLCC consumes it.

2. **One deploy path, split by OWNERSHIP not origin.** The deploy-time validation
   (`do/deploy.d/eks`) is identical regardless of who provisioned the cluster. What differs
   is who SATISFIES the contract: a BOOTSTRAPPED cluster has the `eks` module install the
   CSI driver / OIDC / inference role; a BYO cluster has MLCC install NOTHING — only detect,
   validate, and fail fast. Do not fork the deploy path by cluster origin.

3. **The contract is explicit and documented.** Everything MLCC needs from the cluster
   (pod AWS identity via IRSA/Pod-Identity, model-storage capacity, the relevant CSI driver)
   is an enumerated contract element, each checked at deploy with a clear "cluster is
   missing X" message, and documented in the developer guide.

4. **Adhere to the service's naming convention where it resolves by name.** Wherever the
   control plane resolves a resource by name/prefix, MLCC conforms to the AWS service's own
   naming convention; MLCC imposes its own `mlcc-` naming ONLY where it fully owns the
   resource and nothing downstream resolves it by convention. This removes the
   silent-mismatch failure class at the source instead of hoping a swallowed error (BL141)
   is caught downstream.

5. **Re-implement an AWS-owned install only as a last resort.** MLCC should not
   hand-reconstruct an AWS-published install (inference-operator CFT, the HyperPod
   CreateCluster inference-enable path) whose trigger is undocumented and un-debuggable from
   outside. Prefer consuming the tested AWS artifact (template / console flow) — the
   HyperPod provisioning spike (BL162) evaluates adopting AWS's HP-native provisioning
   rather than reconstructing it.

## Options considered

- **A — MLCC provisions everything (status quo ante).** Rejected. Both lessons show MLCC
  cannot reliably own cluster provisioning: the vanilla-EKS node config is the user's, and
  HyperPod's inference-enable path is compiled into an AWS Lambda MLCC cannot reproduce.
  Provisioning failures are untraceable.
- **B — MLCC consumes + validates against a documented contract (chosen).** BYO first-class,
  bootstrap optional, fail-fast at deploy, adhere to service naming. Moves the failure class
  to a precise preflight message.
- **C — MLCC provisions only via AWS's own published artifacts (CFT/console), never
  hand-rolled.** Not mutually exclusive with B — it is how B handles the cases where a
  cluster MUST be provisioned (BL162 evaluates it for HyperPod). Adopted as the last-resort
  provisioning stance, subordinate to B's consume-first default.

## Consequences

- **Positive:** cluster-backed deploys fail fast with actionable guidance instead of looping
  silently; the vanilla-EKS and HyperPod targets share one coherent posture; the vanilla-EKS
  deploy-time work becomes a scopable deliverable (BL155–BL161) rather than an open
  provisioning problem; the
  HyperPod deprecation stops being a loss and becomes an instance of the principle; the
  naming-mismatch + swallowed-error failure class (BL141) shrinks.
- **Cost / constraint:** users deploying to BYO clusters must satisfy a documented contract
  (IRSA, storage, CSI driver) — MLCC will refuse (clearly) rather than paper over a
  non-conforming cluster. HyperPod users need a console/CFT-provisioned cluster until BL162
  resolves an HP-native provisioning path MLCC can adopt.
- **Scope:** governs the vanilla-EKS deploy-time work (BL155 storage, BL156 contract,
  BL157 benchmark parity, BL161 add-on CfnAddon + naming audit) and BL162 (the provisioning
  spike). The deprecated
  `hyperpod` provisioning module stays deprecated; the `hyperpod-eks` DEPLOY target stands
  (proven `InService`).

## References

- `.kiro/v2.0-eks-vanilla-support.md` — the vanilla-EKS contract + storage design (the
  EKS-half write-up of this principle).
- `docs/architecture/eks-hyperpod-migration.md` — the HyperPod forensic trail: provisioning
  deprecation, the deploy-path `InService` confirmation, the operator/naming findings.
- ADR-008 — deployment-target descriptor (the derive-don't-hardcode sibling; the contract
  this ADR validates is declared in `targets.d/`).
- Backlog: BL155–BL158 (vanilla-EKS deploy-time), BL159–BL160 (ADR-008 hygiene), BL161
  (CfnAddon + naming audit), BL162 (HP-native provisioning spike).
