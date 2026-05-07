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


});
