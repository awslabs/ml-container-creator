import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

/**
 * Scanner Lambda handler — queries the CI_Table GSI for records that need
 * re-testing and starts Step Functions executions directly.
 *
 * Query pattern (uses GSI `testStatus-lastTestTimestamp-index`):
 *   1. All records with testStatus = 'untested'
 *   2. Records with testStatus IN (pass, fail-generate, fail-validate,
 *      fail-build, fail-deploy, fail-test) AND lastTestTimestamp < now - 24h
 *
 * Records with testStatus = 'running' are always excluded.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 14.1
 */

const TABLE_NAME = process.env.CI_TABLE_NAME ?? '';
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN ?? '';
const GSI_NAME = process.env.GSI_NAME ?? 'testStatus-lastTestTimestamp-index';

const dynamodb = new DynamoDBClient({});
const sfn = new SFNClient({});

/** Default build strategy when the attribute is missing from a record. */
const DEFAULT_BUILD_STRATEGY = 'codebuild-submit';

/**
 * Status values that qualify for stale-record re-testing (all except 'running'
 * and 'untested', which is handled separately without a timestamp filter).
 */
const STALE_STATUSES = [
    'pass',
    'fail-generate',
    'fail-validate',
    'fail-build',
    'fail-deploy',
    'fail-test',
];

interface CiRecord {
    configId: string;
    configJson: string;
    buildStrategy: string;
}

/**
 * Query all 'untested' records from the GSI. No timestamp filter needed —
 * every untested record should be picked up.
 */
async function queryUntestedRecords(): Promise<CiRecord[]> {
    const records: CiRecord[] = [];
    let exclusiveStartKey: Record<string, any> | undefined;

    do {
        const command = new QueryCommand({
            TableName: TABLE_NAME,
            IndexName: GSI_NAME,
            KeyConditionExpression: 'testStatus = :status',
            ExpressionAttributeValues: {
                ':status': { S: 'untested' },
            },
            ProjectionExpression: 'configId, configJson, buildStrategy',
            ExclusiveStartKey: exclusiveStartKey,
        });

        const result = await dynamodb.send(command);

        for (const item of result.Items ?? []) {
            records.push({
                configId: item.configId?.S ?? '',
                configJson: item.configJson?.S ?? '',
                buildStrategy: item.buildStrategy?.S ?? DEFAULT_BUILD_STRATEGY,
            });
        }

        exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);

    return records;
}

/**
 * Query records for a specific testStatus where lastTestTimestamp is older
 * than the given cutoff (ISO 8601 string comparison works because the format
 * is lexicographically sortable).
 */
async function queryStaleRecordsByStatus(
    status: string,
    cutoffTimestamp: string
): Promise<CiRecord[]> {
    const records: CiRecord[] = [];
    let exclusiveStartKey: Record<string, any> | undefined;

    do {
        const command = new QueryCommand({
            TableName: TABLE_NAME,
            IndexName: GSI_NAME,
            KeyConditionExpression:
                'testStatus = :status AND lastTestTimestamp < :cutoff',
            ExpressionAttributeValues: {
                ':status': { S: status },
                ':cutoff': { S: cutoffTimestamp },
            },
            ProjectionExpression: 'configId, configJson, buildStrategy',
            ExclusiveStartKey: exclusiveStartKey,
        });

        const result = await dynamodb.send(command);

        for (const item of result.Items ?? []) {
            records.push({
                configId: item.configId?.S ?? '',
                configJson: item.configJson?.S ?? '',
                buildStrategy: item.buildStrategy?.S ?? DEFAULT_BUILD_STRATEGY,
            });
        }

        exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);

    return records;
}

/**
 * Start a Step Functions execution for a CI record.
 * Returns the execution ARN on success, or null on failure.
 */
async function startExecution(record: CiRecord): Promise<string | null> {
    try {
        const input = JSON.stringify({
            configId: record.configId,
            configJson: record.configJson,
            buildStrategy: record.buildStrategy,
        });

        const command = new StartExecutionCommand({
            stateMachineArn: STATE_MACHINE_ARN,
            input,
        });

        const result = await sfn.send(command);
        return result.executionArn ?? null;
    } catch (error) {
        console.error(
            `Failed to start execution for ${record.configId}:`,
            error
        );
        return null;
    }
}

/**
 * Lambda entry point. Invoked on an hourly EventBridge schedule or manually via do/ci trigger.
 */
export async function handler(): Promise<{ executionArns: string[] }> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const cutoffTimestamp = cutoff.toISOString();

    // 1. Collect qualifying records from multiple GSI queries
    const allRecords: CiRecord[] = [];

    // 1a. All untested records (no timestamp filter)
    const untestedRecords = await queryUntestedRecords();
    allRecords.push(...untestedRecords);

    // 1b. Stale records for each non-running status
    for (const status of STALE_STATUSES) {
        const staleRecords = await queryStaleRecordsByStatus(
            status,
            cutoffTimestamp
        );
        allRecords.push(...staleRecords);
    }

    const totalFound = allRecords.length;

    if (totalFound === 0) {
        console.log('Found 0 qualifying records, started 0 executions');
        return { executionArns: [] };
    }

    // 2. Start Step Functions execution for each record
    const executionArns: string[] = [];

    for (const record of allRecords) {
        const arn = await startExecution(record);
        if (arn) {
            executionArns.push(arn);
        }
    }

    console.log(
        `Found ${totalFound} qualifying records, started ${executionArns.length} executions`
    );

    return { executionArns };
}
