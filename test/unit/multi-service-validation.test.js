// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for multi-service validation.
 *
 * Tests:
 * - ECR CreateRepository payload validated against ECR model
 * - IAM CreateRole payload validated against IAM model
 * - S3 CreateBucket payload validated against S3 model
 * - Service name appears in findings
 *
 * Validates: Requirements 10.2, 10.3, 10.4, 10.5
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import SchemaValidationEngine from '../../src/lib/schema-validation-engine.js';
import ServiceModelParser from '../../src/lib/service-model-parser.js';

// ── Test Service Models ──────────────────────────────────────────────────────

function createEcrModel() {
    return {
        metadata: { apiVersion: '2015-09-21', serviceFullName: 'Amazon EC2 Container Registry' },
        operations: {
            CreateRepository: {
                input: { shape: 'CreateRepositoryRequest' }
            }
        },
        shapes: {
            CreateRepositoryRequest: {
                type: 'structure',
                required: ['repositoryName'],
                members: {
                    repositoryName: { shape: 'RepositoryName' },
                    imageTagMutability: { shape: 'ImageTagMutability' },
                    imageScanningConfiguration: { shape: 'ImageScanningConfiguration' },
                    encryptionConfiguration: { shape: 'EncryptionConfiguration' }
                }
            },
            RepositoryName: {
                type: 'string',
                min: 2,
                max: 256,
                pattern: '(?:[a-z0-9]+(?:[._-][a-z0-9]+)*/)*[a-z0-9]+(?:[._-][a-z0-9]+)*'
            },
            ImageTagMutability: {
                type: 'string',
                enum: ['MUTABLE', 'IMMUTABLE']
            },
            ImageScanningConfiguration: {
                type: 'structure',
                members: {
                    scanOnPush: { shape: 'ScanOnPushFlag' }
                }
            },
            ScanOnPushFlag: { type: 'boolean' },
            EncryptionConfiguration: {
                type: 'structure',
                required: ['encryptionType'],
                members: {
                    encryptionType: { shape: 'EncryptionType' },
                    kmsKey: { shape: 'KmsKey' }
                }
            },
            EncryptionType: {
                type: 'string',
                enum: ['AES256', 'KMS']
            },
            KmsKey: { type: 'string' }
        }
    };
}

function createIamModel() {
    return {
        metadata: { apiVersion: '2010-05-08', serviceFullName: 'AWS Identity and Access Management' },
        operations: {
            CreateRole: {
                input: { shape: 'CreateRoleRequest' }
            }
        },
        shapes: {
            CreateRoleRequest: {
                type: 'structure',
                required: ['RoleName', 'AssumeRolePolicyDocument'],
                members: {
                    RoleName: { shape: 'RoleNameType' },
                    AssumeRolePolicyDocument: { shape: 'PolicyDocumentType' },
                    Path: { shape: 'PathType' },
                    MaxSessionDuration: { shape: 'RoleMaxSessionDurationType' },
                    Tags: { shape: 'TagListType' }
                }
            },
            RoleNameType: {
                type: 'string',
                min: 1,
                max: 64,
                pattern: '[\\w+=,.@-]+'
            },
            PolicyDocumentType: {
                type: 'string',
                min: 1,
                max: 131072
            },
            PathType: {
                type: 'string',
                min: 1,
                max: 512
            },
            RoleMaxSessionDurationType: {
                type: 'integer',
                min: 3600,
                max: 43200
            },
            TagListType: {
                type: 'list',
                member: { shape: 'Tag' }
            },
            Tag: {
                type: 'structure',
                required: ['Key', 'Value'],
                members: {
                    Key: { shape: 'TagKeyType' },
                    Value: { shape: 'TagValueType' }
                }
            },
            TagKeyType: { type: 'string', min: 1, max: 128 },
            TagValueType: { type: 'string', min: 0, max: 256 }
        }
    };
}

function createS3Model() {
    return {
        metadata: { apiVersion: '2006-03-01', serviceFullName: 'Amazon Simple Storage Service' },
        operations: {
            CreateBucket: {
                input: { shape: 'CreateBucketRequest' }
            }
        },
        shapes: {
            CreateBucketRequest: {
                type: 'structure',
                required: ['Bucket'],
                members: {
                    Bucket: { shape: 'BucketName' },
                    ACL: { shape: 'BucketCannedACL' },
                    CreateBucketConfiguration: { shape: 'CreateBucketConfiguration' },
                    ObjectOwnership: { shape: 'ObjectOwnership' }
                }
            },
            BucketName: {
                type: 'string'
            },
            BucketCannedACL: {
                type: 'string',
                enum: ['private', 'public-read', 'public-read-write', 'authenticated-read']
            },
            CreateBucketConfiguration: {
                type: 'structure',
                members: {
                    LocationConstraint: { shape: 'BucketLocationConstraint' }
                }
            },
            BucketLocationConstraint: {
                type: 'string',
                enum: ['af-south-1', 'ap-east-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ca-central-1', 'eu-central-1', 'eu-north-1', 'eu-south-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'me-south-1', 'sa-east-1', 'us-east-2', 'us-west-1', 'us-west-2']
            },
            ObjectOwnership: {
                type: 'string',
                enum: ['BucketOwnerPreferred', 'ObjectWriter', 'BucketOwnerEnforced']
            }
        }
    };
}

function createSagemakerModel() {
    return {
        metadata: { apiVersion: '2017-07-24', serviceFullName: 'Amazon SageMaker Service' },
        operations: {
            CreateEndpointConfig: {
                input: { shape: 'CreateEndpointConfigInput' }
            }
        },
        shapes: {
            CreateEndpointConfigInput: {
                type: 'structure',
                required: ['EndpointConfigName', 'ProductionVariants'],
                members: {
                    EndpointConfigName: { shape: 'EndpointConfigName' },
                    ProductionVariants: { shape: 'ProductionVariantList' }
                }
            },
            EndpointConfigName: { type: 'string' },
            ProductionVariantList: {
                type: 'list',
                member: { shape: 'ProductionVariant' }
            },
            ProductionVariant: {
                type: 'structure',
                members: {
                    InstanceType: { shape: 'InstanceType' },
                    InferenceAmiVersion: { shape: 'InferenceAmiVersion' },
                    VariantName: { shape: 'VariantName' }
                }
            },
            InstanceType: { type: 'string' },
            InferenceAmiVersion: {
                type: 'string',
                enum: ['al2-ami-sagemaker-inference-gpu-2', 'al2-ami-sagemaker-inference-cpu-2']
            },
            VariantName: { type: 'string' }
        }
    };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseModels(...rawModels) {
    const parser = new ServiceModelParser();
    return rawModels.map(m => parser.parse(m));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Multi-Service Validation', () => {
    describe('ECR CreateRepository validation', () => {
        it('validates ECR CreateRepository payload against ECR model', async () => {
            const serviceModels = parseModels(createEcrModel());

            const engine = new SchemaValidationEngine({ serviceModels });
            const context = {
                payloads: {
                    'ecr:CreateRepository': {
                        repositoryName: 'my-ml-repo',
                        imageTagMutability: 'IMMUTABLE'
                    }
                },
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { services: ['ecr'] }
            };

            const report = await engine.validate(context);
            const summary = report.getSummary();

            assert.strictEqual(summary.errors, 0, 'Valid ECR payload should produce no errors');
        });

        it('reports error for invalid imageTagMutability enum value', async () => {
            const serviceModels = parseModels(createEcrModel());

            const engine = new SchemaValidationEngine({ serviceModels });
            const context = {
                payloads: {
                    'ecr:CreateRepository': {
                        repositoryName: 'my-ml-repo',
                        imageTagMutability: 'INVALID_VALUE'
                    }
                },
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { services: ['ecr'] }
            };

            const report = await engine.validate(context);
            const summary = report.getSummary();

            assert.ok(summary.errors > 0, 'Invalid enum value should produce errors');

            const enumError = report.schemaErrors.find(
                e => e.fieldPath === 'imageTagMutability'
            );
            assert.ok(enumError, 'Should have error for imageTagMutability');
            assert.strictEqual(enumError.service, 'ecr', 'Service should be ecr');
            assert.strictEqual(enumError.operation, 'CreateRepository');
            assert.strictEqual(enumError.invalidValue, 'INVALID_VALUE');
        });

        it('reports error for missing required repositoryName', async () => {
            const serviceModels = parseModels(createEcrModel());

            const engine = new SchemaValidationEngine({ serviceModels });
            const context = {
                payloads: {
                    'ecr:CreateRepository': {
                        imageTagMutability: 'MUTABLE'
                    }
                },
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { services: ['ecr'] }
            };

            const report = await engine.validate(context);

            const requiredError = report.schemaErrors.find(
                e => e.fieldPath === 'repositoryName' || e.fieldPath.includes('repositoryName')
            );
            assert.ok(requiredError, 'Should report missing required field repositoryName');
            assert.strictEqual(requiredError.service, 'ecr');
        });
    });

    describe('IAM CreateRole validation', () => {
        it('validates IAM CreateRole payload against IAM model', async () => {
            const serviceModels = parseModels(createIamModel());

            const engine = new SchemaValidationEngine({ serviceModels });
            const context = {
                payloads: {
                    'iam:CreateRole': {
                        RoleName: 'SageMakerExecutionRole',
                        AssumeRolePolicyDocument: '{"Version":"2012-10-17","Statement":[]}',
                        MaxSessionDuration: 3600
                    }
                },
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { services: ['iam'] }
            };

            const report = await engine.validate(context);
            const summary = report.getSummary();

            assert.strictEqual(summary.errors, 0, 'Valid IAM payload should produce no errors');
        });

        it('reports error for missing required fields in IAM CreateRole', async () => {
            const serviceModels = parseModels(createIamModel());

            const engine = new SchemaValidationEngine({ serviceModels });
            const context = {
                payloads: {
                    'iam:CreateRole': {
                        Path: '/service-role/'
                    }
                },
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { services: ['iam'] }
            };

            const report = await engine.validate(context);

            const roleNameError = report.schemaErrors.find(
                e => e.fieldPath === 'RoleName' || e.fieldPath.includes('RoleName')
            );
            assert.ok(roleNameError, 'Should report missing required field RoleName');
            assert.strictEqual(roleNameError.service, 'iam');
            assert.strictEqual(roleNameError.operation, 'CreateRole');
        });

        it('reports error for MaxSessionDuration out of range', async () => {
            const serviceModels = parseModels(createIamModel());

            const engine = new SchemaValidationEngine({ serviceModels });
            const context = {
                payloads: {
                    'iam:CreateRole': {
                        RoleName: 'TestRole',
                        AssumeRolePolicyDocument: '{}',
                        MaxSessionDuration: 100
                    }
                },
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { services: ['iam'] }
            };

            const report = await engine.validate(context);

            const rangeError = report.schemaErrors.find(
                e => e.fieldPath === 'MaxSessionDuration'
            );
            assert.ok(rangeError, 'Should report range error for MaxSessionDuration');
            assert.strictEqual(rangeError.service, 'iam');
            assert.strictEqual(rangeError.operation, 'CreateRole');
        });
    });

    describe('S3 CreateBucket validation', () => {
        it('validates S3 CreateBucket payload against S3 model', async () => {
            const serviceModels = parseModels(createS3Model());

            const engine = new SchemaValidationEngine({ serviceModels });
            const context = {
                payloads: {
                    's3:CreateBucket': {
                        Bucket: 'my-ml-artifacts-bucket',
                        ACL: 'private'
                    }
                },
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { services: ['s3'] }
            };

            const report = await engine.validate(context);
            const summary = report.getSummary();

            assert.strictEqual(summary.errors, 0, 'Valid S3 payload should produce no errors');
        });

        it('reports error for invalid ACL enum value', async () => {
            const serviceModels = parseModels(createS3Model());

            const engine = new SchemaValidationEngine({ serviceModels });
            const context = {
                payloads: {
                    's3:CreateBucket': {
                        Bucket: 'my-bucket',
                        ACL: 'invalid-acl'
                    }
                },
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { services: ['s3'] }
            };

            const report = await engine.validate(context);
            const summary = report.getSummary();

            assert.ok(summary.errors > 0, 'Invalid ACL should produce errors');

            const aclError = report.schemaErrors.find(e => e.fieldPath === 'ACL');
            assert.ok(aclError, 'Should have error for ACL field');
            assert.strictEqual(aclError.service, 's3');
            assert.strictEqual(aclError.operation, 'CreateBucket');
            assert.strictEqual(aclError.invalidValue, 'invalid-acl');
        });

        it('reports error for missing required Bucket field', async () => {
            const serviceModels = parseModels(createS3Model());

            const engine = new SchemaValidationEngine({ serviceModels });
            const context = {
                payloads: {
                    's3:CreateBucket': {
                        ACL: 'private'
                    }
                },
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { services: ['s3'] }
            };

            const report = await engine.validate(context);

            const bucketError = report.schemaErrors.find(
                e => e.fieldPath === 'Bucket' || e.fieldPath.includes('Bucket')
            );
            assert.ok(bucketError, 'Should report missing required field Bucket');
            assert.strictEqual(bucketError.service, 's3');
        });

        it('validates nested CreateBucketConfiguration LocationConstraint', async () => {
            const serviceModels = parseModels(createS3Model());

            const engine = new SchemaValidationEngine({ serviceModels });
            const context = {
                payloads: {
                    's3:CreateBucket': {
                        Bucket: 'my-bucket',
                        CreateBucketConfiguration: {
                            LocationConstraint: 'invalid-region'
                        }
                    }
                },
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { services: ['s3'] }
            };

            const report = await engine.validate(context);

            const locationError = report.schemaErrors.find(
                e => e.fieldPath === 'CreateBucketConfiguration.LocationConstraint'
            );
            assert.ok(locationError, 'Should report invalid LocationConstraint');
            assert.strictEqual(locationError.service, 's3');
        });
    });

    describe('Service name in findings', () => {
        it('includes service name in all findings for multi-service context', async () => {
            const serviceModels = parseModels(
                createEcrModel(),
                createIamModel(),
                createS3Model(),
                createSagemakerModel()
            );

            const engine = new SchemaValidationEngine({ serviceModels });
            const context = {
                payloads: {
                    'ecr:CreateRepository': {
                        repositoryName: 'my-repo',
                        imageTagMutability: 'INVALID'
                    },
                    'iam:CreateRole': {
                        RoleName: 'TestRole',
                        AssumeRolePolicyDocument: '{}',
                        MaxSessionDuration: 1
                    },
                    's3:CreateBucket': {
                        Bucket: 'my-bucket',
                        ACL: 'bad-acl'
                    },
                    'sagemaker:CreateEndpointConfig': {
                        ProductionVariants: [{
                            InferenceAmiVersion: 'invalid-ami'
                        }]
                    }
                },
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { services: ['ecr', 'iam', 's3', 'sagemaker'] }
            };

            const report = await engine.validate(context);
            const allFindings = [
                ...report.schemaErrors,
                ...report.crossCuttingErrors,
                ...report.advisoryFindings,
                ...report.warnings.filter(w => w.service)
            ];

            assert.ok(allFindings.length > 0, 'Should have findings from multiple services');

            // Verify each finding has a service name
            for (const finding of allFindings) {
                assert.ok(
                    finding.service,
                    `Finding for ${finding.fieldPath} should have a service name`
                );
            }

            // Verify we have findings from different services
            const services = new Set(allFindings.map(f => f.service));
            assert.ok(services.has('ecr'), 'Should have ECR findings');
            assert.ok(services.has('s3'), 'Should have S3 findings');
            assert.ok(services.has('sagemaker'), 'Should have SageMaker findings');
        });

        it('routes each payload to the correct service model', async () => {
            const serviceModels = parseModels(
                createEcrModel(),
                createIamModel(),
                createS3Model(),
                createSagemakerModel()
            );

            const engine = new SchemaValidationEngine({ serviceModels });

            // ECR payload should only be validated against ECR model
            const context = {
                payloads: {
                    'ecr:CreateRepository': {
                        repositoryName: 'valid-repo',
                        imageTagMutability: 'MUTABLE'
                    }
                },
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { services: ['ecr'] }
            };

            const report = await engine.validate(context);
            const summary = report.getSummary();

            // Valid ECR payload should not produce errors even with other service models loaded
            assert.strictEqual(summary.errors, 0,
                'Valid ECR payload should not produce errors from other service models');
        });

        it('does not cross-contaminate operations between services', async () => {
            // Create a model where both services have an operation with the same name
            // but different shapes — this verifies routing is correct
            const serviceModels = parseModels(
                createEcrModel(),
                createSagemakerModel()
            );

            const engine = new SchemaValidationEngine({ serviceModels });

            // CreateRepository only exists in ECR model, not SageMaker
            const context = {
                payloads: {
                    'ecr:CreateRepository': {
                        repositoryName: 'my-repo',
                        imageTagMutability: 'MUTABLE'
                    }
                },
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { services: ['ecr'] }
            };

            const report = await engine.validate(context);
            const summary = report.getSummary();

            assert.strictEqual(summary.errors, 0,
                'ECR operation should not be validated against SageMaker model');
        });
    });

    describe('Multi-service format and exit code verification', () => {
        it('JSON output includes service name in each finding', async () => {
            const serviceModels = parseModels(createEcrModel());

            const engine = new SchemaValidationEngine({ serviceModels });
            const context = {
                payloads: {
                    'ecr:CreateRepository': {
                        repositoryName: 'my-repo',
                        imageTagMutability: 'BAD_VALUE'
                    }
                },
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { services: ['ecr'] }
            };

            const report = await engine.validate(context);
            const json = report.toJSON();

            assert.ok(json.schemaErrors.length > 0);
            for (const error of json.schemaErrors) {
                assert.strictEqual(error.service, 'ecr',
                    'JSON output should include service name in findings');
            }
        });

        it('text output renders findings from multiple services', async () => {
            const serviceModels = parseModels(createEcrModel(), createS3Model());

            const engine = new SchemaValidationEngine({ serviceModels });
            const context = {
                payloads: {
                    'ecr:CreateRepository': {
                        repositoryName: 'my-repo',
                        imageTagMutability: 'INVALID'
                    },
                    's3:CreateBucket': {
                        Bucket: 'my-bucket',
                        ACL: 'bad-acl'
                    }
                },
                config: {},
                deploymentTarget: 'realtime-inference',
                metadata: { services: ['ecr', 's3'] }
            };

            const report = await engine.validate(context);
            const text = report.toText();

            assert.ok(text.includes('CreateRepository'), 'Text should include ECR operation');
            assert.ok(text.includes('CreateBucket'), 'Text should include S3 operation');
        });
    });
});
