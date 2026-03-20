// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Triton Backend Metadata Registry
 *
 * Stores metadata for each Triton backend, used by PromptRunner and TemplateEngine
 * to adapt prompt flow and template generation per backend.
 *
 * Schema:
 * {
 *   "backendName": {
 *     requiresGpu: boolean,
 *     modelFormats: string[] | null,
 *     modelArtifactName: string | null,
 *     requiresModelName: boolean,
 *     supportsSampleModel: boolean
 *   }
 * }
 */

export default {
    'fil': {
        requiresGpu: false,
        modelFormats: ['xgboost_json', 'xgboost_ubj', 'lightgbm_txt'],
        modelArtifactName: 'xgboost.json',
        requiresModelName: false,
        supportsSampleModel: true
    },
    'onnxruntime': {
        requiresGpu: false,
        modelFormats: ['onnx'],
        modelArtifactName: 'model.onnx',
        requiresModelName: false,
        supportsSampleModel: true
    },
    'tensorflow': {
        requiresGpu: false,
        modelFormats: ['savedmodel'],
        modelArtifactName: 'model.savedmodel/',
        requiresModelName: false,
        supportsSampleModel: true
    },
    'pytorch': {
        requiresGpu: false,
        modelFormats: ['torchscript'],
        modelArtifactName: 'model.pt',
        requiresModelName: false,
        supportsSampleModel: false
    },
    'vllm': {
        requiresGpu: true,
        modelFormats: null,
        modelArtifactName: null,
        requiresModelName: true,
        supportsSampleModel: false
    },
    'tensorrtllm': {
        requiresGpu: true,
        modelFormats: null,
        modelArtifactName: null,
        requiresModelName: true,
        supportsSampleModel: false
    },
    'python': {
        requiresGpu: false,
        modelFormats: ['pkl', 'joblib', 'custom'],
        modelArtifactName: 'model.py',
        requiresModelName: false,
        supportsSampleModel: true
    }
}
