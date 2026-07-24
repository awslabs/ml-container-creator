// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export { MlccEksClusterStack } from './stacks/eks-cluster-stack';
export { MlccHyperPodClusterStack } from './stacks/hyperpod-cluster-stack';
export { MlccInferenceOperatorStack } from './stacks/inference-operator-stack';

// Legacy export for backward compatibility (old single-stack stub)
export { MlccHyperpodStack } from './stack';
