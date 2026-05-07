// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Comment Generator Unit Tests
 * 
 * Tests specific examples and edge cases for the CommentGenerator class.
 * 
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import CommentGenerator from '../../src/lib/comment-generator.js';

describe('CommentGenerator', () => {
    let commentGenerator;

    beforeEach(() => {
        commentGenerator = new CommentGenerator();
    });

    describe('generateDockerfileComments', () => {
        it('should generate all comment sections', () => {
            const config = {
                framework: 'vllm',
                version: '0.3.0',
                accelerator: {
                    type: 'cuda',
                    version: '12.1'
                },
                envVars: {
                    VLLM_VERSION: '0.3.0',
                    MAX_MODEL_LEN: '4096'
                },
                configSources: ['Framework_Registry'],
                validationLevel: 'tested',
                instanceType: 'ml.g5.xlarge',
                inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-3-1',
                generatedAt: '2024-01-26'
            };

            const comments = commentGenerator.generateDockerfileComments(config);

            // Verify all sections are present
            assert.ok(comments.acceleratorInfo, 'Accelerator info should be present');
            assert.ok(comments.envVarExplanations, 'Env var explanations should be present');
            assert.ok(comments.validationInfo, 'Validation info should be present');
            assert.ok(comments.troubleshooting, 'Troubleshooting should be present');
            assert.ok(comments.chatTemplate, 'Chat template comment should be present');
        });

        it('should include framework and version in accelerator comment', () => {
            const config = {
                framework: 'tensorrt-llm',
                version: '0.8.0',
                accelerator: {
                    type: 'cuda',
                    version: '12.1'
                }
            };

            const comments = commentGenerator.generateDockerfileComments(config);

            assert.ok(comments.acceleratorInfo.includes('tensorrt-llm'));
            assert.ok(comments.acceleratorInfo.includes('0.8.0'));
        });

        it('should include validation level in comments', () => {
            const config = {
                framework: 'vllm',
                version: '0.3.0',
                accelerator: { type: 'cuda', version: '12.1' },
                validationLevel: 'community-validated',
                configSources: ['Framework_Registry']
            };

            const comments = commentGenerator.generateDockerfileComments(config);

            assert.ok(comments.validationInfo.includes('community-validated'));
        });
    });

    describe('generateDeploymentComments', () => {
        it('should generate all deployment comment sections', () => {
            const config = {
                framework: 'vllm',
                version: '0.3.0',
                instanceType: 'ml.g5.xlarge',
                inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-3-1',
                accelerator: {
                    type: 'cuda',
                    version: '12.1'
                },
                configSources: ['Framework_Registry'],
                generatedAt: '2024-01-26'
            };

            const comments = commentGenerator.generateDeploymentComments(config);

            // Verify all sections are present
            assert.ok(comments.header, 'Header should be present');
            assert.ok(comments.amiVersion, 'AMI version comment should be present');
            assert.ok(comments.instanceType, 'Instance type comment should be present');
            assert.ok(comments.configSource, 'Config source comment should be present');
        });

        it('should include framework in deployment header', () => {
            const config = {
                framework: 'sglang',
                version: '0.2.0',
                instanceType: 'ml.g5.xlarge',
                generatedAt: '2024-01-26'
            };

            const comments = commentGenerator.generateDeploymentComments(config);

            assert.ok(comments.header.includes('sglang'));
            assert.ok(comments.header.includes('0.2.0'));
        });

        it('should include AMI version in comments', () => {
            const config = {
                framework: 'vllm',
                version: '0.3.0',
                inferenceAmiVersion: 'al2-ami-sagemaker-inference-gpu-3-1',
                accelerator: {
                    type: 'cuda',
                    version: '12.1'
                }
            };

            const comments = commentGenerator.generateDeploymentComments(config);

            assert.ok(comments.amiVersion.includes('al2-ami-sagemaker-inference-gpu-3-1'));
        });
    });

    describe('generateAcceleratorComment', () => {
        it('should include accelerator type and version', () => {
            const config = {
                framework: 'vllm',
                version: '0.3.0',
                accelerator: {
                    type: 'cuda',
                    version: '12.1'
                }
            };

            const comment = commentGenerator.generateAcceleratorComment(config);

            assert.ok(comment.includes('cuda'));
            assert.ok(comment.includes('12.1'));
        });

        it('should include validation results if present', () => {
            const config = {
                framework: 'vllm',
                version: '0.3.0',
                accelerator: {
                    type: 'cuda',
                    version: '12.1'
                },
                validationResults: {
                    accelerator: {
                        compatible: true,
                        info: 'Using CUDA 12.1'
                    }
                }
            };

            const comment = commentGenerator.generateAcceleratorComment(config);

            assert.ok(comment.includes('✓ Compatible'));
            assert.ok(comment.includes('Using CUDA 12.1'));
        });

        it('should include warning if validation has issues', () => {
            const config = {
                framework: 'vllm',
                version: '0.3.0',
                accelerator: {
                    type: 'cuda',
                    version: '12.1'
                },
                validationResults: {
                    accelerator: {
                        compatible: false,
                        error: 'Version mismatch'
                    }
                }
            };

            const comment = commentGenerator.generateAcceleratorComment(config);

            assert.ok(comment.includes('⚠ Issues detected'));
            assert.ok(comment.includes('Version mismatch'));
        });

        it('should handle missing accelerator gracefully', () => {
            const config = {
                framework: 'vllm',
                version: '0.3.0'
            };

            const comment = commentGenerator.generateAcceleratorComment(config);

            assert.ok(comment.includes('No accelerator requirements'));
        });
    });

    describe('generateEnvVarComments', () => {
        it('should group environment variables by category', () => {
            const config = {
                framework: 'vllm',
                envVars: {
                    CUDA_VISIBLE_DEVICES: '0',
                    VLLM_VERSION: '0.3.0',
                    MAX_MEMORY: '16GB',
                    BATCH_SIZE: '8'
                },
                configSources: ['Framework_Registry']
            };

            const comments = commentGenerator.generateEnvVarComments(config);

            // Should have multiple categories
            assert.ok(Object.keys(comments).length > 0);
            
            // Each category should have comments
            Object.values(comments).forEach(comment => {
                assert.ok(typeof comment === 'string');
                assert.ok(comment.length > 0);
            });
        });

        it('should include source attribution', () => {
            const config = {
                framework: 'vllm',
                envVars: {
                    VLLM_VERSION: '0.3.0'
                },
                configSources: ['Framework_Registry']
            };

            const comments = commentGenerator.generateEnvVarComments(config);
            const allComments = Object.values(comments).join('\n');

            assert.ok(allComments.includes('Source:'));
        });

        it('should handle empty env vars', () => {
            const config = {
                framework: 'vllm',
                envVars: {},
                configSources: []
            };

            const comments = commentGenerator.generateEnvVarComments(config);

            assert.ok(comments.general);
            assert.ok(comments.general.includes('No environment variables'));
        });

        it('should include warnings for memory-related variables', () => {
            const config = {
                framework: 'vllm',
                envVars: {
                    GPU_MEMORY_UTILIZATION: '0.9'
                },
                configSources: ['Framework_Registry']
            };

            const comments = commentGenerator.generateEnvVarComments(config);
            const allComments = Object.values(comments).join('\n');

            // Should include warning about memory settings
            assert.ok(allComments.toLowerCase().includes('memory') || 
                     allComments.toLowerCase().includes('adjust'));
        });
    });

    describe('generateValidationComment', () => {
        it('should include configuration sources', () => {
            const config = {
                configSources: ['Framework_Registry', 'Model_Registry'],
                validationLevel: 'tested'
            };

            const comment = commentGenerator.generateValidationComment(config);

            assert.ok(comment.includes('Framework_Registry'));
            assert.ok(comment.includes('Model_Registry'));
        });

        it('should include validation level explanation', () => {
            const config = {
                configSources: ['Framework_Registry'],
                validationLevel: 'experimental'
            };

            const comment = commentGenerator.generateValidationComment(config);

            assert.ok(comment.includes('experimental'));
            assert.ok(comment.toLowerCase().includes('experimental') || 
                     comment.toLowerCase().includes('caution'));
        });

        it('should include validation results if present', () => {
            const config = {
                configSources: ['Framework_Registry'],
                validationLevel: 'tested',
                validationResults: {
                    envVars: {
                        validated: true,
                        methods: ['known-flags-registry']
                    }
                }
            };

            const comment = commentGenerator.generateValidationComment(config);

            assert.ok(comment.includes('Validated'));
        });
    });

    describe('generateTroubleshootingTips', () => {
        it('should include framework-specific tips', () => {
            const config = {
                framework: 'vllm',
                accelerator: {
                    type: 'cuda',
                    version: '12.1'
                }
            };

            const tips = commentGenerator.generateTroubleshootingTips(config);

            assert.ok(tips.includes('vllm') || tips.toLowerCase().includes('oom'));
        });

        it('should include accelerator-specific tips', () => {
            const config = {
                framework: 'vllm',
                accelerator: {
                    type: 'cuda',
                    version: '12.1'
                }
            };

            const tips = commentGenerator.generateTroubleshootingTips(config);

            assert.ok(tips.includes('CUDA') || tips.includes('nvidia-smi'));
        });

        it('should include general tips', () => {
            const config = {
                framework: 'vllm',
                accelerator: {
                    type: 'cuda',
                    version: '12.1'
                }
            };

            const tips = commentGenerator.generateTroubleshootingTips(config);

            assert.ok(tips.includes('CloudWatch') || tips.includes('logs'));
        });

        it('should handle Neuron SDK accelerator', () => {
            const config = {
                framework: 'transformers',
                accelerator: {
                    type: 'neuron',
                    version: '2.15.0'
                }
            };

            const tips = commentGenerator.generateTroubleshootingTips(config);

            assert.ok(tips.includes('Neuron') || tips.includes('neuron'));
        });
    });

    describe('generateChatTemplateComment', () => {
        it('should indicate when chat template is configured', () => {
            const config = {
                chatTemplate: '{% for message in messages %}...',
                chatTemplateSource: 'HuggingFace_Hub_API'
            };

            const comment = commentGenerator.generateChatTemplateComment(config);

            assert.ok(comment.includes('HuggingFace_Hub_API'));
            assert.ok(comment.includes('Source:'));
        });

        it('should indicate when chat template is not configured', () => {
            const config = {
                chatTemplate: null
            };

            const comment = commentGenerator.generateChatTemplateComment(config);

            assert.ok(comment.includes('Not configured') || 
                     comment.includes('not configured'));
            assert.ok(comment.toLowerCase().includes('manual'));
        });

        it('should mention Model_Registry as source when applicable', () => {
            const config = {
                chatTemplate: 'template-string',
                chatTemplateSource: 'Model_Registry'
            };

            const comment = commentGenerator.generateChatTemplateComment(config);

            assert.ok(comment.includes('Model_Registry'));
        });
    });

    describe('generateConfigSourceComment', () => {
        it('should list all configuration sources', () => {
            const config = {
                configSources: ['Framework_Registry', 'HuggingFace_Hub_API', 'Model_Registry']
            };

            const comment = commentGenerator.generateConfigSourceComment(config);

            assert.ok(comment.includes('Framework_Registry'));
            assert.ok(comment.includes('HuggingFace_Hub_API'));
            assert.ok(comment.includes('Model_Registry'));
        });

        it('should indicate default configuration when no sources', () => {
            const config = {
                configSources: []
            };

            const comment = commentGenerator.generateConfigSourceComment(config);

            assert.ok(comment.includes('Default') || comment.includes('default'));
        });
    });

    describe('generateInstanceTypeComment', () => {
        it('should include instance type and hardware', () => {
            const config = {
                instanceType: 'ml.g5.xlarge',
                instanceHardware: 'NVIDIA A10G'
            };

            const comment = commentGenerator.generateInstanceTypeComment(config);

            assert.ok(comment.includes('ml.g5.xlarge'));
            assert.ok(comment.includes('NVIDIA A10G'));
        });

        it('should include recommended alternatives if present', () => {
            const config = {
                instanceType: 'ml.g5.xlarge',
                recommendedInstanceTypes: ['ml.g5.2xlarge', 'ml.g5.4xlarge', 'ml.g5.12xlarge']
            };

            const comment = commentGenerator.generateInstanceTypeComment(config);

            assert.ok(comment.includes('ml.g5.2xlarge'));
            assert.ok(comment.includes('ml.g5.4xlarge'));
        });

        it('should handle missing instance type', () => {
            const config = {};

            const comment = commentGenerator.generateInstanceTypeComment(config);

            assert.ok(comment.includes('Not specified') || 
                     comment.includes('not specified'));
        });
    });
});
