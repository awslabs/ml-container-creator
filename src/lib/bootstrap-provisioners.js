// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Handles AWS resource provisioning for bootstrap (IAM role, ECR, S3 buckets).
 * Delegates back to the BootstrapCommandHandler instance for shared helpers.
 */
export default class BootstrapProvisioners {
    constructor(handler) {
        this.handler = handler;
    }

    /**
     * Create or reuse the SageMaker execution IAM role.
     * @param {object} options - Parsed CLI options
     * @returns {Promise<string>} Role ARN
     */
    async _setupIamRole(_options) {
        const roleName = 'mlcc-sagemaker-execution-role';

        // Define trust policy for SageMaker
        const trustPolicy = {
            Version: '2012-10-17',
            Statement: [
                {
                    Effect: 'Allow',
                    Principal: {
                        Service: 'sagemaker.amazonaws.com'
                    },
                    Action: 'sts:AssumeRole'
                }
            ]
        };

        // Define execution policy with least-privilege permissions
        const executionPolicy = {
            Version: '2012-10-17',
            Statement: [
                {
                    Sid: 'SageMakerEndpoints',
                    Effect: 'Allow',
                    Action: [
                        'sagemaker:CreateEndpoint',
                        'sagemaker:CreateEndpointConfig',
                        'sagemaker:CreateModel',
                        'sagemaker:CreateInferenceComponent',
                        'sagemaker:UpdateEndpoint',
                        'sagemaker:UpdateEndpointWeightsAndCapacities',
                        'sagemaker:UpdateInferenceComponent',
                        'sagemaker:DeleteEndpoint',
                        'sagemaker:DeleteEndpointConfig',
                        'sagemaker:DeleteModel',
                        'sagemaker:DeleteInferenceComponent',
                        'sagemaker:DescribeEndpoint',
                        'sagemaker:DescribeEndpointConfig',
                        'sagemaker:DescribeModel',
                        'sagemaker:DescribeInferenceComponent',
                        'sagemaker:ListInferenceComponents',
                        'sagemaker:InvokeEndpoint',
                        'sagemaker:InvokeEndpointAsync'
                    ],
                    Resource: '*'
                },
                {
                    Sid: 'SageMakerBenchmarking',
                    Effect: 'Allow',
                    Action: [
                        'sagemaker:CreateAIBenchmarkJob',
                        'sagemaker:DescribeAIBenchmarkJob',
                        'sagemaker:ListAIBenchmarkJobs',
                        'sagemaker:StopAIBenchmarkJob',
                        'sagemaker:DeleteAIBenchmarkJob',
                        'sagemaker:CreateAIWorkloadConfig',
                        'sagemaker:DescribeAIWorkloadConfig',
                        'sagemaker:ListAIWorkloadConfigs',
                        'sagemaker:DeleteAIWorkloadConfig'
                    ],
                    Resource: '*'
                },
                {
                    Sid: 'ECRPull',
                    Effect: 'Allow',
                    Action: [
                        'ecr:GetAuthorizationToken',
                        'ecr:BatchCheckLayerAvailability',
                        'ecr:GetDownloadUrlForLayer',
                        'ecr:BatchGetImage'
                    ],
                    Resource: 'arn:aws:ecr:*:*:repository/ml-container-creator'
                },
                {
                    Sid: 'ECRAuth',
                    Effect: 'Allow',
                    Action: 'ecr:GetAuthorizationToken',
                    Resource: '*'
                },
                {
                    Sid: 'CloudWatchLogs',
                    Effect: 'Allow',
                    Action: [
                        'logs:CreateLogGroup',
                        'logs:CreateLogStream',
                        'logs:PutLogEvents'
                    ],
                    Resource: 'arn:aws:logs:*:*:*'
                },
                {
                    Sid: 'S3ModelRead',
                    Effect: 'Allow',
                    Action: [
                        's3:GetObject',
                        's3:PutObject',
                        's3:AbortMultipartUpload',
                        's3:ListBucket'
                    ],
                    Resource: [
                        'arn:aws:s3:::ml-container-creator-*',
                        'arn:aws:s3:::ml-container-creator-*/*'
                    ]
                },
                {
                    Sid: 'SNSPublish',
                    Effect: 'Allow',
                    Action: 'sns:Publish',
                    Resource: 'arn:aws:sns:*:*:ml-container-creator-*'
                },
                {
                    Sid: 'SecretsManagerBenchmark',
                    Effect: 'Allow',
                    Action: [
                        'secretsmanager:CreateSecret',
                        'secretsmanager:PutSecretValue',
                        'secretsmanager:GetSecretValue',
                        'secretsmanager:DescribeSecret'
                    ],
                    Resource: 'arn:aws:secretsmanager:*:*:secret:ml-container-creator/*'
                },
                {
                    Sid: 'QuotaAndAvailability',
                    Effect: 'Allow',
                    Action: [
                        'service-quotas:GetServiceQuota',
                        'service-quotas:ListServiceQuotas',
                        'sagemaker:ListTrainingPlans',
                        'sagemaker:DescribeTrainingPlan',
                        'sagemaker:ListEndpoints'
                    ],
                    Resource: '*'
                }
            ]
        };

        // Check if role already exists
        const roleExists = this.handler._resourceExists(
            `iam get-role --role-name ${roleName}`,
            this.handler._currentProfile
        );

        if (roleExists) {
            const existingRole = this.handler._execAws(
                `iam get-role --role-name ${roleName}`,
                this.handler._currentProfile
            );
            const roleArn = existingRole.Role.Arn;
            console.log(`  ✅ IAM role "${roleName}" already exists — reused`);

            // Always update the inline policy and tags to ensure they're current
            try {
                const execPolicyFile = this.handler._writeJsonTempFile(executionPolicy, 'exec-policy');
                this.handler._execAws(
                    `iam put-role-policy --role-name ${roleName} --policy-name mlcc-execution-policy --policy-document ${execPolicyFile}`,
                    this.handler._currentProfile
                );
                console.log('  ✅ IAM policy "mlcc-execution-policy" — updated');
            } catch (err) {
                console.log(`  ⚠️  Could not update inline policy: ${err.message}`);
            }

            try {
                const tags = this._buildResourceTags();
                this.handler._execAws(
                    `iam tag-role --role-name ${roleName} --tags ${this.handler._formatTagsForCli(tags)}`,
                    this.handler._currentProfile
                );
                console.log('  ✅ IAM role tags — updated');
            } catch (err) {
                console.log(`  ⚠️  Could not update role tags: ${err.message}`);
            }

            return roleArn;
        }

        // Display policies to user before creation
        console.log('\n  Trust Policy:');
        console.log(JSON.stringify(trustPolicy, null, 2));
        console.log('\n  Execution Policy:');
        console.log(JSON.stringify(executionPolicy, null, 2));
        console.log('');

        try {
            // Create the IAM role — write policy to temp file to avoid shell escaping issues
            const trustPolicyFile = this.handler._writeJsonTempFile(trustPolicy, 'trust-policy');
            const createRoleResult = this.handler._execAws(
                `iam create-role --role-name ${roleName} --assume-role-policy-document ${trustPolicyFile}`,
                this.handler._currentProfile
            );
            const roleArn = createRoleResult.Role.Arn;

            // Attach inline execution policy
            const execPolicyFile = this.handler._writeJsonTempFile(executionPolicy, 'exec-policy');
            this.handler._execAws(
                `iam put-role-policy --role-name ${roleName} --policy-name mlcc-execution-policy --policy-document ${execPolicyFile}`,
                this.handler._currentProfile
            );

            // Apply resource tags
            const tags = this._buildResourceTags();
            this.handler._execAws(
                `iam tag-role --role-name ${roleName} --tags ${this.handler._formatTagsForCli(tags)}`,
                this.handler._currentProfile
            );

            console.log(`  ✅ IAM role "${roleName}" — created`);
            return roleArn;
        } catch (error) {
            const errorMessage = error.message || '';
            if (errorMessage.includes('AccessDenied') || errorMessage.includes('UnauthorizedAccess')) {
                console.log('  ⚠️  Permission denied for iam:CreateRole. Please provide an existing role ARN.');
                const { roleArn } = await this.handler._promptFn([{
                    type: 'input',
                    name: 'roleArn',
                    message: 'Enter an existing IAM role ARN for SageMaker execution:'
                }]);
                return roleArn;
            }
            throw error;
        }
    }

    /**
     * Create or reuse the ECR repository.
     * @returns {Promise<string>} ECR repository name
     */
    async _setupEcrRepository() {
        const repoName = 'ml-container-creator';

        // Check if repository already exists
        const repoExists = this.handler._resourceExists(
            `ecr describe-repositories --repository-names ${repoName} --region ${this.handler._currentRegion}`,
            this.handler._currentProfile
        );

        if (repoExists) {
            console.log(`  ✅ ECR repository "${repoName}" already exists — reused`);
            return repoName;
        }

        // Build resource tags
        const tags = this._buildResourceTags();

        // Create the ECR repository with image scanning and AES256 encryption
        this.handler._execAws(
            `ecr create-repository --repository-name ${repoName} --image-scanning-configuration scanOnPush=true --encryption-configuration encryptionType=AES256 --region ${this.handler._currentRegion} --tags ${this.handler._formatTagsForCli(tags)}`,
            this.handler._currentProfile
        );

        // Apply lifecycle policy to expire untagged images after 30 days
        const lifecyclePolicy = {
            rules: [
                {
                    rulePriority: 1,
                    description: 'Expire untagged images after 30 days',
                    selection: {
                        tagStatus: 'untagged',
                        countType: 'sinceImagePushed',
                        countUnit: 'days',
                        countNumber: 30
                    },
                    action: {
                        type: 'expire'
                    }
                }
            ]
        };

        const lifecyclePolicyFile = this.handler._writeJsonTempFile(lifecyclePolicy, 'ecr-lifecycle');
        this.handler._execAws(
            `ecr put-lifecycle-policy --repository-name ${repoName} --lifecycle-policy-text ${lifecyclePolicyFile} --region ${this.handler._currentRegion}`,
            this.handler._currentProfile
        );

        console.log(`  ✅ ECR repository "${repoName}" — created`);
        return repoName;
    }

    // _setupS3Buckets() / _createS3Bucket() were REMOVED (bucket consolidation
    // R1.6). They imperatively created untracked ml-container-creator-{benchmark,
    // async,batch} buckets that no flow read. Every MLCC bucket is now declared in
    // its bootstrap stack's buckets.json and owned by CloudFormation; nothing in
    // the CLI creates buckets imperatively.
    /**
     * Verify AWS CLI v2 is installed. Returns true if v2 is detected, false otherwise.
     * @returns {boolean}
     */
    _verifyCliV2() {
        try {
            const versionOutput = execSync('aws --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
            if (!versionOutput.includes('aws-cli/2')) {
                console.log(`  ❌ AWS CLI v2 is required. Detected: ${versionOutput.split(' ')[0]}`);
                console.log('  Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html');
                console.log('  Some features (benchmarking, newer SageMaker APIs) require CLI v2.\n');
                return false;
            }
            return true;
        } catch {
            console.log('  ❌ AWS CLI not found.');
            console.log('  Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html\n');
            return false;
        }
    }

    // provisionAiRegistryHub() was REMOVED in BL123. The BL122 spike proved the
    // high-level ai_registry SDK computes its own hub (`AiRegistry-<region>-<account>`)
    // and cannot be pointed at a branded `mlcc-registry-<account>` hub, and that
    // Studio visibility comes from the `domain_id` tag — not hub choice. MLCC no
    // longer provisions or targets a branded hub; datasets/evaluators use the
    // SDK's native hub (see templates/do/lib/python/ai_registry_native.py).

    /**
     * Build the standard resource tag set.
     * @returns {Array<{Key: string, Value: string}>} Tag array
     */
    _buildResourceTags() {
        const packageJsonPath = path.resolve(__dirname, '../../package.json');
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        return [
            { Key: 'mlcc:managed-by', Value: 'ml-container-creator' },
            { Key: 'mlcc:created-by', Value: 'bootstrap' },
            { Key: 'mlcc:version', Value: packageJson.version }
        ];
    }
}
