// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * Wave 9 CDK assertion checks (R11.2, IAM for the price resolver). Synthesizes the
 * benchmark and ci stacks in-process with aws-cdk-lib/assertions — no AWS calls,
 * no cdk CLI.
 *
 * Driven by test/unit/bootstrap-benchmark-w9-cdk.test.js, which compares the
 * synthesized BenchmarkResultsTable column list with the writer's PARQUET_COLUMNS.
 * This file checks the parts that make the Glue rollout an in-place Modify:
 *   - BenchmarkResultsTable keeps its construct-path logical ID;
 *   - the create-only properties (CatalogId, DatabaseName) and TableInput.Name /
 *     PartitionKeys are unchanged, so CloudFormation updates TableInput in place;
 * and that the bootstrapped CI CodeBuild role (it runs the benchmark writer) can call
 * pricing:GetProducts and reconcile Glue partitions.
 * Prints a JSON summary (columns + logical ID) on success; throws on failure.
 */
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { MlccBenchmarkStack } from '../benchmark/stack';
import { MlccCiStack } from '../ci/stack';

const ACCOUNT = '111111111111';
const REGION = 'us-west-2';
const PROFILE = 'zz-test';
const env = { account: ACCOUNT, region: REGION };

function fail(msg: string): never {
    throw new Error(msg);
}

const bench = Template.fromStack(new MlccBenchmarkStack(new cdk.App(), `mlcc-${PROFILE}-benchmark`, { env, profileName: PROFILE }));
const tables = bench.findResources('AWS::Glue::Table');
const tableIds = Object.keys(tables);
if (tableIds.length !== 1) fail(`expected one Glue table, found ${tableIds.length}`);
const tableId = tableIds[0];
if (!/^BenchmarkResultsTable$/.test(tableId)) fail(`BenchmarkResultsTable logical ID changed: ${tableId}`);
// Create-only properties: a change here would REPLACE the table (data catalog loss).
bench.hasResourceProperties('AWS::Glue::Table', {
    CatalogId: ACCOUNT,
    DatabaseName: 'mlcc_ci',
    TableInput: Match.objectLike({
        Name: 'benchmark_results',
        TableType: 'EXTERNAL_TABLE',
        PartitionKeys: [
            Match.objectLike({ Name: 'model', Type: 'string' }),
            Match.objectLike({ Name: 'instance', Type: 'string' }),
            Match.objectLike({ Name: 'target', Type: 'string' }),
        ],
    }),
});
type Col = { Name: string; Type: string };
const props = (tables[tableId] as { Properties: { TableInput: { StorageDescriptor: { Columns: Col[] } } } }).Properties;
const columns = props.TableInput.StorageDescriptor.Columns.map(c => ({ name: c.Name, type: c.Type }));
const seen = new Set<string>();
for (const c of columns) {
    if (seen.has(c.name)) fail(`duplicate Glue column ${c.name}`);
    seen.add(c.name);
}

const ci = Template.fromStack(new MlccCiStack(new cdk.App(), `mlcc-${PROFILE}-ci`, { env, profileName: PROFILE }));
ci.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
            Match.objectLike({ Sid: 'BenchmarkPriceLookup', Action: 'pricing:GetProducts', Effect: 'Allow', Resource: '*' }),
            Match.objectLike({
                Sid: 'BenchmarkPartitionRegister',
                Effect: 'Allow',
                Action: ['glue:GetTable', 'glue:GetPartition', 'glue:BatchCreatePartition', 'glue:UpdatePartition'],
            }),
        ]),
    }),
});

console.log(JSON.stringify({ ok: true, tableLogicalId: tableId, columns }));
