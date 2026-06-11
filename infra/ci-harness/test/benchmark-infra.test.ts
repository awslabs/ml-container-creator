import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import assert from 'node:assert/strict';
import { MlccCiHarnessStack } from '../lib/ci-harness-stack';

/**
 * CDK snapshot tests for Glue/S3/IAM benchmark infrastructure provisioning.
 *
 * Validates Requirements: 3.1, 3.2, 3.4
 *
 * Tests verify:
 * - Glue DB, Glue Table, S3 bucket, and IAM statements are synthesized correctly
 * - Condition gating ensures benchmark infra only when CreateBenchmarkInfra=true
 * - Idempotency: cdk synth twice produces identical output
 */
describe('Benchmark Infrastructure (Glue/S3/IAM Provisioning)', () => {
    let template: Template;

    before(() => {
        const app = new App();
        const stack = new MlccCiHarnessStack(app, 'BenchmarkTestStack');
        template = Template.fromStack(stack);
    });

    describe('Glue Database (Req 3.1)', () => {
        it('creates Glue database named mlcc_ci', () => {
            template.hasResourceProperties('AWS::Glue::Database', {
                DatabaseInput: Match.objectLike({
                    Name: 'mlcc_ci',
                    Description: 'MCC CI benchmark results warehouse',
                }),
            });
        });

        it('uses the stack account as catalog ID', () => {
            template.hasResourceProperties('AWS::Glue::Database', {
                CatalogId: { Ref: 'AWS::AccountId' },
            });
        });
    });

    describe('Glue Table (Req 3.1)', () => {
        it('creates an EXTERNAL_TABLE named benchmark_results', () => {
            template.hasResourceProperties('AWS::Glue::Table', {
                DatabaseName: 'mlcc_ci',
                TableInput: Match.objectLike({
                    Name: 'benchmark_results',
                    TableType: 'EXTERNAL_TABLE',
                }),
            });
        });

        it('has Parquet classification and Snappy compression', () => {
            template.hasResourceProperties('AWS::Glue::Table', {
                TableInput: Match.objectLike({
                    Parameters: {
                        'classification': 'parquet',
                        'parquet.compression': 'SNAPPY',
                    },
                }),
            });
        });

        it('defines partition keys: region, year, month', () => {
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

        it('includes core dimension columns (config_id, model_name, model_family, instance_type, instance_family)', () => {
            template.hasResourceProperties('AWS::Glue::Table', {
                TableInput: Match.objectLike({
                    StorageDescriptor: Match.objectLike({
                        Columns: Match.arrayWith([
                            Match.objectLike({ Name: 'config_id', Type: 'string' }),
                            Match.objectLike({ Name: 'model_name', Type: 'string' }),
                            Match.objectLike({ Name: 'model_family', Type: 'string' }),
                            Match.objectLike({ Name: 'instance_type', Type: 'string' }),
                            Match.objectLike({ Name: 'instance_family', Type: 'string' }),
                        ]),
                    }),
                }),
            });
        });

        it('includes result metric columns (ttft_p50_ms, throughput_rps, cost_per_1m_tokens)', () => {
            template.hasResourceProperties('AWS::Glue::Table', {
                TableInput: Match.objectLike({
                    StorageDescriptor: Match.objectLike({
                        Columns: Match.arrayWith([
                            Match.objectLike({ Name: 'ttft_p50_ms', Type: 'double' }),
                            Match.objectLike({ Name: 'throughput_rps', Type: 'double' }),
                            Match.objectLike({ Name: 'cost_per_1m_tokens', Type: 'double' }),
                        ]),
                    }),
                }),
            });
        });

        it('includes run_type column for provenance discrimination', () => {
            template.hasResourceProperties('AWS::Glue::Table', {
                TableInput: Match.objectLike({
                    StorageDescriptor: Match.objectLike({
                        Columns: Match.arrayWith([
                            Match.objectLike({ Name: 'run_type', Type: 'string' }),
                        ]),
                    }),
                }),
            });
        });

        it('uses Parquet input/output format and serde', () => {
            template.hasResourceProperties('AWS::Glue::Table', {
                TableInput: Match.objectLike({
                    StorageDescriptor: Match.objectLike({
                        InputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
                        OutputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
                        SerdeInfo: Match.objectLike({
                            SerializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
                        }),
                    }),
                }),
            });
        });

        it('depends on Glue database for ordered creation', () => {
            template.hasResource('AWS::Glue::Table', {
                DependsOn: Match.arrayWith(['CiGlueDatabase']),
            });
        });
    });

    describe('S3 Benchmark Results Bucket (Req 3.1, 3.5)', () => {
        it('creates S3 bucket with account-region naming pattern', () => {
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

        it('has RETAIN removal policy', () => {
            template.hasResource('AWS::S3::Bucket', {
                UpdateReplacePolicy: 'Retain',
                DeletionPolicy: 'Retain',
            });
        });

        it('has lifecycle rules configured', () => {
            template.hasResourceProperties('AWS::S3::Bucket', {
                LifecycleConfiguration: Match.objectLike({
                    Rules: Match.arrayWith([
                        Match.objectLike({
                            Status: 'Enabled',
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
    });

    describe('IAM Benchmark Permissions (Req 3.4)', () => {
        it('creates benchmark write policy with correct name', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyName: 'mlcc-ci-benchmark-write-policy',
            });
        });

        it('grants S3 PutObject, GetObject, ListBucket on results bucket', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyName: 'mlcc-ci-benchmark-write-policy',
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'BenchmarkResultsWrite',
                            Effect: 'Allow',
                            Action: [
                                's3:PutObject',
                                's3:GetObject',
                                's3:ListBucket',
                            ],
                            Resource: [
                                'arn:aws:s3:::mlcc-benchmark-results-*',
                                'arn:aws:s3:::mlcc-benchmark-results-*/*',
                            ],
                        }),
                    ]),
                }),
            });
        });

        it('grants Glue permissions for catalog and partition management', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyName: 'mlcc-ci-benchmark-write-policy',
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'GlueCatalogAccess',
                            Effect: 'Allow',
                            Action: [
                                'glue:GetDatabase',
                                'glue:GetTable',
                                'glue:GetPartitions',
                                'glue:BatchCreatePartition',
                                'glue:CreatePartition',
                            ],
                            Resource: [
                                'arn:aws:glue:*:*:catalog',
                                'arn:aws:glue:*:*:database/mlcc_ci',
                                'arn:aws:glue:*:*:table/mlcc_ci/*',
                            ],
                        }),
                    ]),
                }),
            });
        });

        it('grants Athena permissions for partition repair', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyName: 'mlcc-ci-benchmark-write-policy',
                PolicyDocument: Match.objectLike({
                    Statement: Match.arrayWith([
                        Match.objectLike({
                            Sid: 'AthenaPartitionRepair',
                            Effect: 'Allow',
                            Action: [
                                'athena:StartQueryExecution',
                                'athena:GetQueryResults',
                            ],
                        }),
                    ]),
                }),
            });
        });

        it('attaches benchmark policy to the CodeBuild role', () => {
            template.hasResourceProperties('AWS::IAM::Policy', {
                PolicyName: 'mlcc-ci-benchmark-write-policy',
                Roles: Match.arrayWith([
                    { Ref: Match.stringLikeRegexp('CodeBuildRole') },
                ]),
            });
        });
    });

    describe('Condition Gating (Req 3.2)', () => {
        it('defines CreateBenchmarkInfra parameter with default false', () => {
            template.hasParameter('CreateBenchmarkInfra', {
                Type: 'String',
                Default: 'false',
                AllowedValues: ['true', 'false'],
            });
        });

        it('defines BenchmarkInfraCondition that checks for true', () => {
            template.hasCondition('BenchmarkInfraCondition', {
                'Fn::Equals': [
                    { Ref: 'CreateBenchmarkInfra' },
                    'true',
                ],
            });
        });

        it('Glue database has BenchmarkInfraCondition', () => {
            template.hasResource('AWS::Glue::Database', {
                Condition: 'BenchmarkInfraCondition',
            });
        });

        it('Glue table has BenchmarkInfraCondition', () => {
            template.hasResource('AWS::Glue::Table', {
                Condition: 'BenchmarkInfraCondition',
            });
        });

        it('S3 bucket has BenchmarkInfraCondition', () => {
            template.hasResource('AWS::S3::Bucket', {
                Condition: 'BenchmarkInfraCondition',
            });
        });

        it('benchmark IAM policy has BenchmarkInfraCondition', () => {
            template.hasResource('AWS::IAM::Policy', {
                Condition: 'BenchmarkInfraCondition',
                Properties: Match.objectLike({
                    PolicyName: 'mlcc-ci-benchmark-write-policy',
                }),
            });
        });

        it('non-benchmark resources (DynamoDB, Lambda, CodeBuild) have no condition', () => {
            // DynamoDB table should NOT have any condition
            template.hasResource('AWS::DynamoDB::Table', {
                Condition: Match.absent(),
            });

            // Lambda function should NOT have any condition
            template.hasResource('AWS::Lambda::Function', {
                Condition: Match.absent(),
            });

            // CodeBuild project should NOT have any condition
            template.hasResource('AWS::CodeBuild::Project', {
                Condition: Match.absent(),
            });
        });
    });

    describe('Idempotency (Req 3.2)', () => {
        it('cdk synth produces identical template on repeated runs', () => {
            const app1 = new App();
            const stack1 = new MlccCiHarnessStack(app1, 'IdempotencyStack');
            const template1 = Template.fromStack(stack1);

            const app2 = new App();
            const stack2 = new MlccCiHarnessStack(app2, 'IdempotencyStack');
            const template2 = Template.fromStack(stack2);

            const json1 = template1.toJSON();
            const json2 = template2.toJSON();

            // Resource logical IDs must be identical
            const resourceKeys1 = Object.keys(json1.Resources).sort();
            const resourceKeys2 = Object.keys(json2.Resources).sort();
            assert.deepStrictEqual(resourceKeys1, resourceKeys2, 'Resource logical IDs must be identical across synths');

            // Resource types must match
            for (const key of resourceKeys1) {
                assert.strictEqual(
                    json1.Resources[key].Type,
                    json2.Resources[key].Type,
                    `Resource type mismatch for ${key}`
                );
            }

            // Parameter keys must match
            const paramKeys1 = Object.keys(json1.Parameters).sort();
            const paramKeys2 = Object.keys(json2.Parameters).sort();
            assert.deepStrictEqual(paramKeys1, paramKeys2, 'Parameter keys must be identical across synths');

            // Condition keys must match
            const conditionKeys1 = Object.keys(json1.Conditions || {}).sort();
            const conditionKeys2 = Object.keys(json2.Conditions || {}).sort();
            assert.deepStrictEqual(conditionKeys1, conditionKeys2, 'Condition keys must be identical across synths');

            // Full template deep equality
            assert.deepStrictEqual(json1, json2, 'Full template JSON must be identical across synths');
        });

        it('benchmark resources use stable logical IDs', () => {
            const json = template.toJSON();
            const resources = json.Resources;

            // Verify benchmark-specific logical IDs exist and are stable
            const benchmarkLogicalIds = Object.keys(resources).filter(key => {
                const type = resources[key].Type;
                return type === 'AWS::Glue::Database' ||
                       type === 'AWS::Glue::Table' ||
                       (type === 'AWS::S3::Bucket' && resources[key].Condition === 'BenchmarkInfraCondition');
            });

            assert.ok(benchmarkLogicalIds.length >= 3, 'Should have at least 3 benchmark resources (Glue DB, Glue Table, S3 Bucket)');

            // Verify logical IDs are deterministic (contain expected substrings)
            const logicalIdStr = benchmarkLogicalIds.join(',');
            assert.ok(logicalIdStr.includes('CiGlueDatabase'), 'Should have CiGlueDatabase logical ID');
            assert.ok(logicalIdStr.includes('BenchmarkResultsTable'), 'Should have BenchmarkResultsTable logical ID');
            assert.ok(logicalIdStr.includes('BenchmarkResultsBucket'), 'Should have BenchmarkResultsBucket logical ID');
        });
    });

    describe('Stack Outputs (conditional)', () => {
        it('outputs BenchmarkResultsBucketArn with condition', () => {
            template.hasOutput('BenchmarkResultsBucketArn', {
                Condition: 'BenchmarkInfraCondition',
            });
        });

        it('outputs BenchmarkResultsBucketName with condition', () => {
            template.hasOutput('BenchmarkResultsBucketName', {
                Condition: 'BenchmarkInfraCondition',
            });
        });

        it('outputs CiGlueDatabaseName with condition', () => {
            template.hasOutput('CiGlueDatabaseName', {
                Value: 'mlcc_ci',
                Condition: 'BenchmarkInfraCondition',
            });
        });
    });

    describe('Stage 2 Failure Isolation (Req 1.4, 7.3)', () => {
        it('Stage2FailureHandler state exists in the state machine definition', () => {
            // The Step Functions state machine definition should include the
            // Stage2FailureHandler state that only writes benchmark fields
            const json = template.toJSON();
            const stateMachines = Object.keys(json.Resources).filter(
                key => json.Resources[key].Type === 'AWS::StepFunctions::StateMachine'
            );
            assert.ok(stateMachines.length >= 1, 'Should have at least one state machine');

            // Get the state machine definition (stored as Fn::Join)
            const smResource = json.Resources[stateMachines[0]];
            const defStr = smResource.Properties.DefinitionString;
            let definitionText = '';
            if (typeof defStr === 'object' && defStr['Fn::Join']) {
                const parts = defStr['Fn::Join'][1] as any[];
                definitionText = parts.map((p: any) => typeof p === 'string' ? p : JSON.stringify(p)).join('');
            }

            // Verify Stage2FailureHandler state exists
            assert.ok(
                definitionText.includes('Stage2FailureHandler'),
                'State machine should contain Stage2FailureHandler state'
            );
        });

        it('Stage2FailureHandler UpdateExpression only sets benchmark fields', () => {
            const json = template.toJSON();
            const stateMachines = Object.keys(json.Resources).filter(
                key => json.Resources[key].Type === 'AWS::StepFunctions::StateMachine'
            );
            const smResource = json.Resources[stateMachines[0]];
            const defStr = smResource.Properties.DefinitionString;
            let definitionText = '';
            if (typeof defStr === 'object' && defStr['Fn::Join']) {
                const parts = defStr['Fn::Join'][1] as any[];
                definitionText = parts.map((p: any) => typeof p === 'string' ? p : JSON.stringify(p)).join('');
            }

            // Verify the UpdateExpression only sets benchmark-specific fields
            assert.ok(
                definitionText.includes('lastBenchmarkRunId'),
                'Stage2FailureHandler should write lastBenchmarkRunId'
            );
            assert.ok(
                definitionText.includes('lastBenchmarkTimestamp'),
                'Stage2FailureHandler should write lastBenchmarkTimestamp'
            );
            assert.ok(
                definitionText.includes('lastBenchmarkStatus'),
                'Stage2FailureHandler should write lastBenchmarkStatus'
            );

            // Verify it uses SET expression for only benchmark fields
            assert.ok(
                definitionText.includes('SET lastBenchmarkRunId = :rid, lastBenchmarkTimestamp = :ts, lastBenchmarkStatus = :status'),
                'Stage2FailureHandler should use SET expression targeting only 3 benchmark fields'
            );
        });

        it('Stage2Benchmark Catch routes to Stage2FailureHandler', () => {
            const json = template.toJSON();
            const stateMachines = Object.keys(json.Resources).filter(
                key => json.Resources[key].Type === 'AWS::StepFunctions::StateMachine'
            );
            const smResource = json.Resources[stateMachines[0]];
            const defStr = smResource.Properties.DefinitionString;
            let definitionText = '';
            if (typeof defStr === 'object' && defStr['Fn::Join']) {
                const parts = defStr['Fn::Join'][1] as any[];
                definitionText = parts.map((p: any) => typeof p === 'string' ? p : JSON.stringify(p)).join('');
            }

            // The Stage2Benchmark state should have a Catch block pointing to Stage2FailureHandler
            // Look for the pattern: "Next":"Stage2FailureHandler" in a Catch context
            assert.ok(
                definitionText.includes('"Next":"Stage2FailureHandler"'),
                'Stage2Benchmark Catch should route to Stage2FailureHandler'
            );
        });

        it('Stage2FailureHandler does NOT reference testStatus in UpdateExpression', () => {
            const json = template.toJSON();
            const stateMachines = Object.keys(json.Resources).filter(
                key => json.Resources[key].Type === 'AWS::StepFunctions::StateMachine'
            );
            const smResource = json.Resources[stateMachines[0]];
            const defStr = smResource.Properties.DefinitionString;
            let definitionText = '';
            if (typeof defStr === 'object' && defStr['Fn::Join']) {
                const parts = defStr['Fn::Join'][1] as any[];
                definitionText = parts.map((p: any) => typeof p === 'string' ? p : JSON.stringify(p)).join('');
            }

            // Extract the Stage2FailureHandler state definition
            const handlerIdx = definitionText.indexOf('"Stage2FailureHandler"');
            // The UpdateExpression for this state should not contain testStatus
            // Get the next ~500 chars from the handler state
            const handlerSection = definitionText.substring(handlerIdx, handlerIdx + 500);
            assert.ok(
                !handlerSection.includes('testStatus'),
                'Stage2FailureHandler must NOT reference testStatus in its UpdateExpression'
            );
        });
    });
});
