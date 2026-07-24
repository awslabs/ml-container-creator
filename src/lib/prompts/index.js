// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Barrel file — re-exports all prompt definitions from phase-based modules.
 */

export {
    deploymentConfigPrompts,
    frameworkPrompts,
    enginePrompts,
    frameworkVersionPrompts,
    frameworkProfilePrompts,
    modelFormatPrompts,
    modelServerPrompts,
    modelProfilePrompts,
    hfTokenPrompts,
    ngcApiKeyPrompts
} from './model-prompts.js';

export {
    modulePrompts,
    loraPrompts,
    benchmarkPrompts
} from './feature-prompts.js';

export {
    infrastructurePrompts,
    infraRegionAndTargetPrompts,
    infraExistingEndpointPrompts,
    infraInstancePrompts,
    infraAsyncPrompts,
    infraBatchTransformPrompts,
    infraHyperPodPrompts,
    infraBuildPrompts,
    baseImageSearchPrompts,
    baseImagePrompts,
    formatImageChoices,
    filterByCudaGeneration,
    getInstanceCudaGeneration,
    instanceCatalogRaw
} from './infrastructure-prompts.js';

export {
    projectPrompts,
    destinationPrompts
} from './project-prompts.js';
