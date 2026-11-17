// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// BL143: the eks-cluster / hyperpod-cluster / inference-operator stacks moved to the
// `eks/` and `hyperpod/` module dirs. This dir retains only the legacy single-stack
// intent-only stub (MlccHyperpodStack), kept for the `hyperpod` stackNameSuffix factory
// in bin/app.ts. New code should import from `../eks` or `../hyperpod`.
export { MlccHyperpodStack } from './stack';
