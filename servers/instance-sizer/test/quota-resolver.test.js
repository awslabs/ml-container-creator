#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the Quota Resolver.
 * Uses node:assert only — no external test framework.
 * Run: node servers/instance-sizer/test/quota-resolver.test.js
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 7.1, 7.2, 7.3, 7.4
 */

import assert from 'node:assert';
import {
    QuotaResolver,
    QUOTA_NAME_PATTERN,
    SAGEMAKER_SERVICE_CODE,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_CACHE_TTL_MS
} from '../lib/quota-resolver.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        const result = fn();
        if (result && typeof result.then === 'function') {
            return result.then(() => {
                passed++;
                console.log(`  ✓ ${name}`);
            }).catch((err) => {
                failed++;
                console.error(`  ✗ ${name}`);
                console.error(`    ${err.message}`);
            });
        }
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
    }
}

/**
 * Creates a QuotaResolver with mocked AWS SDK clients.
 * Overrides the internal clients after construction.
 */
function createMockedResolver(options = {}) {
    const resolver = new QuotaResolver('us-east-1', {
        timeout: options.timeout || 5000,
        cacheTtl: options.cacheTtl || 300000
    });

    // Replace clients with mocks. Only Service Quotas + SageMaker are used;
    // capacity reservations are sourced from SageMaker ListTrainingPlans (the
    // EC2 DescribeCapacityReservations design is deferred to a future EC2-based
    // deployment target — see the capacity-reservations section below).
    resolver.quotasClient = {
        send: options.quotasSend || (() => Promise.resolve({ Quotas: [], NextToken: undefined }))
    };
    resolver.sagemakerClient = {
        send: options.sagemakerSend || (() => Promise.resolve({ Endpoints: [], NextToken: undefined }))
    };

    return resolver;
}

async function run() {
    // ── Constants Validation ─────────────────────────────────────────────────

    console.log('\nquota-resolver: constants\n');

    test('SAGEMAKER_SERVICE_CODE is sagemaker', () => {
        assert.strictEqual(SAGEMAKER_SERVICE_CODE, 'sagemaker');
    });

    test('DEFAULT_TIMEOUT_MS is 10000', () => {
        assert.strictEqual(DEFAULT_TIMEOUT_MS, 10000);
    });

    test('DEFAULT_CACHE_TTL_MS is 300000 (5 minutes)', () => {
        assert.strictEqual(DEFAULT_CACHE_TTL_MS, 300000);
    });

    // ── Quota Name Parsing ───────────────────────────────────────────────────

    console.log('\nquota-resolver: quota name parsing\n');

    test('QUOTA_NAME_PATTERN extracts ml.g5.xlarge from endpoint usage quota', () => {
        const match = 'ml.g5.xlarge for endpoint usage'.match(QUOTA_NAME_PATTERN);
        assert.ok(match, 'should match');
        assert.strictEqual(match[1], 'ml.g5.xlarge');
    });

    test('QUOTA_NAME_PATTERN extracts ml.p4d.24xlarge from endpoint usage quota', () => {
        const match = 'ml.p4d.24xlarge for endpoint usage'.match(QUOTA_NAME_PATTERN);
        assert.ok(match, 'should match');
        assert.strictEqual(match[1], 'ml.p4d.24xlarge');
    });

    test('QUOTA_NAME_PATTERN extracts ml.g4dn.2xlarge from endpoint usage quota', () => {
        const match = 'ml.g4dn.2xlarge for endpoint usage'.match(QUOTA_NAME_PATTERN);
        assert.ok(match, 'should match');
        assert.strictEqual(match[1], 'ml.g4dn.2xlarge');
    });

    test('QUOTA_NAME_PATTERN does not match training job quotas', () => {
        const match = 'ml.g5.xlarge for training job usage'.match(QUOTA_NAME_PATTERN);
        assert.strictEqual(match, null);
    });

    test('QUOTA_NAME_PATTERN does not match non-instance quota names', () => {
        const match = 'Number of instances across active endpoints'.match(QUOTA_NAME_PATTERN);
        assert.strictEqual(match, null);
    });

    test('QUOTA_NAME_PATTERN does not match empty string', () => {
        const match = ''.match(QUOTA_NAME_PATTERN);
        assert.strictEqual(match, null);
    });

    test('_parseQuotaName extracts instance type correctly', () => {
        const resolver = createMockedResolver();
        assert.strictEqual(resolver._parseQuotaName('ml.g5.xlarge for endpoint usage'), 'ml.g5.xlarge');
    });

    test('_parseQuotaName returns null for non-matching pattern', () => {
        const resolver = createMockedResolver();
        assert.strictEqual(resolver._parseQuotaName('some random quota name'), null);
    });

    test('_parseQuotaName returns null for empty string', () => {
        const resolver = createMockedResolver();
        assert.strictEqual(resolver._parseQuotaName(''), null);
    });

    // ── Headroom Calculation ─────────────────────────────────────────────────

    console.log('\nquota-resolver: headroom calculation\n');

    await test('headroom = quota - deployed (5 - 2 = 3)', async () => {
        // _fetchDeployedCounts is a two-step flow: ListEndpoints (returns endpoint
        // NAMES) then DescribeEndpoint per name (returns ProductionVariants with
        // the live instance count). The mock dispatches on the command class name.
        const resolver = createMockedResolver({
            quotasSend: () => Promise.resolve({
                Quotas: [
                    { QuotaName: 'ml.g5.xlarge for endpoint usage', Value: 5 },
                    { QuotaName: 'ml.g5.2xlarge for endpoint usage', Value: 3 }
                ],
                NextToken: undefined
            }),
            sagemakerSend: (command) => {
                const kind = command?.constructor?.name;
                if (kind === 'ListEndpointsCommand') {
                    return Promise.resolve({
                        Endpoints: [{ EndpointName: 'ep-1', EndpointStatus: 'InService' }],
                        NextToken: undefined
                    });
                }
                if (kind === 'DescribeEndpointCommand') {
                    return Promise.resolve({
                        EndpointName: 'ep-1',
                        ProductionVariants: [
                            { InstanceType: 'ml.g5.xlarge', CurrentInstanceCount: 2 }
                        ]
                    });
                }
                return Promise.resolve({});
            }
        });

        const result = await resolver.getQuotaHeadroom(['ml.g5.xlarge', 'ml.g5.2xlarge']);
        assert.ok(result instanceof Map, 'should return a Map');
        assert.strictEqual(result.get('ml.g5.xlarge').quota, 5);
        assert.strictEqual(result.get('ml.g5.xlarge').deployed, 2);
        assert.strictEqual(result.get('ml.g5.xlarge').headroom, 3);
    });

    await test('headroom is full quota when no instances deployed', async () => {
        const resolver = createMockedResolver({
            quotasSend: () => Promise.resolve({
                Quotas: [
                    { QuotaName: 'ml.g5.xlarge for endpoint usage', Value: 5 }
                ],
                NextToken: undefined
            }),
            sagemakerSend: () => Promise.resolve({
                Endpoints: [],
                NextToken: undefined
            })
        });

        const result = await resolver.getQuotaHeadroom(['ml.g5.xlarge']);
        assert.strictEqual(result.get('ml.g5.xlarge').quota, 5);
        assert.strictEqual(result.get('ml.g5.xlarge').deployed, 0);
        assert.strictEqual(result.get('ml.g5.xlarge').headroom, 5);
    });

    await test('headroom is zero when fully utilized', async () => {
        const resolver = createMockedResolver({
            quotasSend: () => Promise.resolve({
                Quotas: [
                    { QuotaName: 'ml.g5.xlarge for endpoint usage', Value: 2 }
                ],
                NextToken: undefined
            }),
            sagemakerSend: (command) => {
                const kind = command?.constructor?.name;
                if (kind === 'ListEndpointsCommand') {
                    return Promise.resolve({
                        Endpoints: [{ EndpointName: 'ep-1', EndpointStatus: 'InService' }],
                        NextToken: undefined
                    });
                }
                if (kind === 'DescribeEndpointCommand') {
                    return Promise.resolve({
                        EndpointName: 'ep-1',
                        ProductionVariants: [
                            { InstanceType: 'ml.g5.xlarge', CurrentInstanceCount: 2 }
                        ]
                    });
                }
                return Promise.resolve({});
            }
        });

        const result = await resolver.getQuotaHeadroom(['ml.g5.xlarge']);
        assert.strictEqual(result.get('ml.g5.xlarge').headroom, 0);
    });

    await test('only returns headroom for requested instance types', async () => {
        const resolver = createMockedResolver({
            quotasSend: () => Promise.resolve({
                Quotas: [
                    { QuotaName: 'ml.g5.xlarge for endpoint usage', Value: 5 },
                    { QuotaName: 'ml.p4d.24xlarge for endpoint usage', Value: 1 }
                ],
                NextToken: undefined
            }),
            sagemakerSend: () => Promise.resolve({
                Endpoints: [],
                NextToken: undefined
            })
        });

        const result = await resolver.getQuotaHeadroom(['ml.g5.xlarge']);
        assert.ok(result.has('ml.g5.xlarge'), 'should have requested type');
        assert.ok(!result.has('ml.p4d.24xlarge'), 'should not have unrequested type');
    });

    // ── API Failure Graceful Degradation ─────────────────────────────────────

    console.log('\nquota-resolver: graceful degradation on API failure\n');

    await test('getQuotaHeadroom returns null on AccessDeniedException', async () => {
        const resolver = createMockedResolver({
            quotasSend: () => {
                const err = new Error('Access Denied');
                err.name = 'AccessDeniedException';
                return Promise.reject(err);
            },
            sagemakerSend: () => {
                const err = new Error('Access Denied');
                err.name = 'AccessDeniedException';
                return Promise.reject(err);
            }
        });

        const result = await resolver.getQuotaHeadroom(['ml.g5.xlarge']);
        assert.strictEqual(result, null);
    });

    await test('getQuotaHeadroom returns null on ThrottlingException', async () => {
        const resolver = createMockedResolver({
            quotasSend: () => {
                const err = new Error('Rate exceeded');
                err.name = 'ThrottlingException';
                return Promise.reject(err);
            },
            sagemakerSend: () => Promise.resolve({ Endpoints: [], NextToken: undefined })
        });

        const result = await resolver.getQuotaHeadroom(['ml.g5.xlarge']);
        assert.strictEqual(result, null);
    });

    await test('getQuotaHeadroom returns null on generic error', async () => {
        const resolver = createMockedResolver({
            quotasSend: () => Promise.reject(new Error('Network timeout')),
            sagemakerSend: () => Promise.resolve({ Endpoints: [], NextToken: undefined })
        });

        const result = await resolver.getQuotaHeadroom(['ml.g5.xlarge']);
        assert.strictEqual(result, null);
    });

    await test('getTrainingPlans returns null on AccessDeniedException', async () => {
        const resolver = createMockedResolver({
            sagemakerSend: () => {
                const err = new Error('Access Denied');
                err.name = 'AccessDeniedException';
                return Promise.reject(err);
            }
        });

        const result = await resolver.getTrainingPlans();
        assert.strictEqual(result, null);
    });

    await test('getTrainingPlans returns null on ValidationException (region not supported)', async () => {
        const resolver = createMockedResolver({
            sagemakerSend: () => {
                const err = new Error('Operation not available');
                err.name = 'ValidationException';
                return Promise.reject(err);
            }
        });

        const result = await resolver.getTrainingPlans();
        assert.strictEqual(result, null);
    });

    // ── Cache Behavior ───────────────────────────────────────────────────────

    console.log('\nquota-resolver: cache behavior\n');

    await test('second call within TTL returns cached data without API call', async () => {
        let apiCallCount = 0;
        const resolver = createMockedResolver({
            cacheTtl: 60000,
            quotasSend: () => {
                apiCallCount++;
                return Promise.resolve({
                    Quotas: [
                        { QuotaName: 'ml.g5.xlarge for endpoint usage', Value: 5 }
                    ],
                    NextToken: undefined
                });
            },
            sagemakerSend: () => {
                apiCallCount++;
                return Promise.resolve({
                    Endpoints: [],
                    NextToken: undefined
                });
            }
        });

        // First call — should hit API
        const result1 = await resolver.getQuotaHeadroom(['ml.g5.xlarge']);
        const callsAfterFirst = apiCallCount;

        // Second call — should use cache
        const result2 = await resolver.getQuotaHeadroom(['ml.g5.xlarge']);

        assert.strictEqual(apiCallCount, callsAfterFirst, 'should not make additional API calls on cache hit');
        assert.deepStrictEqual(result1, result2, 'cached result should match first result');
    });

    await test('cache expires after TTL', async () => {
        let apiCallCount = 0;
        const resolver = createMockedResolver({
            cacheTtl: 1, // 1ms TTL for testing
            quotasSend: () => {
                apiCallCount++;
                return Promise.resolve({
                    Quotas: [
                        { QuotaName: 'ml.g5.xlarge for endpoint usage', Value: 5 }
                    ],
                    NextToken: undefined
                });
            },
            sagemakerSend: () => {
                apiCallCount++;
                return Promise.resolve({
                    Endpoints: [],
                    NextToken: undefined
                });
            }
        });

        // First call
        await resolver.getQuotaHeadroom(['ml.g5.xlarge']);
        const callsAfterFirst = apiCallCount;

        // Wait for TTL to expire
        await new Promise(resolve => setTimeout(resolve, 10));

        // Second call — cache should be expired
        await resolver.getQuotaHeadroom(['ml.g5.xlarge']);
        assert.ok(apiCallCount > callsAfterFirst, 'should make new API calls after cache expires');
    });

    await test('getTrainingPlans uses cache on second call', async () => {
        let apiCallCount = 0;
        const resolver = createMockedResolver({
            cacheTtl: 60000,
            sagemakerSend: () => {
                apiCallCount++;
                return Promise.resolve({
                    TrainingPlanSummaries: [],
                    NextToken: undefined
                });
            }
        });

        await resolver.getTrainingPlans();
        const callsAfterFirst = apiCallCount;

        await resolver.getTrainingPlans();
        assert.strictEqual(apiCallCount, callsAfterFirst, 'should use cache on second call');
    });

    // ── Timeout Handling ─────────────────────────────────────────────────────

    console.log('\nquota-resolver: timeout handling\n');

    await test('timeout error is handled gracefully (returns null)', async () => {
        const resolver = createMockedResolver({
            timeout: 5000,
            quotasSend: () => {
                const err = new Error('Connection timed out after 5000ms');
                err.name = 'TimeoutError';
                return Promise.reject(err);
            },
            sagemakerSend: () => {
                const err = new Error('Connection timed out after 5000ms');
                err.name = 'TimeoutError';
                return Promise.reject(err);
            }
        });

        const result = await resolver.getQuotaHeadroom(['ml.g5.xlarge']);
        assert.strictEqual(result, null, 'should return null on timeout');
    });

    await test('constructor sets timeout to 10000ms by default', () => {
        const resolver = new QuotaResolver('us-east-1');
        assert.strictEqual(resolver.timeout, 10000);
    });

    await test('constructor accepts custom timeout', () => {
        const resolver = new QuotaResolver('us-east-1', { timeout: 7500 });
        assert.strictEqual(resolver.timeout, 7500);
    });

    // ── getCapacityReservations (SageMaker Training Plans) ──────────────────────
    // MLCC's capacity reservations for inference endpoints come from SageMaker
    // Flexible Training Plans (ListTrainingPlans, TargetResources including
    // 'endpoint'), NOT EC2 ODCR / Capacity Blocks. EC2 DescribeCapacityReservations
    // is deferred to a future EC2-based deployment target (v2). The returned shape
    // is { planName, planArn, type: 'training-plan', count, startDate, endDate }.

    console.log('\nquota-resolver: getCapacityReservations (SageMaker Training Plans)\n');

    await test('returns Map of instance types with training-plan reservation info', async () => {
        const resolver = createMockedResolver({
            sagemakerSend: () => Promise.resolve({
                TrainingPlanSummaries: [
                    {
                        TrainingPlanName: 'endpoint-plan',
                        TrainingPlanArn: 'arn:aws:sagemaker:us-east-1:123456789012:training-plan/endpoint-plan',
                        InstanceType: 'ml.p4d.24xlarge',
                        TargetResources: ['endpoint'],
                        AvailableInstanceCount: 3,
                        StartTime: '2025-01-01T00:00:00Z',
                        EndTime: null
                    }
                ],
                NextToken: undefined
            })
        });

        const result = await resolver.getCapacityReservations();
        assert.ok(result instanceof Map, 'should return a Map');
        assert.ok(result.has('ml.p4d.24xlarge'), 'should key on the plan instance type');
        const info = result.get('ml.p4d.24xlarge');
        assert.strictEqual(info.planName, 'endpoint-plan');
        assert.strictEqual(info.planArn, 'arn:aws:sagemaker:us-east-1:123456789012:training-plan/endpoint-plan');
        assert.strictEqual(info.type, 'training-plan');
        assert.strictEqual(info.count, 3);
    });

    await test('includes training plans within their time window', async () => {
        const now = new Date();
        const pastDate = new Date(now.getTime() - 86400000).toISOString(); // yesterday
        const futureDate = new Date(now.getTime() + 86400000).toISOString(); // tomorrow

        const resolver = createMockedResolver({
            sagemakerSend: () => Promise.resolve({
                TrainingPlanSummaries: [
                    {
                        TrainingPlanName: 'active-window-plan',
                        TrainingPlanArn: 'arn:aws:sagemaker:us-east-1:123456789012:training-plan/active-window-plan',
                        InstanceType: 'ml.p5.48xlarge',
                        TargetResources: ['endpoint'],
                        AvailableInstanceCount: 2,
                        StartTime: pastDate,
                        EndTime: futureDate
                    }
                ],
                NextToken: undefined
            })
        });

        const result = await resolver.getCapacityReservations();
        assert.ok(result.has('ml.p5.48xlarge'), 'in-window plan should be included');
        const info = result.get('ml.p5.48xlarge');
        assert.strictEqual(info.type, 'training-plan');
        assert.strictEqual(info.count, 2);
        assert.ok(info.startDate, 'should carry startDate');
        assert.ok(info.endDate, 'should carry endDate');
    });

    await test('excludes expired training plans (endDate in the past)', async () => {
        const pastStart = new Date(Date.now() - 172800000).toISOString(); // 2 days ago
        const pastEnd = new Date(Date.now() - 86400000).toISOString(); // yesterday

        const resolver = createMockedResolver({
            sagemakerSend: () => Promise.resolve({
                TrainingPlanSummaries: [
                    {
                        TrainingPlanName: 'expired-plan',
                        InstanceType: 'ml.p4d.24xlarge',
                        TargetResources: ['endpoint'],
                        AvailableInstanceCount: 4,
                        StartTime: pastStart,
                        EndTime: pastEnd
                    }
                ],
                NextToken: undefined
            })
        });

        const result = await resolver.getCapacityReservations();
        assert.ok(result instanceof Map, 'should return a Map');
        assert.strictEqual(result.size, 0, 'should exclude expired plan');
    });

    await test('excludes training plans not yet started (startDate in the future)', async () => {
        const futureStart = new Date(Date.now() + 86400000).toISOString(); // tomorrow
        const futureEnd = new Date(Date.now() + 172800000).toISOString(); // 2 days from now

        const resolver = createMockedResolver({
            sagemakerSend: () => Promise.resolve({
                TrainingPlanSummaries: [
                    {
                        TrainingPlanName: 'future-plan',
                        InstanceType: 'ml.g5.2xlarge',
                        TargetResources: ['endpoint'],
                        AvailableInstanceCount: 2,
                        StartTime: futureStart,
                        EndTime: futureEnd
                    }
                ],
                NextToken: undefined
            })
        });

        const result = await resolver.getCapacityReservations();
        assert.ok(result instanceof Map, 'should return a Map');
        assert.strictEqual(result.size, 0, 'should exclude not-yet-started plan');
    });

    await test('excludes plans that do not target inference endpoints', async () => {
        const resolver = createMockedResolver({
            sagemakerSend: () => Promise.resolve({
                TrainingPlanSummaries: [
                    {
                        TrainingPlanName: 'training-only-plan',
                        InstanceType: 'ml.p4d.24xlarge',
                        TargetResources: ['training-job'],
                        AvailableInstanceCount: 4,
                        StartTime: '2025-01-01T00:00:00Z',
                        EndTime: null
                    }
                ],
                NextToken: undefined
            })
        });

        const result = await resolver.getCapacityReservations();
        assert.strictEqual(result.size, 0, 'should exclude plans not targeting endpoints');
    });

    await test('returns empty Map when no plans exist', async () => {
        const resolver = createMockedResolver({
            sagemakerSend: () => Promise.resolve({
                TrainingPlanSummaries: [],
                NextToken: undefined
            })
        });

        const result = await resolver.getCapacityReservations();
        assert.ok(result instanceof Map, 'should return a Map');
        assert.strictEqual(result.size, 0, 'should be empty when no plans');
    });

    await test('excludes plans with zero remaining capacity', async () => {
        const resolver = createMockedResolver({
            sagemakerSend: () => Promise.resolve({
                TrainingPlanSummaries: [
                    {
                        TrainingPlanName: 'exhausted-plan',
                        InstanceType: 'ml.g5.xlarge',
                        TargetResources: ['endpoint'],
                        AvailableInstanceCount: 0,
                        StartTime: '2025-01-01T00:00:00Z',
                        EndTime: null
                    }
                ],
                NextToken: undefined
            })
        });

        const result = await resolver.getCapacityReservations();
        assert.strictEqual(result.size, 0, 'should exclude plans with zero capacity');
    });

    await test('getCapacityReservations returns null on AccessDeniedException', async () => {
        const resolver = createMockedResolver({
            sagemakerSend: () => {
                const err = new Error('Access Denied');
                err.name = 'AccessDeniedException';
                return Promise.reject(err);
            }
        });

        const result = await resolver.getCapacityReservations();
        assert.strictEqual(result, null);
    });

    await test('getCapacityReservations returns null on ThrottlingException', async () => {
        const resolver = createMockedResolver({
            sagemakerSend: () => {
                const err = new Error('Rate exceeded');
                err.name = 'ThrottlingException';
                return Promise.reject(err);
            }
        });

        const result = await resolver.getCapacityReservations();
        assert.strictEqual(result, null);
    });

    await test('getCapacityReservations uses cache on second call', async () => {
        let apiCallCount = 0;
        const resolver = createMockedResolver({
            cacheTtl: 60000,
            sagemakerSend: () => {
                apiCallCount++;
                return Promise.resolve({
                    TrainingPlanSummaries: [
                        {
                            TrainingPlanName: 'cached-plan',
                            InstanceType: 'ml.g5.xlarge',
                            TargetResources: ['endpoint'],
                            AvailableInstanceCount: 1,
                            StartTime: '2025-01-01T00:00:00Z',
                            EndTime: null
                        }
                    ],
                    NextToken: undefined
                });
            }
        });

        await resolver.getCapacityReservations();
        const callsAfterFirst = apiCallCount;

        await resolver.getCapacityReservations();
        assert.strictEqual(apiCallCount, callsAfterFirst, 'should use cache on second call');
    });

    // ── getTrainingPlans ─────────────────────────────────────────────────────

    console.log('\nquota-resolver: getTrainingPlans\n');

    await test('returns Map of instance types with plan info', async () => {
        const resolver = createMockedResolver({
            sagemakerSend: () => Promise.resolve({
                TrainingPlanSummaries: [
                    {
                        TrainingPlanName: 'my-plan',
                        InstanceType: 'ml.p4d.24xlarge',
                        AvailableInstanceCount: 4,
                        EndTime: '2025-06-30T00:00:00Z'
                    }
                ],
                NextToken: undefined
            })
        });

        const result = await resolver.getTrainingPlans();
        assert.ok(result instanceof Map, 'should return a Map');
        assert.ok(result.has('ml.p4d.24xlarge'), 'should have the instance type');
        const info = result.get('ml.p4d.24xlarge');
        assert.strictEqual(info.planName, 'my-plan');
        assert.strictEqual(info.remainingCapacity, 4);
        assert.strictEqual(info.expiresAt, '2025-06-30T00:00:00Z');
    });

    await test('returns empty Map when no active plans exist', async () => {
        const resolver = createMockedResolver({
            sagemakerSend: () => Promise.resolve({
                TrainingPlanSummaries: [],
                NextToken: undefined
            })
        });

        const result = await resolver.getTrainingPlans();
        assert.ok(result instanceof Map, 'should return a Map');
        assert.strictEqual(result.size, 0, 'should be empty when no plans');
    });

    await test('skips plans with zero remaining capacity', async () => {
        const resolver = createMockedResolver({
            sagemakerSend: () => Promise.resolve({
                TrainingPlanSummaries: [
                    {
                        TrainingPlanName: 'exhausted-plan',
                        InstanceType: 'ml.p4d.24xlarge',
                        AvailableInstanceCount: 0,
                        EndTime: '2025-06-30T00:00:00Z'
                    }
                ],
                NextToken: undefined
            })
        });

        const result = await resolver.getTrainingPlans();
        assert.strictEqual(result.size, 0, 'should skip plans with zero capacity');
    });

    // ── Summary ──────────────────────────────────────────────────────────────

    console.log(`\n  ${passed} passing, ${failed} failing\n`);
    process.exit(failed > 0 ? 1 : 0);
}

run();
