import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * MlccCiHarnessStack defines the CI Integration Harness infrastructure
 * for automated lifecycle testing of ML Container Creator generated projects.
 *
 * Resources:
 * - DynamoDB table (CI_Table) with GSI
 * - Lambda function (Scanner) — starts Step Functions executions directly
 * - EventBridge scheduled rule
 * - Step Functions state machine (CI_Orchestrator)
 * - CodeBuild project (CI_CodeBuild_Project)
 * - CloudWatch log group and alarms
 * - IAM roles with least-privilege policies
 * - SNS topic for alarm notifications
 */
export class MlccCiHarnessStack extends cdk.Stack {
    /** DynamoDB table storing CI test configurations and results */
    public readonly ciTable: dynamodb.Table;

    /** SNS topic for alarm notifications */
    public readonly ciDlqNotificationsTopic: sns.Topic;

    /** CloudWatch log group for all CI harness components */
    public readonly ciLogGroup: logs.LogGroup;

    /** Scanner Lambda function that queries for stale CI records */
    public readonly scannerFunction: NodejsFunction;

    /** EventBridge rule that triggers the Scanner Lambda hourly */
    public readonly scannerScheduleRule: events.Rule;

    /** Step Functions state machine that orchestrates CI test executions */
    public readonly ciOrchestrator: sfn.StateMachine;

    /** IAM role for the Step Functions orchestrator */
    public readonly orchestratorRole: iam.Role;

    /** CodeBuild project that executes the full lifecycle stages */
    public readonly ciCodeBuildProject: codebuild.Project;

    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // Stack-level tags applied to all resources
        cdk.Tags.of(this).add('mlcc:managed-by', 'ml-container-creator');
        cdk.Tags.of(this).add('mlcc:created-by', 'bootstrap-ci');
        cdk.Tags.of(this).add('mlcc:version', '0.1.0');

        // Stack parameters
        const maxConcurrency = new cdk.CfnParameter(this, 'MaxConcurrency', {
            type: 'Number',
            default: 1,
            description: 'Maximum number of parallel CodeBuild executions',
            minValue: 1,
            maxValue: 10,
        });

        const codebuildComputeType = new cdk.CfnParameter(this, 'CodeBuildComputeType', {
            type: 'String',
            default: 'BUILD_GENERAL1_MEDIUM',
            description: 'CodeBuild compute type for CI executor',
            allowedValues: [
                'BUILD_GENERAL1_SMALL',
                'BUILD_GENERAL1_MEDIUM',
                'BUILD_GENERAL1_LARGE',
            ],
        });

        // SNS topic for alarm notifications
        this.ciDlqNotificationsTopic = new sns.Topic(this, 'CiDlqNotificationsTopic', {
            topicName: 'mlcc-ci-dlq-notifications',
        });

        // CloudWatch Log Group for all CI harness components
        this.ciLogGroup = new logs.LogGroup(this, 'CiLogGroup', {
            logGroupName: 'ml-container-creator-ci',
            retention: logs.RetentionDays.THREE_MONTHS,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // DynamoDB CI Table
        this.ciTable = new dynamodb.Table(this, 'CiTable', {
            tableName: 'mlcc-ci-table',
            partitionKey: {
                name: 'configId',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            pointInTimeRecovery: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // GSI for Scanner Lambda to query by testStatus and sort by lastTestTimestamp
        this.ciTable.addGlobalSecondaryIndex({
            indexName: 'testStatus-lastTestTimestamp-index',
            partitionKey: {
                name: 'testStatus',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'lastTestTimestamp',
                type: dynamodb.AttributeType.STRING,
            },
        });

        // Scanner Lambda IAM role with least-privilege permissions
        const scannerRole = new iam.Role(this, 'ScannerRole', {
            roleName: 'mlcc-ci-scanner-role',
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'IAM role for the MLCC CI Scanner Lambda function',
        });

        // DynamoDB:Query on CI_Table and its GSI
        scannerRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['dynamodb:Query'],
            resources: [
                this.ciTable.tableArn,
                `${this.ciTable.tableArn}/index/testStatus-lastTestTimestamp-index`,
            ],
        }));

        // Logs:CreateLogStream and PutLogEvents on the CI log group scanner prefix
        scannerRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'logs:CreateLogStream',
                'logs:PutLogEvents',
            ],
            resources: [
                `${this.ciLogGroup.logGroupArn}:log-stream:scanner/*`,
                this.ciLogGroup.logGroupArn,
            ],
        }));

        // Scanner Lambda function
        this.scannerFunction = new NodejsFunction(this, 'ScannerFunction', {
            functionName: 'mlcc-ci-scanner',
            runtime: lambda.Runtime.NODEJS_20_X,
            memorySize: 256,
            timeout: cdk.Duration.seconds(60),
            entry: path.join(__dirname, '..', 'lambda', 'scanner', 'index.ts'),
            handler: 'handler',
            role: scannerRole,
            environment: {
                CI_TABLE_NAME: this.ciTable.tableName,
                GSI_NAME: 'testStatus-lastTestTimestamp-index',
            },
            logGroup: this.ciLogGroup,
            loggingFormat: lambda.LoggingFormat.TEXT,
            bundling: {
                minify: true,
                sourceMap: true,
            },
        });

        // EventBridge scheduled rule — triggers Scanner Lambda every hour
        this.scannerScheduleRule = new events.Rule(this, 'ScannerScheduleRule', {
            ruleName: 'mlcc-ci-scanner-schedule',
            description: 'Triggers the MLCC CI Scanner Lambda every hour to find stale test records',
            schedule: events.Schedule.rate(cdk.Duration.hours(1)),
        });

        this.scannerScheduleRule.addTarget(new targets.LambdaFunction(this.scannerFunction));

        // Step Functions Orchestrator IAM role
        // Permissions for DynamoDB UpdateItem, Logs, and CodeBuild are defined here.
        this.orchestratorRole = new iam.Role(this, 'OrchestratorRole', {
            roleName: 'mlcc-ci-orchestrator-role',
            assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
            description: 'IAM role for the MLCC CI Orchestrator Step Functions state machine',
        });

        // DynamoDB:UpdateItem on CI_Table for UpdateResults states
        this.orchestratorRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['dynamodb:UpdateItem'],
            resources: [this.ciTable.tableArn],
        }));

        // Logs permissions for state machine execution logging
        this.orchestratorRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'logs:CreateLogDelivery',
                'logs:GetLogDelivery',
                'logs:UpdateLogDelivery',
                'logs:DeleteLogDelivery',
                'logs:ListLogDeliveries',
                'logs:PutResourcePolicy',
                'logs:DescribeResourcePolicies',
                'logs:DescribeLogGroups',
                'logs:PutLogEvents',
                'logs:CreateLogStream',
            ],
            resources: ['*'],
        }));

        // State machine definition using CustomState for SDK integrations
        // Input: { configId, configJson, buildStrategy }

        // RecordStartTime: capture the execution start timestamp
        const recordStartTime = new sfn.Pass(this, 'RecordStartTime', {
            parameters: {
                'configId.$': '$.configId',
                'configJson.$': '$.configJson',
                'buildStrategy.$': '$.buildStrategy',
                'startTime.$': '$$.State.EnteredTime',
            },
        });

        // StartCodeBuild: Start a CodeBuild build with environment variables
        // The CodeBuild project ARN will be updated in Task 3.3 when the project is created.
        // Using a placeholder project name that will be replaced.
        const startCodeBuild = new sfn.CustomState(this, 'StartCodeBuild', {
            stateJson: {
                Type: 'Task',
                Resource: 'arn:aws:states:::codebuild:startBuild',
                Parameters: {
                    ProjectName: 'mlcc-ci-executor',
                    EnvironmentVariablesOverride: [
                        {
                            Name: 'CONFIG_ID',
                            'Value.$': '$.configId',
                            Type: 'PLAINTEXT',
                        },
                        {
                            Name: 'CONFIG_JSON',
                            'Value.$': '$.configJson',
                            Type: 'PLAINTEXT',
                        },
                        {
                            Name: 'BUILD_STRATEGY',
                            'Value.$': '$.buildStrategy',
                            Type: 'PLAINTEXT',
                        },
                        {
                            Name: 'CI_TABLE_NAME',
                            Value: this.ciTable.tableName,
                            Type: 'PLAINTEXT',
                        },
                        {
                            Name: 'CI_LOG_GROUP',
                            Value: this.ciLogGroup.logGroupName,
                            Type: 'PLAINTEXT',
                        },
                    ],
                },
                ResultPath: '$.buildResult',
            },
        });

        // WaitForBuild: Wait 30 seconds before polling build status
        const waitForBuild = new sfn.Wait(this, 'WaitForBuild', {
            time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
        });

        // PollBuildStatus: BatchGetBuilds to check current build status
        const pollBuildStatus = new sfn.CustomState(this, 'PollBuildStatus', {
            stateJson: {
                Type: 'Task',
                Resource: 'arn:aws:states:::aws-sdk:codebuild:batchGetBuilds',
                Parameters: {
                    'Ids.$': 'States.Array($.buildResult.Build.Id)',
                },
                ResultPath: '$.pollResult',
            },
        });

        // CheckTimestamp: Compute elapsed time to detect 90-minute timeout
        const checkTimestamp = new sfn.Pass(this, 'CheckTimestamp', {
            parameters: {
                'configId.$': '$.configId',
                'configJson.$': '$.configJson',
                'buildStrategy.$': '$.buildStrategy',
                'startTime.$': '$.startTime',
                'buildResult.$': '$.buildResult',
                'pollResult.$': '$.pollResult',
                'buildStatus.$': '$.pollResult.Builds[0].BuildStatus',
                'currentTime.$': '$$.State.EnteredTime',
            },
        });

        // HandleTimeout: Set failure status when build exceeds 90 minutes
        const handleTimeout = new sfn.Pass(this, 'HandleTimeout', {
            parameters: {
                'configId.$': '$.configId',
                'configJson.$': '$.configJson',
                'buildStrategy.$': '$.buildStrategy',
                'startTime.$': '$.startTime',
                'testStatus': 'fail-build',
                'errorMessage': 'CodeBuild execution timed out after 90 minutes',
            },
        });

        // SetSuccessResult: Prepare result data for successful/completed builds
        const setSuccessResult = new sfn.Pass(this, 'SetBuildCompleteResult', {
            parameters: {
                'configId.$': '$.configId',
                'configJson.$': '$.configJson',
                'buildStrategy.$': '$.buildStrategy',
                'startTime.$': '$.startTime',
                'buildStatus.$': '$.buildStatus',
                'pollResult.$': '$.pollResult',
            },
        });

        // CheckBuildStatus: Branch on build complete vs still running vs timed out
        const checkBuildStatus = new sfn.Choice(this, 'CheckBuildStatus')
            .when(
                sfn.Condition.stringEquals('$.buildStatus', 'SUCCEEDED'),
                setSuccessResult,
            )
            .when(
                sfn.Condition.stringEquals('$.buildStatus', 'FAILED'),
                setSuccessResult,
            )
            .when(
                sfn.Condition.stringEquals('$.buildStatus', 'STOPPED'),
                setSuccessResult,
            )
            .when(
                sfn.Condition.stringEquals('$.buildStatus', 'TIMED_OUT'),
                handleTimeout,
            )
            .otherwise(waitForBuild);

        // UpdateResults: DynamoDB UpdateItem with final test results
        // For builds that completed (success or failure), the CodeBuild buildspec
        // writes detailed stageResults and testStatus to DynamoDB in its Update stage.
        // This state records orchestrator-level metadata as a fallback — if CodeBuild's
        // post_build phase failed to write, this ensures the record is updated.
        const updateResults = new sfn.CustomState(this, 'UpdateResults', {
            stateJson: {
                Type: 'Task',
                Resource: 'arn:aws:states:::dynamodb:updateItem',
                Parameters: {
                    TableName: this.ciTable.tableName,
                    Key: {
                        configId: { 'S.$': '$.configId' },
                    },
                    UpdateExpression: 'SET lastTestTimestamp = :ts, errorMessage = :err',
                    ExpressionAttributeValues: {
                        ':ts': { 'S.$': '$$.State.EnteredTime' },
                        ':err': {
                            'S.$': "States.Format('Build completed with status: {}', $.buildStatus)",
                        },
                    },
                },
                ResultPath: '$.updateResult',
                Retry: [
                    {
                        ErrorEquals: ['States.ALL'],
                        IntervalSeconds: 2,
                        MaxAttempts: 3,
                        BackoffRate: 2.0,
                    },
                ],
                End: true,
            },
        });

        // UpdateResultsFromTimeout: DynamoDB UpdateItem for timed-out builds
        const updateResultsFromTimeout = new sfn.CustomState(this, 'UpdateResultsFromTimeout', {
            stateJson: {
                Type: 'Task',
                Resource: 'arn:aws:states:::dynamodb:updateItem',
                Parameters: {
                    TableName: this.ciTable.tableName,
                    Key: {
                        configId: { 'S.$': '$.configId' },
                    },
                    UpdateExpression: 'SET testStatus = :status, lastTestTimestamp = :ts, errorMessage = :err',
                    ExpressionAttributeValues: {
                        ':status': { 'S.$': '$.testStatus' },
                        ':ts': { 'S.$': '$$.State.EnteredTime' },
                        ':err': { 'S.$': '$.errorMessage' },
                    },
                },
                ResultPath: '$.updateResult',
                Retry: [
                    {
                        ErrorEquals: ['States.ALL'],
                        IntervalSeconds: 2,
                        MaxAttempts: 3,
                        BackoffRate: 2.0,
                    },
                ],
                End: true,
            },
        });

        // Wire up the state machine chain
        // RecordStartTime → StartCodeBuild → WaitForBuild → PollBuildStatus → CheckTimestamp → CheckBuildStatus
        // CheckBuildStatus branches:
        //   - SUCCEEDED/FAILED/STOPPED → SetBuildCompleteResult → UpdateResults
        //   - TIMED_OUT → HandleTimeout → UpdateResultsFromTimeout
        //   - IN_PROGRESS (otherwise) → WaitForBuild (loop)
        recordStartTime.next(startCodeBuild);
        startCodeBuild.next(waitForBuild);
        waitForBuild.next(pollBuildStatus);
        pollBuildStatus.next(checkTimestamp);
        checkTimestamp.next(checkBuildStatus);
        setSuccessResult.next(updateResults);
        handleTimeout.next(updateResultsFromTimeout);

        // Create the state machine
        this.ciOrchestrator = new sfn.StateMachine(this, 'CiOrchestrator', {
            stateMachineName: 'mlcc-ci-orchestrator',
            stateMachineType: sfn.StateMachineType.STANDARD,
            definitionBody: sfn.DefinitionBody.fromChainable(recordStartTime),
            role: this.orchestratorRole,
            logs: {
                destination: this.ciLogGroup,
                level: sfn.LogLevel.ALL,
                includeExecutionData: true,
            },
            tracingEnabled: true,
        });

        // Grant Scanner Lambda permission to start Step Functions executions directly
        scannerRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['states:StartExecution'],
            resources: [this.ciOrchestrator.stateMachineArn],
        }));

        // Add STATE_MACHINE_ARN env var to Scanner Lambda (defined after state machine)
        this.scannerFunction.addEnvironment('STATE_MACHINE_ARN', this.ciOrchestrator.stateMachineArn);

        // CodeBuild IAM role with permissions for lifecycle execution
        const codebuildRole = new iam.Role(this, 'CodeBuildRole', {
            roleName: 'mlcc-ci-codebuild-role',
            assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
            description: 'IAM role for the MLCC CI CodeBuild executor project',
        });

        // DynamoDB:UpdateItem on CI_Table for writing stage results
        codebuildRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['dynamodb:UpdateItem'],
            resources: [this.ciTable.tableArn],
        }));

        // ECR:* for building and pushing container images
        codebuildRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ecr:*'],
            resources: ['*'],
        }));

        // CodeBuild:* for creating and managing per-project build projects
        codebuildRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['codebuild:*'],
            resources: ['*'],
        }));

        // SageMaker:* for deploying and testing endpoints
        codebuildRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['sagemaker:*'],
            resources: ['*'],
        }));

        // S3:* for model artifact storage
        codebuildRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['s3:*'],
            resources: ['*'],
        }));

        // Logs:* for writing build logs to the CI log group
        codebuildRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['logs:*'],
            resources: ['*'],
        }));

        // IAM permissions for creating per-project CodeBuild service roles and passing roles
        codebuildRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'iam:CreateRole',
                'iam:GetRole',
                'iam:PutRolePolicy',
                'iam:PassRole',
                'iam:TagRole',
                'iam:DeleteRole',
                'iam:DeleteRolePolicy',
            ],
            resources: ['*'],
        }));

        // CodeBuild project: mlcc-ci-executor
        // The buildspec is defined inline as a placeholder. Task 5.1 will create the
        // full buildspec.yml at infra/ci-harness/buildspec.yml. Once a source is
        // configured, this can switch to BuildSpec.fromSourceFilename('buildspec.yml').
        this.ciCodeBuildProject = new codebuild.Project(this, 'CiCodeBuildProject', {
            projectName: 'mlcc-ci-executor',
            description: 'MLCC CI executor — full lifecycle testing with AWS CLI v2',
            role: codebuildRole,
            environment: {
                buildImage: codebuild.LinuxBuildImage.fromCodeBuildImageId(
                    'aws/codebuild/amazonlinux2-x86_64-standard:5.0'
                ),
                computeType: codebuild.ComputeType.MEDIUM,
                privileged: true,
            },
            buildSpec: codebuild.BuildSpec.fromObject({
                version: '0.2',
                env: {
                    variables: {
                        CI_TABLE_NAME: '',
                        CI_LOG_GROUP: '',
                        CONFIG_ID: '',
                        CONFIG_JSON: '',
                        BUILD_STRATEGY: 'codebuild-submit',
                        ROLE_ARN: `arn:aws:iam::${this.account}:role/mlcc-sagemaker-execution-role`,
                    },
                },
                phases: {
                    install: {
                        'runtime-versions': {
                            nodejs: 22,
                        },
                        commands: [
                            'echo "=== MLCC CI Harness - Install Phase ==="',
                            // Install AWS CLI v2 (CodeBuild standard image has v1 which lacks newer SageMaker waiters)
                            'curl -s "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip && unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install --update && rm -rf /tmp/aws /tmp/awscliv2.zip',
                            'npm install -g @aws/ml-container-creator',
                            'BUILD_START_TIME=$(date +%s)',
                            'FIRST_FAILURE=""',
                            'GENERATE_STATUS="skip"',
                            'VALIDATE_STATUS="skip"',
                            'BUILD_STATUS_VAR="skip"',
                            'DEPLOY_TEST_STATUS="skip"',
                            'TEARDOWN_STATUS="skip"',
                            'UPDATE_STATUS="skip"',
                            'BUILD_TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)',
                        ],
                    },
                    pre_build: {
                        commands: [
                            'echo "=== Stage: Generate ==="',
                            'echo "$CONFIG_JSON" > /tmp/ci-config.json && chmod 644 /tmp/ci-config.json',
                            'export CI_PROJECT_DIR="/tmp/ci-project"',
                            'rm -rf "$CI_PROJECT_DIR"',
                            'ml-container-creator --config /tmp/ci-config.json --skip-prompts --project-dir "$CI_PROJECT_DIR" && chmod +x "$CI_PROJECT_DIR"/do/* && GENERATE_STATUS="pass" || { GENERATE_STATUS="fail"; FIRST_FAILURE="generate"; }',
                        ],
                    },
                    build: {
                        commands: [
                            'export CI_PROJECT_DIR="/tmp/ci-project"',
                            'echo "=== Stage: Build ==="',
                            'if [ -z "$FIRST_FAILURE" ]; then cd "$CI_PROJECT_DIR" && if [ "$BUILD_STRATEGY" = "docker-in-docker" ]; then ./do/build && ./do/push; else ./do/submit; fi && BUILD_STATUS_VAR="pass" || { BUILD_STATUS_VAR="fail"; FIRST_FAILURE="build"; }; fi',
                            'echo "=== Stage: Deploy_Test ==="',
                            'if [ -z "$FIRST_FAILURE" ]; then cd "$CI_PROJECT_DIR" && ./do/deploy && ./do/test && DEPLOY_TEST_STATUS="pass" || { DEPLOY_TEST_STATUS="fail"; FIRST_FAILURE="deploy_test"; }; fi',
                        ],
                    },
                    post_build: {
                        commands: [
                            'export CI_PROJECT_DIR="/tmp/ci-project"',
                            'echo "=== Stage: Teardown ==="',
                            'cd "$CI_PROJECT_DIR" && yes yes | ./do/clean all && TEARDOWN_STATUS="pass" || TEARDOWN_STATUS="fail"',
                            'echo "=== Stage: Update ==="',
                            'TOTAL_DURATION=$(($(date +%s) - BUILD_START_TIME))',
                            'if [ -n "$FIRST_FAILURE" ]; then FINAL_TEST_STATUS="fail-${FIRST_FAILURE}"; else FINAL_TEST_STATUS="pass"; fi',
                            'LAST_TEST_TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
                            'aws dynamodb update-item --table-name "$CI_TABLE_NAME" --key "{\\\"configId\\\":{\\\"S\\\":\\\"$CONFIG_ID\\\"}}" --update-expression "SET testStatus = :ts, lastTestTimestamp = :ltt, lastTestDuration = :ltd, errorMessage = :em" --expression-attribute-values "{\\\":ts\\\":{\\\"S\\\":\\\"$FINAL_TEST_STATUS\\\"},\\\":ltt\\\":{\\\"S\\\":\\\"$LAST_TEST_TIMESTAMP\\\"},\\\":ltd\\\":{\\\"N\\\":\\\"$TOTAL_DURATION\\\"},\\\":em\\\":{\\\"S\\\":\\\"$FIRST_FAILURE\\\"}}" && UPDATE_STATUS="pass" || UPDATE_STATUS="fail"',
                            'echo "=== MLCC CI Complete: $FINAL_TEST_STATUS (${TOTAL_DURATION}s) ==="',
                        ],
                    },
                },
            }),
            timeout: cdk.Duration.minutes(90),
            logging: {
                cloudWatch: {
                    logGroup: this.ciLogGroup,
                    prefix: 'build',
                    enabled: true,
                },
            },
        });

        // Add CodeBuild permissions to the orchestrator role so Step Functions can start builds
        this.orchestratorRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'codebuild:StartBuild',
                'codebuild:BatchGetBuilds',
            ],
            resources: [this.ciCodeBuildProject.projectArn],
        }));
    }
}
