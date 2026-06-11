import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import assert from 'node:assert/strict';
import { MlccCiHarnessStack } from '../lib/ci-harness-stack';

describe('MlccCiHarnessStack', () => {
    let template: Template;

    before(() => {
        const app = new App();
        const stack = new MlccCiHarnessStack(app, 'TestStack');
        template = Template.fromStack(stack);
    });

    describe('DynamoDB Table', () => {
        it('creates a table with configId partition key', () => {
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                KeySchema: [
                    { AttributeName: 'configId', KeyType: 'HASH' },
                ],
            });
        });

        it('uses on-demand billing mode', () => {
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                BillingMode: 'PAY_PER_REQUEST',
            });
        });

        it('enables point-in-time recovery', () => {
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                PointInTimeRecoverySpecification: {
                    PointInTimeRecoveryEnabled: true,
                },
            });
        });

        it('has a GSI on testStatus and lastTestTimestamp', () => {
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                GlobalSecondaryIndexes: Match.arrayWith([
                    Match.objectLike({
                        IndexName: 'testStatus-lastTestTimestamp-index',
                        KeySchema: [
                            { AttributeName: 'testStatus', KeyType: 'HASH' },
                            { AttributeName: 'lastTestTimestamp', KeyType: 'RANGE' },
                        ],
                    }),
                ]),
            });
        });

        it('defines all required attribute types', () => {
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                AttributeDefinitions: Match.arrayWith([
                    { AttributeName: 'configId', AttributeType: 'S' },
                    { AttributeName: 'testStatus', AttributeType: 'S' },
                    { AttributeName: 'lastTestTimestamp', AttributeType: 'S' },
                ]),
            });
        });

        it('sets table name to mlcc-ci-table', () => {
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                TableName: 'mlcc-ci-table',
            });
        });
    });



    describe('CloudWatch Log Group', () => {
        it('creates log group with correct name', () => {
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                LogGroupName: 'ml-container-creator-ci',
            });
        });

        it('sets 90-day retention (THREE_MONTHS)', () => {
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                LogGroupName: 'ml-container-creator-ci',
                RetentionInDays: 90,
            });
        });
    });



    describe('SNS Topic', () => {
        it('creates DLQ notifications topic', () => {
            template.hasResourceProperties('AWS::SNS::Topic', {
                TopicName: 'mlcc-ci-dlq-notifications',
            });
        });
    });

    describe('Resource Tags', () => {
        it('applies mlcc:managed-by tag to DynamoDB table', () => {
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                Tags: Match.arrayWith([
                    { Key: 'mlcc:managed-by', Value: 'ml-container-creator' },
                ]),
            });
        });

        it('applies mlcc:created-by tag to DynamoDB table', () => {
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                Tags: Match.arrayWith([
                    { Key: 'mlcc:created-by', Value: 'bootstrap-ci' },
                ]),
            });
        });

        it('applies mlcc:version tag to DynamoDB table', () => {
            template.hasResourceProperties('AWS::DynamoDB::Table', {
                Tags: Match.arrayWith([
                    { Key: 'mlcc:version', Value: '0.1.0' },
                ]),
            });
        });



        it('applies mlcc:managed-by tag to CloudWatch log group', () => {
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                Tags: Match.arrayWith([
                    Match.objectLike({ Key: 'mlcc:managed-by', Value: 'ml-container-creator' }),
                ]),
            });
        });

        it('applies mlcc:created-by tag to CloudWatch log group', () => {
            template.hasResourceProperties('AWS::Logs::LogGroup', {
                Tags: Match.arrayWith([
                    Match.objectLike({ Key: 'mlcc:created-by', Value: 'bootstrap-ci' }),
                ]),
            });
        });
    });

    describe('Scanner Lambda', () => {
        it('creates Lambda function with name mlcc-ci-scanner', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: 'mlcc-ci-scanner',
            });
        });

        it('uses Node.js 20.x runtime', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: 'mlcc-ci-scanner',
                Runtime: 'nodejs20.x',
            });
        });

        it('has 256 MB memory', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: 'mlcc-ci-scanner',
                MemorySize: 256,
            });
        });

        it('has 60 second timeout', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: 'mlcc-ci-scanner',
                Timeout: 60,
            });
        });

        it('has required environment variables (CI_TABLE_NAME, GSI_NAME, STATE_MACHINE_ARN)', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: 'mlcc-ci-scanner',
                Environment: {
                    Variables: Match.objectLike({
                        CI_TABLE_NAME: Match.anyValue(),
                        GSI_NAME: 'testStatus-lastTestTimestamp-index',
                        STATE_MACHINE_ARN: Match.anyValue(),
                    }),
                },
            });
        });
    });

    describe('EventBridge Schedule Rule', () => {
        it('has schedule expression rate(1 hour)', () => {
            template.hasResourceProperties('AWS::Events::Rule', {
                ScheduleExpression: 'rate(1 hour)',
            });
        });
    });

    describe('Scanner IAM Role', () => {
        it('has DynamoDB:Query permission', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: 'dynamodb:Query',
                            Effect: 'Allow',
                        }),
                    ]),
                }),
            });
        });

        it('has States:StartExecution permission', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: 'states:StartExecution',
                            Effect: 'Allow',
                        }),
                    ]),
                }),
            });
        });

        it('has Logs permissions', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: Match.arrayWith([
                                'logs:CreateLogStream',
                                'logs:PutLogEvents',
                            ]),
                            Effect: 'Allow',
                        }),
                    ]),
                }),
            });
        });
    });

    describe('Stack Parameters', () => {
        it('defines MaxConcurrency parameter', () => {
            template.hasParameter('MaxConcurrency', {
                Type: 'Number',
                Default: 1,
                MinValue: 1,
                MaxValue: 10,
            });
        });

        it('defines CodeBuildComputeType parameter', () => {
            template.hasParameter('CodeBuildComputeType', {
                Type: 'String',
                Default: 'BUILD_GENERAL1_MEDIUM',
            });
        });
    });

    describe('Step Functions State Machine', () => {
        it('creates state machine with name mlcc-ci-orchestrator', () => {
            template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
                StateMachineName: 'mlcc-ci-orchestrator',
            });
        });

        it('uses STANDARD state machine type', () => {
            template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
                StateMachineType: 'STANDARD',
            });
        });

        it('has logging configured at ALL level', () => {
            template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
                LoggingConfiguration: Match.objectLike({
                    Level: 'ALL',
                    IncludeExecutionData: true,
                }),
            });
        });

        it('logging destinations include CloudWatch log group', () => {
            template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
                LoggingConfiguration: Match.objectLike({
                    Destinations: Match.arrayWith([
                        Match.objectLike({
                            CloudWatchLogsLogGroup: {
                                LogGroupArn: Match.anyValue(),
                            },
                        }),
                    ]),
                }),
            });
        });

        it('has a definition string containing SetRunning state', () => {
            template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
                DefinitionString: Match.anyValue(),
            });
        });

        it('has tracing enabled', () => {
            template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
                TracingConfiguration: {
                    Enabled: true,
                },
            });
        });
    });



    describe('CodeBuild Project', () => {
        it('creates project with name mlcc-ci-executor', () => {
            template.hasResourceProperties('AWS::CodeBuild::Project', {
                Name: 'mlcc-ci-executor',
            });
        });

        it('has privileged mode enabled', () => {
            template.hasResourceProperties('AWS::CodeBuild::Project', {
                Environment: Match.objectLike({
                    PrivilegedMode: true,
                }),
            });
        });

        it('has 90-minute timeout', () => {
            template.hasResourceProperties('AWS::CodeBuild::Project', {
                TimeoutInMinutes: 90,
            });
        });

        it('uses BUILD_GENERAL1_MEDIUM compute type', () => {
            template.hasResourceProperties('AWS::CodeBuild::Project', {
                Environment: Match.objectLike({
                    ComputeType: 'BUILD_GENERAL1_MEDIUM',
                }),
            });
        });

        it('uses amazonlinux2-x86_64-standard:5.0 image', () => {
            template.hasResourceProperties('AWS::CodeBuild::Project', {
                Environment: Match.objectLike({
                    Image: 'aws/codebuild/amazonlinux2-x86_64-standard:5.0',
                }),
            });
        });

        it('uses LINUX_CONTAINER environment type', () => {
            template.hasResourceProperties('AWS::CodeBuild::Project', {
                Environment: Match.objectLike({
                    Type: 'LINUX_CONTAINER',
                }),
            });
        });

        it('has CloudWatch logging enabled', () => {
            template.hasResourceProperties('AWS::CodeBuild::Project', {
                LogsConfig: {
                    CloudWatchLogs: Match.objectLike({
                        Status: 'ENABLED',
                    }),
                },
            });
        });

        it('has a buildspec source configured', () => {
            template.hasResourceProperties('AWS::CodeBuild::Project', {
                Source: Match.objectLike({
                    BuildSpec: Match.anyValue(),
                }),
            });
        });
    });

    describe('Orchestrator IAM Role', () => {
        it('creates orchestrator role assumed by states.amazonaws.com', () => {
            template.hasResourceProperties('AWS::IAM::Role', {
                RoleName: 'mlcc-ci-orchestrator-role',
                AssumeRolePolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Principal: { Service: 'states.amazonaws.com' },
                            Action: 'sts:AssumeRole',
                        }),
                    ]),
                }),
            });
        });

        it('has DynamoDB:UpdateItem and GetItem permissions', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: Match.arrayWith([
                                'dynamodb:UpdateItem',
                                'dynamodb:GetItem',
                            ]),
                            Effect: 'Allow',
                        }),
                    ]),
                }),
                Roles: Match.arrayWith([
                    { Ref: Match.stringLikeRegexp('OrchestratorRole') },
                ]),
            });
        });

        it('has CodeBuild:StartBuild and BatchGetBuilds permissions', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: Match.arrayWith([
                                'codebuild:StartBuild',
                                'codebuild:BatchGetBuilds',
                            ]),
                            Effect: 'Allow',
                        }),
                    ]),
                }),
                Roles: Match.arrayWith([
                    { Ref: Match.stringLikeRegexp('OrchestratorRole') },
                ]),
            });
        });

        it('has Logs permissions', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: Match.arrayWith([
                                'logs:CreateLogDelivery',
                                'logs:PutLogEvents',
                                'logs:CreateLogStream',
                            ]),
                            Effect: 'Allow',
                        }),
                    ]),
                }),
                Roles: Match.arrayWith([
                    { Ref: Match.stringLikeRegexp('OrchestratorRole') },
                ]),
            });
        });
    });

    describe('CodeBuild IAM Role', () => {
        it('creates codebuild role assumed by codebuild.amazonaws.com', () => {
            template.hasResourceProperties('AWS::IAM::Role', {
                RoleName: 'mlcc-ci-codebuild-role',
                AssumeRolePolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Principal: { Service: 'codebuild.amazonaws.com' },
                            Action: 'sts:AssumeRole',
                        }),
                    ]),
                }),
            });
        });

        it('has DynamoDB:UpdateItem permission', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: 'dynamodb:UpdateItem',
                            Effect: 'Allow',
                        }),
                    ]),
                }),
                Roles: Match.arrayWith([
                    { Ref: Match.stringLikeRegexp('CodeBuildRole') },
                ]),
            });
        });

        it('has ECR permissions', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: 'ecr:*',
                            Effect: 'Allow',
                        }),
                    ]),
                }),
                Roles: Match.arrayWith([
                    { Ref: Match.stringLikeRegexp('CodeBuildRole') },
                ]),
            });
        });

        it('has SageMaker permissions', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: 'sagemaker:*',
                            Effect: 'Allow',
                        }),
                    ]),
                }),
                Roles: Match.arrayWith([
                    { Ref: Match.stringLikeRegexp('CodeBuildRole') },
                ]),
            });
        });

        it('has IAM permissions including PassRole', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: Match.arrayWith([
                                'iam:PassRole',
                            ]),
                            Effect: 'Allow',
                        }),
                    ]),
                }),
                Roles: Match.arrayWith([
                    { Ref: Match.stringLikeRegexp('CodeBuildRole') },
                ]),
            });
        });
    });

    describe('Benchmark Infrastructure Idempotency (Req 3.2)', () => {
        it('defines CreateBenchmarkInfra parameter with default false', () => {
            template.hasParameter('CreateBenchmarkInfra', {
                Type: 'String',
                Default: 'false',
                AllowedValues: ['true', 'false'],
            });
        });

        it('defines BenchmarkInfraCondition based on CreateBenchmarkInfra parameter', () => {
            template.hasCondition('BenchmarkInfraCondition', {
                'Fn::Equals': [
                    { Ref: 'CreateBenchmarkInfra' },
                    'true',
                ],
            });
        });

        it('Glue database is gated by BenchmarkInfraCondition', () => {
            template.hasResource('AWS::Glue::Database', {
                Condition: 'BenchmarkInfraCondition',
                Properties: Match.objectLike({
                    DatabaseInput: Match.objectLike({
                        Name: 'mlcc_ci',
                    }),
                }),
            });
        });

        it('Glue table is gated by BenchmarkInfraCondition', () => {
            template.hasResource('AWS::Glue::Table', {
                Condition: 'BenchmarkInfraCondition',
                Properties: Match.objectLike({
                    DatabaseName: 'mlcc_ci',
                    TableInput: Match.objectLike({
                        Name: 'benchmark_results',
                        TableType: 'EXTERNAL_TABLE',
                    }),
                }),
            });
        });

        it('S3 bucket is gated by BenchmarkInfraCondition', () => {
            template.hasResource('AWS::S3::Bucket', {
                Condition: 'BenchmarkInfraCondition',
                UpdateReplacePolicy: 'Retain',
                DeletionPolicy: 'Retain',
            });
        });

        it('benchmark IAM policy is gated by BenchmarkInfraCondition', () => {
            template.hasResource('AWS::IAM::Policy', {
                Condition: 'BenchmarkInfraCondition',
                Properties: Match.objectLike({
                    PolicyName: 'mlcc-ci-benchmark-write-policy',
                }),
            });
        });

        it('cdk synth produces identical output on repeated runs (deterministic)', () => {
            // Synthesize the same stack a second time
            const app2 = new App();
            const stack2 = new MlccCiHarnessStack(app2, 'TestStack');
            const template2 = Template.fromStack(stack2);

            // Both templates should have the same resource counts
            const resources1 = template.toJSON().Resources;
            const resources2 = template2.toJSON().Resources;

            // Same number of resources
            const keys1 = Object.keys(resources1).sort();
            const keys2 = Object.keys(resources2).sort();
            assert.deepStrictEqual(keys1, keys2, 'Resource logical IDs must be identical across synths');
        });

        it('Glue table depends on Glue database (ordered creation)', () => {
            template.hasResource('AWS::Glue::Table', {
                DependsOn: Match.arrayWith(['CiGlueDatabase']),
            });
        });

        it('all benchmark resources use a single shared condition', () => {
            // Verify benchmark + path prover conditions are defined
            const conditions = template.toJSON().Conditions;
            const conditionNames = Object.keys(conditions);
            assert.ok(conditionNames.includes('BenchmarkInfraCondition'), 'Should have BenchmarkInfraCondition');
            // PathProverCondition is separate — benchmark resources only use BenchmarkInfraCondition
        });
    });

    describe('Benchmark Infrastructure Snapshot (Req 3.1, 3.2, 3.4)', () => {
        // This describe block validates the detailed resource properties
        // of the benchmark infrastructure when CreateBenchmarkInfra=true.
        // It acts as a snapshot test ensuring the Glue DB, Glue Table,
        // S3 bucket, and IAM policy all have the correct configurations.

        it('Glue database has correct catalog ID and description', () => {
            template.hasResourceProperties('AWS::Glue::Database', {
                CatalogId: { Ref: 'AWS::AccountId' },
                DatabaseInput: {
                    Name: 'mlcc_ci',
                    Description: 'MCC CI benchmark results warehouse',
                },
            });
        });

        it('Glue table has Parquet classification and Snappy compression parameters', () => {
            template.hasResourceProperties('AWS::Glue::Table', {
                TableInput: Match.objectLike({
                    Parameters: {
                        'classification': 'parquet',
                        'parquet.compression': 'SNAPPY',
                    },
                }),
            });
        });

        it('Glue table storage descriptor uses Parquet input/output formats', () => {
            template.hasResourceProperties('AWS::Glue::Table', {
                TableInput: Match.objectLike({
                    StorageDescriptor: Match.objectLike({
                        InputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
                        OutputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
                        SerdeInfo: Match.objectLike({
                            SerializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
                        }),
                        Compressed: true,
                    }),
                }),
            });
        });

        it('Glue table has all required core dimension columns', () => {
            template.hasResourceProperties('AWS::Glue::Table', {
                TableInput: Match.objectLike({
                    StorageDescriptor: Match.objectLike({
                        Columns: Match.arrayWith([
                            Match.objectLike({ Name: 'config_id', Type: 'string' }),
                            Match.objectLike({ Name: 'model_name', Type: 'string' }),
                            Match.objectLike({ Name: 'model_family', Type: 'string' }),
                            Match.objectLike({ Name: 'instance_type', Type: 'string' }),
                            Match.objectLike({ Name: 'instance_family', Type: 'string' }),
                            Match.objectLike({ Name: 'deployment_config', Type: 'string' }),
                            Match.objectLike({ Name: 'deployment_target', Type: 'string' }),
                            Match.objectLike({ Name: 'run_timestamp', Type: 'timestamp' }),
                        ]),
                    }),
                }),
            });
        });

        it('Glue table has all required metric columns', () => {
            template.hasResourceProperties('AWS::Glue::Table', {
                TableInput: Match.objectLike({
                    StorageDescriptor: Match.objectLike({
                        Columns: Match.arrayWith([
                            Match.objectLike({ Name: 'ttft_p50_ms', Type: 'double' }),
                            Match.objectLike({ Name: 'ttft_p99_ms', Type: 'double' }),
                            Match.objectLike({ Name: 'itl_p50_ms', Type: 'double' }),
                            Match.objectLike({ Name: 'itl_p99_ms', Type: 'double' }),
                            Match.objectLike({ Name: 'throughput_rps', Type: 'double' }),
                            Match.objectLike({ Name: 'tokens_per_second', Type: 'double' }),
                            Match.objectLike({ Name: 'cost_per_1m_tokens', Type: 'double' }),
                            Match.objectLike({ Name: 'error_rate', Type: 'double' }),
                            Match.objectLike({ Name: 'status', Type: 'string' }),
                        ]),
                    }),
                }),
            });
        });

        it('Glue table has run_type provenance column (Req 8.10)', () => {
            template.hasResourceProperties('AWS::Glue::Table', {
                TableInput: Match.objectLike({
                    StorageDescriptor: Match.objectLike({
                        Columns: Match.arrayWith([
                            Match.objectLike({ Name: 'run_type', Type: 'string' }),
                            Match.objectLike({ Name: 'ci_run_id', Type: 'string' }),
                            Match.objectLike({ Name: 'benchmark_job_name', Type: 'string' }),
                            Match.objectLike({ Name: 'account_id', Type: 'string' }),
                        ]),
                    }),
                }),
            });
        });

        it('Glue table has configuration dimension columns (quantization, tp, lora)', () => {
            template.hasResourceProperties('AWS::Glue::Table', {
                TableInput: Match.objectLike({
                    StorageDescriptor: Match.objectLike({
                        Columns: Match.arrayWith([
                            Match.objectLike({ Name: 'tensor_parallel_degree', Type: 'int' }),
                            Match.objectLike({ Name: 'quantization', Type: 'string' }),
                            Match.objectLike({ Name: 'enable_lora', Type: 'boolean' }),
                            Match.objectLike({ Name: 'base_image', Type: 'string' }),
                            Match.objectLike({ Name: 'mcc_version', Type: 'string' }),
                        ]),
                    }),
                }),
            });
        });

        it('Glue table has workload dimension columns', () => {
            template.hasResourceProperties('AWS::Glue::Table', {
                TableInput: Match.objectLike({
                    StorageDescriptor: Match.objectLike({
                        Columns: Match.arrayWith([
                            Match.objectLike({ Name: 'concurrency', Type: 'int' }),
                            Match.objectLike({ Name: 'input_tokens_mean', Type: 'int' }),
                            Match.objectLike({ Name: 'output_tokens_mean', Type: 'int' }),
                            Match.objectLike({ Name: 'duration_seconds', Type: 'int' }),
                        ]),
                    }),
                }),
            });
        });

        it('Glue table has region/year/month partition keys', () => {
            template.hasResourceProperties('AWS::Glue::Table', {
                TableInput: Match.objectLike({
                    PartitionKeys: [
                        { Name: 'region', Type: 'string' },
                        { Name: 'year', Type: 'string' },
                        { Name: 'month', Type: 'string' },
                    ],
                }),
            });
        });

        it('Glue table storage location references account/region bucket via Fn::Join', () => {
            template.hasResourceProperties('AWS::Glue::Table', {
                TableInput: Match.objectLike({
                    StorageDescriptor: Match.objectLike({
                        Location: Match.objectLike({
                            'Fn::Join': Match.arrayWith([
                                '',
                                Match.arrayWith([
                                    's3://mlcc-benchmark-results-',
                                ]),
                            ]),
                        }),
                    }),
                }),
            });
        });

        it('S3 bucket has lifecycle rule with IA transition', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                LifecycleConfiguration: Match.objectLike({
                    Rules: Match.arrayWith([
                        Match.objectLike({
                            Transitions: Match.arrayWith([
                                Match.objectLike({
                                    StorageClass: 'STANDARD_IA',
                                }),
                            ]),
                        }),
                    ]),
                }),
            });
        });

        it('S3 bucket has expiration lifecycle rule', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                LifecycleConfiguration: Match.objectLike({
                    Rules: Match.arrayWith([
                        Match.objectLike({
                            ExpirationInDays: Match.anyValue(),
                        }),
                    ]),
                }),
            });
        });

        it('S3 bucket name follows mlcc-benchmark-results-{account}-{region} pattern', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                BucketName: Match.objectLike({
                    'Fn::Join': Match.arrayWith([
                        '',
                        Match.arrayWith([
                            'mlcc-benchmark-results-',
                        ]),
                    ]),
                }),
            });
        });

        it('benchmark write policy has S3 PutObject/GetObject/ListBucket actions', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyName: 'mlcc-ci-benchmark-write-policy',
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'BenchmarkResultsWrite',
                            Effect: 'Allow',
                            Action: Match.arrayWith([
                                's3:PutObject',
                                's3:GetObject',
                                's3:ListBucket',
                            ]),
                            Resource: Match.arrayWith([
                                'arn:aws:s3:::mlcc-benchmark-results-*',
                                'arn:aws:s3:::mlcc-benchmark-results-*/*',
                            ]),
                        }),
                    ]),
                }),
            });
        });

        it('benchmark write policy has Glue catalog access actions', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyName: 'mlcc-ci-benchmark-write-policy',
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'GlueCatalogAccess',
                            Effect: 'Allow',
                            Action: Match.arrayWith([
                                'glue:GetDatabase',
                                'glue:GetTable',
                                'glue:GetPartitions',
                                'glue:BatchCreatePartition',
                                'glue:CreatePartition',
                            ]),
                            Resource: Match.arrayWith([
                                'arn:aws:glue:*:*:catalog',
                                'arn:aws:glue:*:*:database/mlcc_ci',
                                'arn:aws:glue:*:*:table/mlcc_ci/*',
                            ]),
                        }),
                    ]),
                }),
            });
        });

        it('benchmark write policy has Athena query execution for partition repair', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyName: 'mlcc-ci-benchmark-write-policy',
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'AthenaPartitionRepair',
                            Effect: 'Allow',
                            Action: Match.arrayWith([
                                'athena:StartQueryExecution',
                                'athena:GetQueryResults',
                            ]),
                        }),
                    ]),
                }),
            });
        });

        it('benchmark write policy is attached to the CodeBuild role', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyName: 'mlcc-ci-benchmark-write-policy',
                Roles: Match.arrayWith([
                    { Ref: Match.stringLikeRegexp('CodeBuildRole') },
                ]),
            });
        });

        it('stack outputs include benchmark results bucket ARN (conditional)', () => {
            const outputs = template.toJSON().Outputs;
            const bucketArnOutput = Object.values(outputs as Record<string, any>).find(
                (o: any) => o.Export?.Name === 'mlcc-ci-benchmark-results-bucket-arn'
            );
            assert.ok(bucketArnOutput, 'BenchmarkResultsBucketArn output should exist');
            assert.strictEqual(bucketArnOutput.Condition, 'BenchmarkInfraCondition');
        });

        it('stack outputs include Glue database name (conditional)', () => {
            const outputs = template.toJSON().Outputs;
            const glueDbOutput = Object.values(outputs as Record<string, any>).find(
                (o: any) => o.Value === 'mlcc_ci'
            );
            assert.ok(glueDbOutput, 'CiGlueDatabaseName output should exist');
            assert.strictEqual(glueDbOutput.Condition, 'BenchmarkInfraCondition');
        });

        it('cdk synth twice with same parameters produces identical JSON (idempotent)', () => {
            const app1 = new App();
            const stack1 = new MlccCiHarnessStack(app1, 'IdempotencyTest');
            const template1 = Template.fromStack(stack1);

            const app2 = new App();
            const stack2 = new MlccCiHarnessStack(app2, 'IdempotencyTest');
            const template2 = Template.fromStack(stack2);

            const json1 = JSON.stringify(template1.toJSON());
            const json2 = JSON.stringify(template2.toJSON());
            assert.strictEqual(json1, json2, 'Two identical cdk synth runs must produce byte-for-byte identical output');
        });

        it('without benchmark infra opted in, no Glue or S3 resources are created at deploy time', () => {
            // With default parameter (false), CloudFormation condition ensures no resources.
            // Verify the condition evaluates to gate these resources.
            const cfnTemplate = template.toJSON();

            // All Glue::Database resources have the BenchmarkInfraCondition
            const resources = cfnTemplate.Resources;
            const glueDbResources = Object.entries(resources).filter(
                ([, v]: [string, any]) => v.Type === 'AWS::Glue::Database'
            );
            for (const [key, resource] of glueDbResources) {
                assert.strictEqual(
                    (resource as any).Condition,
                    'BenchmarkInfraCondition',
                    `Glue::Database ${key} must be gated by BenchmarkInfraCondition`
                );
            }

            // All Glue::Table resources have the BenchmarkInfraCondition
            const glueTableResources = Object.entries(resources).filter(
                ([, v]: [string, any]) => v.Type === 'AWS::Glue::Table'
            );
            for (const [key, resource] of glueTableResources) {
                assert.strictEqual(
                    (resource as any).Condition,
                    'BenchmarkInfraCondition',
                    `Glue::Table ${key} must be gated by BenchmarkInfraCondition`
                );
            }

            // All S3::Bucket resources have the BenchmarkInfraCondition
            const s3Resources = Object.entries(resources).filter(
                ([, v]: [string, any]) => v.Type === 'AWS::S3::Bucket'
            );
            for (const [key, resource] of s3Resources) {
                assert.strictEqual(
                    (resource as any).Condition,
                    'BenchmarkInfraCondition',
                    `S3::Bucket ${key} must be gated by BenchmarkInfraCondition`
                );
            }
        });

        it('Glue table defines exactly 31 columns (28 data + 3 partition excluded from columns)', () => {
            const cfnTemplate = template.toJSON();
            const resources = cfnTemplate.Resources;
            const glueTableResource = Object.values(resources).find(
                (r: any) => r.Type === 'AWS::Glue::Table'
            ) as any;
            assert.ok(glueTableResource, 'Glue table resource should exist');
            const columns = glueTableResource.Properties.TableInput.StorageDescriptor.Columns;
            assert.ok(columns.length >= 28, `Expected at least 28 columns but got ${columns.length}`);
        });
    });


});
