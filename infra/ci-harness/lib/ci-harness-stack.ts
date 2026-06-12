import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
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
        //
        // RETAIN policy: IAM roles are retained on stack deletion to prevent conflicts
        // during multi-region bootstrap. If the stack is re-created, existing roles will
        // be reused via --no-rollback.
        const scannerRole = new iam.Role(this, 'ScannerRole', {
            roleName: `mlcc-ci-scanner-role-${this.region}`,
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
        //
        // RETAIN policy: IAM roles are retained on stack deletion to prevent conflicts
        // during multi-region bootstrap. If the stack is re-created, existing roles will
        // be reused via --no-rollback.
        this.orchestratorRole = new iam.Role(this, 'OrchestratorRole', {
            roleName: `mlcc-ci-orchestrator-role-${this.region}`,
            assumedBy: new iam.CompositePrincipal(
                new iam.ServicePrincipal('states.amazonaws.com'),
                new iam.ServicePrincipal('events.amazonaws.com'),
            ),
            description: 'IAM role for the MLCC CI Orchestrator Step Functions state machine',
        });

        // DynamoDB:UpdateItem on CI_Table for UpdateResults states
        this.orchestratorRole.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['dynamodb:UpdateItem', 'dynamodb:GetItem'],
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
                        {
                            // Benchmark concurrency levels (comma-separated string, e.g. "1,4,8")
                            // Set by the CI Scanner Lambda from DynamoDB benchmarkConcurrencyLevels field.
                            // Falls back to default [1,4,8] in do/benchmark if empty.
                            Name: 'BENCHMARK_CONCURRENCY_LEVELS',
                            'Value.$': '$.benchmarkConcurrencyLevels',
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
            },
        });

        // ─── Stage 2 Orchestration (Req 1.1, 1.2, 1.3) ──────────────────────────
        // After Stage 1 completes, the orchestrator reads the DynamoDB record to
        // determine if the build passed and if benchmark is enabled. Stage 2 runs
        // benchmarks asynchronously and does NOT affect testStatus on failure.

        // GetBenchmarkConfig: Read benchmarkEnabled flag from DynamoDB after Stage 1
        const getBenchmarkConfig = new sfn.CustomState(this, 'GetBenchmarkConfig', {
            stateJson: {
                Type: 'Task',
                Resource: 'arn:aws:states:::dynamodb:getItem',
                Parameters: {
                    TableName: this.ciTable.tableName,
                    Key: {
                        configId: { 'S.$': '$.configId' },
                    },
                    ProjectionExpression: 'testStatus, benchmarkEnabled, benchmarkConcurrencyLevels',
                    ConsistentRead: true,
                },
                ResultPath: '$.dynamoResult',
                Retry: [
                    {
                        ErrorEquals: ['States.ALL'],
                        IntervalSeconds: 2,
                        MaxAttempts: 3,
                        BackoffRate: 2.0,
                    },
                ],
            },
        });

        // ExtractBenchmarkFlags: Extract benchmarkEnabled and testStatus into top-level fields
        const extractBenchmarkFlags = new sfn.Pass(this, 'ExtractBenchmarkFlags', {
            parameters: {
                'configId.$': '$.configId',
                'configJson.$': '$.configJson',
                'buildStrategy.$': '$.buildStrategy',
                'startTime.$': '$.startTime',
                'buildStatus.$': '$.buildStatus',
                'testStatus.$': '$.dynamoResult.Item.testStatus.S',
                'benchmarkEnabled.$': '$.dynamoResult.Item.benchmarkEnabled.BOOL',
            },
            resultPath: '$',
        });

        // ExtractBenchmarkFlagsDefault: Fallback when benchmarkEnabled is not set in DynamoDB
        // (backward-compatible — absence means disabled)
        const extractBenchmarkFlagsDefault = new sfn.Pass(this, 'ExtractBenchmarkFlagsDefault', {
            parameters: {
                'configId.$': '$.configId',
                'configJson.$': '$.configJson',
                'buildStrategy.$': '$.buildStrategy',
                'startTime.$': '$.startTime',
                'buildStatus.$': '$.buildStatus',
                'testStatus': 'unknown',
                'benchmarkEnabled': false,
            },
            resultPath: '$',
        });

        // CheckDynamoItemHasBenchmarkField: determine if the DynamoDB response contains
        // the benchmarkEnabled field. If not present, default to false.
        const checkDynamoItemHasBenchmarkField = new sfn.Choice(this, 'CheckDynamoItemHasBenchmarkField')
            .when(
                sfn.Condition.isPresent('$.dynamoResult.Item.benchmarkEnabled'),
                extractBenchmarkFlags,
            )
            .otherwise(extractBenchmarkFlagsDefault);

        // CheckStage1Passed: Determine if Stage 1 passed (testStatus from DynamoDB read)
        // If passed + benchmarkEnabled=true → Stage 2
        // If passed + benchmarkEnabled=false → skip to End
        // If failed → skip to End (do/clean already ran in CodeBuild's post_build)
        const prepareStage2Input = new sfn.Pass(this, 'PrepareStage2Input', {
            parameters: {
                'configId.$': '$.configId',
                'configJson.$': '$.configJson',
                'buildStrategy.$': '$.buildStrategy',
            },
        });

        const skipStage2 = new sfn.Succeed(this, 'SkipStage2');

        const checkBenchmarkEnabled = new sfn.Choice(this, 'CheckBenchmarkEnabled')
            .when(
                sfn.Condition.and(
                    sfn.Condition.stringEquals('$.testStatus', 'pass'),
                    sfn.Condition.booleanEquals('$.benchmarkEnabled', true),
                ),
                prepareStage2Input,
            )
            .otherwise(skipStage2);

        // Stage2Benchmark: Run do/benchmark via CodeBuild
        // Uses .sync integration to wait for build completion.
        const stage2Benchmark = new sfn.CustomState(this, 'Stage2Benchmark', {
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
                            Name: 'CI_STAGE',
                            Value: 'stage2-benchmark',
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
                ResultPath: '$.stage2BuildResult',
            },
        });

        // Stage2RegisterBenchmark: Run do/register --benchmark-status via CodeBuild
        const stage2RegisterBenchmark = new sfn.CustomState(this, 'Stage2RegisterBenchmark', {
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
                            Name: 'CI_STAGE',
                            Value: 'stage2-register-benchmark',
                            Type: 'PLAINTEXT',
                        },
                        {
                            Name: 'BENCHMARK_STATUS',
                            Value: 'completed',
                            Type: 'PLAINTEXT',
                        },
                        {
                            Name: 'CI_TABLE_NAME',
                            Value: this.ciTable.tableName,
                            Type: 'PLAINTEXT',
                        },
                    ],
                },
                ResultPath: '$.stage2RegisterResult',
            },
        });

        // Stage2Clean: Run do/clean after benchmark stage completes (success path)
        const stage2Clean = new sfn.CustomState(this, 'Stage2Clean', {
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
                            Name: 'CI_STAGE',
                            Value: 'stage2-clean',
                            Type: 'PLAINTEXT',
                        },
                    ],
                },
                ResultPath: '$.stage2CleanResult',
            },
        });

        // Stage2FailureHandler: Handle Stage 2 failures without affecting testStatus.
        // Records lastBenchmarkStatus=failed in DynamoDB, then proceeds to clean.
        // Per Req 1.4: Stage 2 failure SHALL NOT change the DynamoDB testStatus.
        // Uses SET expression targeting ONLY the 3 benchmark fields — never touches
        // testStatus, configJson, or any other pre-existing field.
        const stage2FailureHandler = new sfn.CustomState(this, 'Stage2FailureHandler', {
            stateJson: {
                Type: 'Task',
                Resource: 'arn:aws:states:::dynamodb:updateItem',
                Parameters: {
                    TableName: this.ciTable.tableName,
                    Key: {
                        configId: { 'S.$': '$.configId' },
                    },
                    UpdateExpression: 'SET lastBenchmarkRunId = :rid, lastBenchmarkTimestamp = :ts, lastBenchmarkStatus = :status',
                    ExpressionAttributeValues: {
                        ':rid': {
                            'S.$': "States.Format('bmk-failure-{}', $.configId)",
                        },
                        ':ts': { 'S.$': '$$.State.EnteredTime' },
                        ':status': { 'S': 'failed' },
                    },
                },
                ResultPath: '$.stage2FailureUpdateResult',
                Retry: [
                    {
                        ErrorEquals: ['States.ALL'],
                        IntervalSeconds: 2,
                        MaxAttempts: 3,
                        BackoffRate: 2.0,
                    },
                ],
            },
        });

        // Stage2FailureClean: Clean up after a Stage 2 failure
        const stage2FailureClean = new sfn.CustomState(this, 'Stage2FailureClean', {
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
                            Name: 'CI_STAGE',
                            Value: 'stage2-clean',
                            Type: 'PLAINTEXT',
                        },
                    ],
                },
                ResultPath: '$.stage2FailureCleanResult',
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

        // ─── Stage 2: Benchmark Error Handling ────────────────────────────────
        // Stage 2 failure isolation: if benchmarking fails, we record the failure
        // in the benchmark-specific fields (lastBenchmarkStatus=failed) without
        // touching testStatus. Uses a Parallel wrapper with addCatch so that CDK
        // properly includes the failure handler states in the definition graph.
        // Requirements: 1.4, 7.3

        // Wire up the state machine chain
        // RecordStartTime → StartCodeBuild → WaitForBuild → PollBuildStatus → CheckTimestamp → CheckBuildStatus
        // CheckBuildStatus branches:
        //   - SUCCEEDED/FAILED/STOPPED → SetBuildCompleteResult → UpdateResults → GetBenchmarkConfig
        //     → CheckDynamoItemHasBenchmarkField → ExtractBenchmarkFlags → CheckBenchmarkEnabled
        //     CheckBenchmarkEnabled branches:
        //       - pass + benchmarkEnabled=true → PrepareStage2Input → Stage2Pipeline (Parallel)
        //         Success: Stage2Benchmark → Stage2RegisterBenchmark → Stage2Clean → End
        //         Failure: Stage2FailureHandler → Stage2FailureClean → End
        //       - pass + benchmarkEnabled=false OR failed → SkipStage2 → End
        //   - TIMED_OUT → HandleTimeout → UpdateResultsFromTimeout → End
        //   - IN_PROGRESS (otherwise) → WaitForBuild (loop)
        recordStartTime.next(startCodeBuild);
        startCodeBuild.next(waitForBuild);
        waitForBuild.next(pollBuildStatus);
        pollBuildStatus.next(checkTimestamp);
        checkTimestamp.next(checkBuildStatus);
        setSuccessResult.next(updateResults);
        handleTimeout.next(updateResultsFromTimeout);

        // Stage 2 wiring: after UpdateResults, read DynamoDB for benchmark config
        updateResults.next(getBenchmarkConfig);
        getBenchmarkConfig.next(checkDynamoItemHasBenchmarkField);
        extractBenchmarkFlags.next(checkBenchmarkEnabled);
        extractBenchmarkFlagsDefault.next(checkBenchmarkEnabled);

        // Stage 2 execution uses a Parallel state to enable proper CDK Catch handling.
        // The Parallel has one branch (the success path), and addCatch routes errors
        // to the failure handler chain.
        const stage2Pipeline = new sfn.Parallel(this, 'Stage2Pipeline', {
            resultPath: '$.stage2PipelineResult',
        });
        stage2Pipeline.branch(
            stage2Benchmark
                .next(stage2RegisterBenchmark)
                .next(stage2Clean),
        );
        stage2Pipeline.addCatch(stage2FailureHandler, {
            resultPath: '$.stage2Error',
        });

        // After PrepareStage2Input, enter the Stage2Pipeline parallel wrapper
        prepareStage2Input.next(stage2Pipeline);

        // Stage 2 failure path: FailureHandler → FailureClean → End
        stage2FailureHandler.next(stage2FailureClean);

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
        //
        // RETAIN policy: IAM roles are retained on stack deletion to prevent conflicts
        // during multi-region bootstrap. If the stack is re-created, existing roles will
        // be reused via --no-rollback.
        const codebuildRole = new iam.Role(this, 'CodeBuildRole', {
            roleName: `mlcc-ci-codebuild-role-${this.region}`,
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

        // ─── Benchmark Infrastructure (opt-in) ────────────────────────────────
        // Gated by the CreateBenchmarkInfra parameter. When enabled, provisions
        // Glue database/table, S3 results bucket, IAM permissions for benchmark
        // writes (S3, Glue, Athena), and stack outputs for downstream consumers.
        // Idempotent: CloudFormation conditions ensure re-running `cdk deploy`
        // with the same parameter value produces no changes. Resources are only
        // created when CreateBenchmarkInfra=true; subsequent deploys with the
        // same value are no-ops (CloudFormation handles existence checks natively).
        // Requirements: 3.1, 3.2, 3.4, 3.5

        const createBenchmarkInfra = new cdk.CfnParameter(this, 'CreateBenchmarkInfra', {
            type: 'String',
            default: 'false',
            allowedValues: ['true', 'false'],
            description: 'Whether to create benchmark infrastructure (S3 results bucket, Glue DB/table, IAM permissions). Opt-in.',
        });

        const benchmarkInfraCondition = new cdk.CfnCondition(this, 'BenchmarkInfraCondition', {
            expression: cdk.Fn.conditionEquals(createBenchmarkInfra.valueAsString, 'true'),
        });

        // Glue Database: mlcc_ci
        // CloudFormation manages create-or-skip via the condition — no duplicate
        // resource error on re-deploy because the logical ID is stable.
        const glueDatabase = new glue.CfnDatabase(this, 'CiGlueDatabase', {
            catalogId: this.account,
            databaseInput: {
                name: 'mlcc_ci',
                description: 'MCC CI benchmark results warehouse',
            },
        });
        glueDatabase.cfnOptions.condition = benchmarkInfraCondition;

        // Glue Table: benchmark_results — full DDL with all 28+ columns
        // Partition by region/year/month for efficient time-range queries.
        // Dimension columns are well-separated (not composite keys) per Req 5.1.
        const glueTable = new glue.CfnTable(this, 'BenchmarkResultsTable', {
            catalogId: this.account,
            databaseName: 'mlcc_ci',
            tableInput: {
                name: 'benchmark_results',
                tableType: 'EXTERNAL_TABLE',
                parameters: {
                    'classification': 'parquet',
                    'parquet.compression': 'SNAPPY',
                },
                storageDescriptor: {
                    columns: [
                        // Identity & config (matches Parquet writer get_parquet_schema() exactly)
                        { name: 'project_name', type: 'string', comment: 'MCC project name' },
                        { name: 'model_name', type: 'string', comment: 'HuggingFace model ID' },
                        { name: 'model_family', type: 'string', comment: 'Derived: qwen3, llama3, deepseek-r1' },
                        { name: 'instance_type', type: 'string', comment: 'SageMaker instance type' },
                        { name: 'deployment_config', type: 'string', comment: 'Architecture-backend' },
                        { name: 'deployment_target', type: 'string', comment: 'Deployment target' },
                        { name: 'quantization', type: 'string', comment: 'none, fp8, awq, gptq' },
                        { name: 'tensor_parallel_degree', type: 'int', comment: 'TP degree' },
                        { name: 'serving_config', type: 'string', comment: 'Full serving config JSON blob' },
                        { name: 'workload', type: 'string', comment: 'Named workload profile' },
                        { name: 'concurrency', type: 'int', comment: 'Concurrent requests' },
                        { name: 'input_tokens_mean', type: 'int', comment: 'Mean input tokens' },
                        { name: 'output_tokens_mean', type: 'int', comment: 'Mean output tokens' },
                        { name: 'streaming', type: 'boolean', comment: 'Streaming enabled' },
                        { name: 'duration_seconds', type: 'int', comment: 'Duration in seconds' },
                        // Throughput metrics
                        { name: 'request_throughput_rps', type: 'double', comment: 'Requests/sec' },
                        { name: 'total_token_throughput_tps', type: 'double', comment: 'Total tokens/sec (in+out)' },
                        { name: 'output_token_throughput_tps', type: 'double', comment: 'Output tokens/sec' },
                        { name: 'request_count', type: 'double', comment: 'Total requests in run' },
                        // Latency metrics (avg/p50/p90/p99)
                        { name: 'ttft_avg_ms', type: 'double', comment: 'TTFT average (ms)' },
                        { name: 'ttft_p50_ms', type: 'double', comment: 'TTFT p50 (ms)' },
                        { name: 'ttft_p90_ms', type: 'double', comment: 'TTFT p90 (ms)' },
                        { name: 'ttft_p99_ms', type: 'double', comment: 'TTFT p99 (ms)' },
                        { name: 'itl_avg_ms', type: 'double', comment: 'ITL average (ms)' },
                        { name: 'itl_p50_ms', type: 'double', comment: 'ITL p50 (ms)' },
                        { name: 'itl_p90_ms', type: 'double', comment: 'ITL p90 (ms)' },
                        { name: 'itl_p99_ms', type: 'double', comment: 'ITL p99 (ms)' },
                        { name: 'e2e_latency_avg_ms', type: 'double', comment: 'E2E latency average (ms)' },
                        { name: 'e2e_latency_p50_ms', type: 'double', comment: 'E2E latency p50 (ms)' },
                        { name: 'e2e_latency_p90_ms', type: 'double', comment: 'E2E latency p90 (ms)' },
                        { name: 'e2e_latency_p99_ms', type: 'double', comment: 'E2E latency p99 (ms)' },
                        { name: 'prefill_tps_avg', type: 'double', comment: 'Prefill throughput avg (tokens/sec)' },
                        { name: 'prefill_tps_p50', type: 'double', comment: 'Prefill throughput p50' },
                        { name: 'output_token_tps_avg', type: 'double', comment: 'Per-user output TPS avg' },
                        { name: 'output_token_tps_p50', type: 'double', comment: 'Per-user output TPS p50' },
                        { name: 'output_token_tps_p90', type: 'double', comment: 'Per-user output TPS p90' },
                        { name: 'ttst_p50_ms', type: 'double', comment: 'Time to second token p50 (ms)' },
                        { name: 'ttst_p90_ms', type: 'double', comment: 'Time to second token p90 (ms)' },
                        { name: 'output_sequence_length_avg', type: 'double', comment: 'Avg output sequence length' },
                        { name: 'input_sequence_length_avg', type: 'double', comment: 'Avg input sequence length' },
                        { name: 'error_rate', type: 'double', comment: 'Error rate (0.0-1.0)' },
                        { name: 'benchmark_duration_sec', type: 'double', comment: 'Wall-clock duration (sec)' },
                        // Provenance
                        { name: 'run_type', type: 'string', comment: 'ci, path_prove, manual' },
                        { name: 'benchmark_job_name', type: 'string', comment: 'SageMaker benchmark job name' },
                        { name: 'mcc_version', type: 'string', comment: 'MCC version' },
                        { name: 'run_timestamp', type: 'string', comment: 'ISO 8601 UTC timestamp' },
                        { name: 'region', type: 'string', comment: 'AWS region' },
                    ],
                    location: `s3://mlcc-benchmark-results-${this.account}-${this.region}/results/`,
                    inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
                    outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
                    serdeInfo: {
                        serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
                        parameters: {
                            'serialization.format': '1',
                        },
                    },
                    compressed: true,
                },
                partitionKeys: [
                    { name: 'model', type: 'string', comment: 'Model name with / replaced by _ (e.g., Qwen_Qwen3-0.6B)' },
                    { name: 'instance', type: 'string', comment: 'SageMaker instance type (e.g., ml.g5.xlarge)' },
                    { name: 'target', type: 'string', comment: 'Deployment target (realtime-inference, async-inference, etc.)' },
                ],
            },
        });
        glueTable.addDependency(glueDatabase);
        glueTable.cfnOptions.condition = benchmarkInfraCondition;

        // Configurable lifecycle parameters for the benchmark results bucket
        const benchmarkIaTransitionDays = new cdk.CfnParameter(this, 'BenchmarkIaTransitionDays', {
            type: 'Number',
            default: 90,
            description: 'Days before benchmark results transition to Infrequent Access storage',
            minValue: 30,
            maxValue: 365,
        });

        const benchmarkExpirationDays = new cdk.CfnParameter(this, 'BenchmarkExpirationDays', {
            type: 'Number',
            default: 365,
            description: 'Days before benchmark results expire and are deleted',
            minValue: 90,
            maxValue: 3650,
        });

        // S3 bucket for benchmark results (Parquet files partitioned by region/year/month)
        const benchmarkResultsBucket = new s3.Bucket(this, 'BenchmarkResultsBucket', {
            bucketName: `mlcc-benchmark-results-${this.account}-${this.region}`,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            lifecycleRules: [
                {
                    transitions: [
                        {
                            storageClass: s3.StorageClass.INFREQUENT_ACCESS,
                            transitionAfter: cdk.Duration.days(benchmarkIaTransitionDays.valueAsNumber),
                        },
                    ],
                    expiration: cdk.Duration.days(benchmarkExpirationDays.valueAsNumber),
                },
            ],
        });

        // Apply the benchmark condition to the S3 bucket
        const cfnBenchmarkBucket = benchmarkResultsBucket.node.defaultChild as cdk.CfnResource;
        cfnBenchmarkBucket.cfnOptions.condition = benchmarkInfraCondition;

        // Output the benchmark results bucket ARN (conditional)
        new cdk.CfnOutput(this, 'BenchmarkResultsBucketArn', {
            value: benchmarkResultsBucket.bucketArn,
            description: 'ARN of the S3 bucket storing benchmark results (Parquet)',
            condition: benchmarkInfraCondition,
            exportName: 'mlcc-ci-benchmark-results-bucket-arn',
        });

        // Output the benchmark results bucket name (conditional)
        new cdk.CfnOutput(this, 'BenchmarkResultsBucketName', {
            value: benchmarkResultsBucket.bucketName,
            description: 'Name of the S3 bucket storing benchmark results (Parquet)',
            condition: benchmarkInfraCondition,
        });

        // Output the Glue database name (conditional)
        new cdk.CfnOutput(this, 'CiGlueDatabaseName', {
            value: 'mlcc_ci',
            description: 'Name of the Glue database for benchmark results',
            condition: benchmarkInfraCondition,
        });

        // S3 permissions for benchmark results bucket writes
        const benchmarkS3Policy = new iam.PolicyStatement({
            sid: 'BenchmarkResultsWrite',
            effect: iam.Effect.ALLOW,
            actions: [
                's3:PutObject',
                's3:GetObject',
                's3:ListBucket',
            ],
            resources: [
                'arn:aws:s3:::mlcc-benchmark-results-*',
                'arn:aws:s3:::mlcc-benchmark-results-*/*',
            ],
        });

        // Glue permissions for partition management
        const benchmarkGluePolicy = new iam.PolicyStatement({
            sid: 'GlueCatalogAccess',
            effect: iam.Effect.ALLOW,
            actions: [
                'glue:GetDatabase',
                'glue:GetTable',
                'glue:GetPartitions',
                'glue:BatchCreatePartition',
                'glue:CreatePartition',
            ],
            resources: [
                'arn:aws:glue:*:*:catalog',
                'arn:aws:glue:*:*:database/mlcc_ci',
                'arn:aws:glue:*:*:table/mlcc_ci/*',
            ],
        });

        // Athena permissions for partition repair (MSCK REPAIR TABLE)
        const benchmarkAthenaPolicy = new iam.PolicyStatement({
            sid: 'AthenaPartitionRepair',
            effect: iam.Effect.ALLOW,
            actions: [
                'athena:StartQueryExecution',
                'athena:GetQueryResults',
            ],
            resources: ['*'],
        });

        // Create a managed policy for benchmark permissions so we can condition it
        const benchmarkPolicy = new iam.Policy(this, 'BenchmarkWritePolicy', {
            policyName: 'mlcc-ci-benchmark-write-policy',
            statements: [benchmarkS3Policy, benchmarkGluePolicy, benchmarkAthenaPolicy],
        });
        benchmarkPolicy.attachToRole(codebuildRole);

        // Apply the condition to the policy's underlying CFN resource
        const cfnBenchmarkPolicy = benchmarkPolicy.node.defaultChild as cdk.CfnResource;
        cfnBenchmarkPolicy.cfnOptions.condition = benchmarkInfraCondition;

        // ─── Path Prover Infrastructure (opt-in, separate from benchmark infra) ────
        // Gated by the CreatePathProver parameter. When enabled, provisions:
        // - Brain Lambda (getNextConfig, pickNext, classifyFailure)
        // - WriteResults Lambda (writes path_prove records to Athena)
        // - Step Functions state machine (path-prover orchestrator)
        // - EventBridge scheduled rule (disabled by default)
        // Requirements: 8.1, 8.7, 8.8

        const createPathProver = new cdk.CfnParameter(this, 'CreatePathProver', {
            type: 'String',
            default: 'false',
            allowedValues: ['true', 'false'],
            description: 'Whether to create Path Prover infrastructure (state machine, Lambdas, EventBridge rule). Opt-in.',
        });

        const pathProverCondition = new cdk.CfnCondition(this, 'PathProverCondition', {
            expression: cdk.Fn.conditionEquals(createPathProver.valueAsString, 'true'),
        });

        // Path Prover Brain Lambda IAM role
        const pathProverBrainRole = new iam.Role(this, 'PathProverBrainRole', {
            roleName: 'mlcc-path-prover-brain-role',
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'IAM role for the Path Prover Brain Lambda function',
        });
        (pathProverBrainRole.node.defaultChild as cdk.CfnResource).cfnOptions.condition = pathProverCondition;

        // Brain Lambda: Athena read access for gap identification + substitution
        const brainAthenaPolicy = new iam.Policy(this, 'PathProverBrainAthenaPolicy', {
            policyName: 'mlcc-path-prover-brain-athena',
            statements: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'athena:StartQueryExecution',
                        'athena:GetQueryExecution',
                        'athena:GetQueryResults',
                    ],
                    resources: ['*'],
                }),
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['glue:GetTable', 'glue:GetDatabase', 'glue:GetPartitions'],
                    resources: [
                        'arn:aws:glue:*:*:catalog',
                        'arn:aws:glue:*:*:database/mlcc_ci',
                        'arn:aws:glue:*:*:table/mlcc_ci/*',
                    ],
                }),
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['s3:GetObject', 's3:ListBucket', 's3:GetBucketLocation', 's3:PutObject'],
                    resources: [
                        'arn:aws:s3:::mlcc-benchmark-results-*',
                        'arn:aws:s3:::mlcc-benchmark-results-*/*',
                    ],
                }),
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                    resources: [this.ciLogGroup.logGroupArn, `${this.ciLogGroup.logGroupArn}:*`],
                }),
            ],
        });
        brainAthenaPolicy.attachToRole(pathProverBrainRole);
        (brainAthenaPolicy.node.defaultChild as cdk.CfnResource).cfnOptions.condition = pathProverCondition;

        // Path Prover Brain Lambda function
        const pathProverBrainFunction = new NodejsFunction(this, 'PathProverBrainFunction', {
            functionName: 'mlcc-path-prover-brain',
            runtime: lambda.Runtime.NODEJS_20_X,
            memorySize: 512,
            timeout: cdk.Duration.seconds(120),
            entry: path.join(__dirname, '..', 'lambda', 'path-prover', 'brain.ts'),
            handler: 'handler',
            role: pathProverBrainRole,
            environment: {
                GLUE_DATABASE: 'mlcc_ci',
                GLUE_TABLE: 'benchmark_results',
                MAX_PROVES_PER_RUN: '10',
                MAX_COST_PER_RUN: '100',
            },
            logGroup: this.ciLogGroup,
            bundling: {
                minify: true,
                sourceMap: true,
            },
        });
        (pathProverBrainFunction.node.defaultChild as cdk.CfnResource).cfnOptions.condition = pathProverCondition;

        // Path Prover Write Results Lambda IAM role
        const pathProverWriteRole = new iam.Role(this, 'PathProverWriteRole', {
            roleName: 'mlcc-path-prover-write-role',
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'IAM role for the Path Prover Write Results Lambda function',
        });
        (pathProverWriteRole.node.defaultChild as cdk.CfnResource).cfnOptions.condition = pathProverCondition;

        // Write Results Lambda: S3 + Glue write access
        const writeResultsPolicy = new iam.Policy(this, 'PathProverWriteResultsPolicy', {
            policyName: 'mlcc-path-prover-write-results',
            statements: [
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['s3:PutObject', 's3:GetObject'],
                    resources: [
                        'arn:aws:s3:::mlcc-benchmark-results-*/*',
                    ],
                }),
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['glue:BatchCreatePartition', 'glue:CreatePartition', 'glue:GetTable'],
                    resources: [
                        'arn:aws:glue:*:*:catalog',
                        'arn:aws:glue:*:*:database/mlcc_ci',
                        'arn:aws:glue:*:*:table/mlcc_ci/*',
                    ],
                }),
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                    resources: [this.ciLogGroup.logGroupArn, `${this.ciLogGroup.logGroupArn}:*`],
                }),
            ],
        });
        writeResultsPolicy.attachToRole(pathProverWriteRole);
        (writeResultsPolicy.node.defaultChild as cdk.CfnResource).cfnOptions.condition = pathProverCondition;

        // Path Prover Write Results Lambda function
        const pathProverWriteFunction = new NodejsFunction(this, 'PathProverWriteFunction', {
            functionName: 'mlcc-path-prover-write-results',
            runtime: lambda.Runtime.NODEJS_20_X,
            memorySize: 256,
            timeout: cdk.Duration.seconds(60),
            entry: path.join(__dirname, '..', 'lambda', 'path-prover', 'write-results.ts'),
            handler: 'handler',
            role: pathProverWriteRole,
            environment: {
                GLUE_DATABASE: 'mlcc_ci',
                GLUE_TABLE: 'benchmark_results',
                RESULTS_BUCKET: `mlcc-benchmark-results-${this.account}-${this.region}`,
            },
            logGroup: this.ciLogGroup,
            bundling: {
                minify: true,
                sourceMap: true,
            },
        });
        (pathProverWriteFunction.node.defaultChild as cdk.CfnResource).cfnOptions.condition = pathProverCondition;

        // Path Prover Step Functions IAM role
        const pathProverOrchestratorRole = new iam.Role(this, 'PathProverOrchestratorRole', {
            roleName: 'mlcc-path-prover-orchestrator-role',
            assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
            description: 'IAM role for the Path Prover Step Functions state machine',
        });
        (pathProverOrchestratorRole.node.defaultChild as cdk.CfnResource).cfnOptions.condition = pathProverCondition;

        // Orchestrator permissions
        const pathProverOrchestratorPolicy = new iam.Policy(this, 'PathProverOrchestratorPolicy', {
            policyName: 'mlcc-path-prover-orchestrator-policy',
            statements: [
                // Lambda invoke for brain and write-results
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['lambda:InvokeFunction'],
                    resources: [
                        pathProverBrainFunction.functionArn,
                        pathProverWriteFunction.functionArn,
                    ],
                }),
                // CodeBuild start/poll for lifecycle stages
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds', 'codebuild:StopBuild'],
                    resources: [this.ciCodeBuildProject.projectArn],
                }),
                // CloudWatch Logs for execution logging
                new iam.PolicyStatement({
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
                }),
                // Events for .sync integration
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['events:PutTargets', 'events:PutRule', 'events:DescribeRule'],
                    resources: [`arn:aws:events:${this.region}:${this.account}:rule/StepFunctionsGetBuildStatusRule-*`],
                }),
            ],
        });
        pathProverOrchestratorPolicy.attachToRole(pathProverOrchestratorRole);
        (pathProverOrchestratorPolicy.node.defaultChild as cdk.CfnResource).cfnOptions.condition = pathProverCondition;

        // Path Prover State Machine
        // Uses ASL definition from file with Fn::Sub for variable substitution.
        // We read the raw JSON and use cdk.Fn.sub to inject resource ARNs.
        const aslTemplate = JSON.stringify(require('../state-machines/path-prover.asl.json'));
        const pathProverDefinitionString = cdk.Fn.sub(aslTemplate, {
            BrainFunctionArn: pathProverBrainFunction.functionArn,
            WriteResultsFunctionArn: pathProverWriteFunction.functionArn,
            ClassifyFailureFunctionArn: pathProverBrainFunction.functionArn,
            CodeBuildProjectName: this.ciCodeBuildProject.projectName,
        });

        const pathProverStateMachine = new sfn.CfnStateMachine(this, 'PathProverStateMachine', {
            stateMachineName: 'mlcc-path-prover',
            stateMachineType: 'STANDARD',
            definitionString: pathProverDefinitionString,
            roleArn: pathProverOrchestratorRole.roleArn,
            loggingConfiguration: {
                destinations: [{
                    cloudWatchLogsLogGroup: {
                        logGroupArn: this.ciLogGroup.logGroupArn,
                    },
                }],
                level: 'ALL',
                includeExecutionData: true,
            },
            tracingConfiguration: {
                enabled: true,
            },
        });
        pathProverStateMachine.cfnOptions.condition = pathProverCondition;

        // EventBridge scheduled rule for Path Prover (disabled by default)
        // Can be enabled via the EnablePathProverSchedule parameter
        const enablePathProverSchedule = new cdk.CfnParameter(this, 'EnablePathProverSchedule', {
            type: 'String',
            default: 'DISABLED',
            allowedValues: ['ENABLED', 'DISABLED'],
            description: 'Whether to enable the Path Prover scheduled EventBridge rule. Default: DISABLED.',
        });

        const pathProverScheduleRule = new events.CfnRule(this, 'PathProverScheduleRule', {
            name: 'mlcc-path-prover-schedule',
            description: 'Triggers the Path Prover state machine on a schedule to fill coverage gaps',
            scheduleExpression: 'rate(6 hours)',
            state: enablePathProverSchedule.valueAsString,
            targets: [{
                arn: `arn:aws:states:${this.region}:${this.account}:stateMachine:mlcc-path-prover`,
                id: 'PathProverTarget',
                roleArn: pathProverOrchestratorRole.roleArn,
                input: JSON.stringify({
                    iteration: 0,
                    budgetSpent: 0,
                    maxProvesPerRun: 10,
                    maxCostPerRun: 100,
                    previousResults: [],
                }),
            }],
        });
        pathProverScheduleRule.cfnOptions.condition = pathProverCondition;

        // Output Path Prover state machine ARN
        new cdk.CfnOutput(this, 'PathProverStateMachineArn', {
            value: `arn:aws:states:${this.region}:${this.account}:stateMachine:mlcc-path-prover`,
            description: 'ARN of the Path Prover Step Functions state machine',
            condition: pathProverCondition,
        });

        // Output Brain Lambda ARN
        new cdk.CfnOutput(this, 'PathProverBrainFunctionArn', {
            value: pathProverBrainFunction.functionArn,
            description: 'ARN of the Path Prover Brain Lambda function',
            condition: pathProverCondition,
        });
    }
}
