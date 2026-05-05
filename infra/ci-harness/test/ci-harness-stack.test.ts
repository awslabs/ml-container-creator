import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
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

    describe('SQS Queues', () => {
        it('creates CI queue with correct visibility timeout', () => {
            template.hasResourceProperties('AWS::SQS::Queue', {
                QueueName: 'mlcc-ci-queue',
                VisibilityTimeout: 3600,
            });
        });

        it('creates CI queue with 7-day retention', () => {
            template.hasResourceProperties('AWS::SQS::Queue', {
                QueueName: 'mlcc-ci-queue',
                MessageRetentionPeriod: 604800,
            });
        });

        it('creates CI queue with SQS-managed encryption', () => {
            template.hasResourceProperties('AWS::SQS::Queue', {
                QueueName: 'mlcc-ci-queue',
                SqsManagedSseEnabled: true,
            });
        });

        it('creates CI queue with DLQ redrive policy (maxReceiveCount 3)', () => {
            template.hasResourceProperties('AWS::SQS::Queue', {
                QueueName: 'mlcc-ci-queue',
                RedrivePolicy: Match.objectLike({
                    maxReceiveCount: 3,
                }),
            });
        });

        it('creates DLQ with 14-day retention', () => {
            template.hasResourceProperties('AWS::SQS::Queue', {
                QueueName: 'mlcc-ci-dlq',
                MessageRetentionPeriod: 1209600,
            });
        });

        it('creates DLQ with SQS-managed encryption', () => {
            template.hasResourceProperties('AWS::SQS::Queue', {
                QueueName: 'mlcc-ci-dlq',
                SqsManagedSseEnabled: true,
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

    describe('CloudWatch Alarm', () => {
        it('creates DLQ alarm on ApproximateNumberOfMessagesVisible', () => {
            template.hasResourceProperties('AWS::CloudWatch::Alarm', {
                AlarmName: 'mlcc-ci-dlq-messages-visible',
                MetricName: 'ApproximateNumberOfMessagesVisible',
                Threshold: 0,
                ComparisonOperator: 'GreaterThanThreshold',
                EvaluationPeriods: 1,
                TreatMissingData: 'notBreaching',
            });
        });

        it('alarm has a descriptive alarm description', () => {
            template.hasResourceProperties('AWS::CloudWatch::Alarm', {
                AlarmName: 'mlcc-ci-dlq-messages-visible',
                AlarmDescription: Match.stringLikeRegexp('dead-letter queue'),
            });
        });

        it('alarm publishes to SNS topic', () => {
            template.hasResourceProperties('AWS::CloudWatch::Alarm', {
                AlarmName: 'mlcc-ci-dlq-messages-visible',
                AlarmActions: Match.anyValue(),
            });
        });

        it('alarm uses 1-minute period', () => {
            template.hasResourceProperties('AWS::CloudWatch::Alarm', {
                AlarmName: 'mlcc-ci-dlq-messages-visible',
                Period: 60,
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

        it('applies mlcc:managed-by tag to SQS queues', () => {
            const queues = template.findResources('AWS::SQS::Queue');
            const queueLogicalIds = Object.keys(queues);
            // Both CI queue and DLQ should exist
            if (queueLogicalIds.length < 2) {
                throw new Error('Expected at least 2 SQS queues');
            }
            for (const id of queueLogicalIds) {
                const tags = queues[id].Properties?.Tags;
                if (tags) {
                    const hasTag = tags.some(
                        (t: { Key: string; Value: string }) =>
                            t.Key === 'mlcc:managed-by' && t.Value === 'ml-container-creator'
                    );
                    if (!hasTag) {
                        throw new Error(`SQS queue ${id} missing mlcc:managed-by tag`);
                    }
                }
            }
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

        it('has required environment variables (CI_TABLE_NAME, CI_QUEUE_URL, GSI_NAME)', () => {
            template.hasResourceProperties('AWS::Lambda::Function', {
                FunctionName: 'mlcc-ci-scanner',
                Environment: {
                    Variables: Match.objectLike({
                        CI_TABLE_NAME: Match.anyValue(),
                        CI_QUEUE_URL: Match.anyValue(),
                        GSI_NAME: 'testStatus-lastTestTimestamp-index',
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

        it('has SQS:SendMessage permission', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: 'sqs:SendMessage',
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

    describe('EventBridge Pipe', () => {
        it('creates pipe with name mlcc-ci-pipe', () => {
            template.hasResourceProperties('AWS::Pipes::Pipe', {
                Name: 'mlcc-ci-pipe',
            });
        });

        it('has SQS queue as source', () => {
            template.hasResourceProperties('AWS::Pipes::Pipe', {
                Source: Match.anyValue(),
            });
        });

        it('has Step Functions state machine as target', () => {
            template.hasResourceProperties('AWS::Pipes::Pipe', {
                Target: Match.anyValue(),
            });
        });

        it('configures batch size of 1 for sequential processing', () => {
            template.hasResourceProperties('AWS::Pipes::Pipe', {
                SourceParameters: {
                    SqsQueueParameters: {
                        BatchSize: 1,
                    },
                },
            });
        });

        it('uses FIRE_AND_FORGET invocation type for Step Functions target', () => {
            template.hasResourceProperties('AWS::Pipes::Pipe', {
                TargetParameters: {
                    StepFunctionStateMachineParameters: {
                        InvocationType: 'FIRE_AND_FORGET',
                    },
                },
            });
        });

        it('has an IAM role ARN configured', () => {
            template.hasResourceProperties('AWS::Pipes::Pipe', {
                RoleArn: Match.anyValue(),
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

        it('has IAM:PassRole permission', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: 'iam:PassRole',
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

    describe('Pipe IAM Role', () => {
        it('creates pipe role assumed by pipes.amazonaws.com', () => {
            template.hasResourceProperties('AWS::IAM::Role', {
                RoleName: 'mlcc-ci-pipe-role',
                AssumeRolePolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Principal: { Service: 'pipes.amazonaws.com' },
                            Action: 'sts:AssumeRole',
                        }),
                    ]),
                }),
            });
        });

        it('has SQS permissions (ReceiveMessage, DeleteMessage, GetQueueAttributes)', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Action: Match.arrayWith([
                                'sqs:ReceiveMessage',
                                'sqs:DeleteMessage',
                                'sqs:GetQueueAttributes',
                            ]),
                            Effect: 'Allow',
                        }),
                    ]),
                }),
                Roles: Match.arrayWith([
                    { Ref: Match.stringLikeRegexp('PipeRole') },
                ]),
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
                Roles: Match.arrayWith([
                    { Ref: Match.stringLikeRegexp('PipeRole') },
                ]),
            });
        });
    });
});
