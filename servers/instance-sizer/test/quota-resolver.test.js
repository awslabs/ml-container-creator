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

import assert from 'node:assert'
import {
    QuotaResolver,
    QUOTA_NAME_PATTERN,
    SAGEMAKER_SERVICE_CODE,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_CACHE_TTL_MS
} from '../lib/quota-resolver.js'

let passed = 0
let failed = 0

function test(name, fn) {
    try {
        const result = fn()
        if (result && typeof result.then === 'function') {
            return result.then(() => {
                passed++
                console.log(`  ✓ ${name}`)
            }).catch((err) => {
                failed++
                console.error(`  ✗ ${name}`)
                console.error(`    ${err.message}`)
            })
        }
        passed++
        console.log(`  ✓ ${name}`)
    } catch (err) {
        failed++
        console.error(`  ✗ ${name}`)
        console.error(`    ${err.message}`)
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
    })

    // Replace clients with mocks
    resolver.quotasClient = {
        send: options.quotasSend || (() => Promise.resolve({ Quotas: [], NextToken: undefined }))
    }
    resolver.sagemakerClient = {
        send: options.sagemakerSend || (() => Promise.resolve({ Endpoints: [], NextToken: undefined }))
    }
    resolver.ec2Client = {
        send: options.ec2Send || (() => Promise.resolve({ CapacityReservations: [], NextToken: undefined }))
    }

    return resolver
}

async function run() {
    // ── Constants Validation ─────────────────────────────────────────────────

    console.log('\nquota-resolver: constants\n')

    test('SAGEMAKER_SERVICE_CODE is sagemaker', () => {
        assert.strictEqual(SAGEMAKER_SERVICE_CODE, 'sagemaker')
    })

    test('DEFAULT_TIMEOUT_MS is 5000', () => {
        assert.strictEqual(DEFAULT_TIMEOUT_MS, 5000)
    })

    test('DEFAULT_CACHE_TTL_MS is 300000 (5 minutes)', () => {
        assert.strictEqual(DEFAULT_CACHE_TTL_MS, 300000)
    })

    // ── Quota Name Parsing ───────────────────────────────────────────────────

    console.log('\nquota-resolver: quota name parsing\n')

    test('QUOTA_NAME_PATTERN extracts ml.g5.xlarge from endpoint usage quota', () => {
        const match = 'ml.g5.xlarge for endpoint usage'.match(QUOTA_NAME_PATTERN)
        assert.ok(match, 'should match')
        assert.strictEqual(match[1], 'ml.g5.xlarge')
    })

    test('QUOTA_NAME_PATTERN extracts ml.p4d.24xlarge from endpoint usage quota', () => {
        const match = 'ml.p4d.24xlarge for endpoint usage'.match(QUOTA_NAME_PATTERN)
        assert.ok(match, 'should match')
        assert.strictEqual(match[1], 'ml.p4d.24xlarge')
    })

    test('QUOTA_NAME_PATTERN extracts ml.g4dn.2xlarge from endpoint usage quota', () => {
        const match = 'ml.g4dn.2xlarge for endpoint usage'.match(QUOTA_NAME_PATTERN)
        assert.ok(match, 'should match')
        assert.strictEqual(match[1], 'ml.g4dn.2xlarge')
    })

    test('QUOTA_NAME_PATTERN does not match training job quotas', () => {
        const match = 'ml.g5.xlarge for training job usage'.match(QUOTA_NAME_PATTERN)
        assert.strictEqual(match, null)
    })

    test('QUOTA_NAME_PATTERN does not match non-instance quota names', () => {
        const match = 'Number of instances across active endpoints'.match(QUOTA_NAME_PATTERN)
        assert.strictEqual(match, null)
    })

    test('QUOTA_NAME_PATTERN does not match empty string', () => {
        const match = ''.match(QUOTA_NAME_PATTERN)
        assert.strictEqual(match, null)
    })

    test('_parseQuotaName extracts instance type correctly', () => {
        const resolver = createMockedResolver()
        assert.strictEqual(resolver._parseQuotaName('ml.g5.xlarge for endpoint usage'), 'ml.g5.xlarge')
    })

    test('_parseQuotaName returns null for non-matching pattern', () => {
        const resolver = createMockedResolver()
        assert.strictEqual(resolver._parseQuotaName('some random quota name'), null)
    })

    test('_parseQuotaName returns null for empty string', () => {
        const resolver = createMockedResolver()
        assert.strictEqual(resolver._parseQuotaName(''), null)
    })

    // ── Headroom Calculation ─────────────────────────────────────────────────

    console.log('\nquota-resolver: headroom calculation\n')

    await test('headroom = quota - deployed (5 - 2 = 3)', async () => {
        const resolver = createMockedResolver({
            quotasSend: () => Promise.resolve({
                Quotas: [
                    { QuotaName: 'ml.g5.xlarge for endpoint usage', Value: 5 },
                    { QuotaName: 'ml.g5.2xlarge for endpoint usage', Value: 3 }
                ],
                NextToken: undefined
            }),
            sagemakerSend: () => Promise.resolve({
                Endpoints: [
                    {
                        ProductionVariants: [
                            { InstanceType: 'ml.g5.xlarge', CurrentInstanceCount: 2 }
                        ]
                    }
                ],
                NextToken: undefined
            })
        })

        const result = await resolver.getQuotaHeadroom(['ml.g5.xlarge', 'ml.g5.2xlarge'])
        assert.ok(result instanceof Map, 'should return a Map')
        assert.strictEqual(result.get('ml.g5.xlarge').quota, 5)
        assert.strictEqual(result.get('ml.g5.xlarge').deployed, 2)
        assert.strictEqual(result.get('ml.g5.xlarge').headroom, 3)
    })

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
        })

        const result = await resolver.getQuotaHeadroom(['ml.g5.xlarge'])
        assert.strictEqual(result.get('ml.g5.xlarge').quota, 5)
        assert.strictEqual(result.get('ml.g5.xlarge').deployed, 0)
        assert.strictEqual(result.get('ml.g5.xlarge').headroom, 5)
    })

    await test('headroom is zero when fully utilized', async () => {
        const resolver = createMockedResolver({
            quotasSend: () => Promise.resolve({
                Quotas: [
                    { QuotaName: 'ml.g5.xlarge for endpoint usage', Value: 2 }
                ],
                NextToken: undefined
            }),
            sagemakerSend: () => Promise.resolve({
                Endpoints: [
                    {
                        ProductionVariants: [
                            { InstanceType: 'ml.g5.xlarge', CurrentInstanceCount: 2 }
                        ]
                    }
                ],
                NextToken: undefined
            })
        })

        const result = await resolver.getQuotaHeadroom(['ml.g5.xlarge'])
        assert.strictEqual(result.get('ml.g5.xlarge').headroom, 0)
    })

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
        })

        const result = await resolver.getQuotaHeadroom(['ml.g5.xlarge'])
        assert.ok(result.has('ml.g5.xlarge'), 'should have requested type')
        assert.ok(!result.has('ml.p4d.24xlarge'), 'should not have unrequested type')
    })

    // ── API Failure Graceful Degradation ─────────────────────────────────────

    console.log('\nquota-resolver: graceful degradation on API failure\n')

    await test('getQuotaHeadroom returns null on AccessDeniedException', async () => {
        const resolver = createMockedResolver({
            quotasSend: () => {
                const err = new Error('Access Denied')
                err.name = 'AccessDeniedException'
                return Promise.reject(err)
            },
            sagemakerSend: () => {
                const err = new Error('Access Denied')
                err.name = 'AccessDeniedException'
                return Promise.reject(err)
            }
        })

        const result = await resolver.getQuotaHeadroom(['ml.g5.xlarge'])
        assert.strictEqual(result, null)
    })

    await test('getQuotaHeadroom returns null on ThrottlingException', async () => {
        const resolver = createMockedResolver({
            quotasSend: () => {
                const err = new Error('Rate exceeded')
                err.name = 'ThrottlingException'
                return Promise.reject(err)
            },
            sagemakerSend: () => Promise.resolve({ Endpoints: [], NextToken: undefined })
        })

        const result = await resolver.getQuotaHeadroom(['ml.g5.xlarge'])
        assert.strictEqual(result, null)
    })

    await test('getQuotaHeadroom returns null on generic error', async () => {
        const resolver = createMockedResolver({
            quotasSend: () => Promise.reject(new Error('Network timeout')),
            sagemakerSend: () => Promise.resolve({ Endpoints: [], NextToken: undefined })
        })

        const result = await resolver.getQuotaHeadroom(['ml.g5.xlarge'])
        assert.strictEqual(result, null)
    })

    await test('getTrainingPlans returns null on AccessDeniedException', async () => {
        const resolver = createMockedResolver({
            sagemakerSend: () => {
                const err = new Error('Access Denied')
                err.name = 'AccessDeniedException'
                return Promise.reject(err)
            }
        })

        const result = await resolver.getTrainingPlans()
        assert.strictEqual(result, null)
    })

    await test('getTrainingPlans returns null on ValidationException (region not supported)', async () => {
        const resolver = createMockedResolver({
            sagemakerSend: () => {
                const err = new Error('Operation not available')
                err.name = 'ValidationException'
                return Promise.reject(err)
            }
        })

        const result = await resolver.getTrainingPlans()
        assert.strictEqual(result, null)
    })

    // ── Cache Behavior ───────────────────────────────────────────────────────

    console.log('\nquota-resolver: cache behavior\n')

    await test('second call within TTL returns cached data without API call', async () => {
        let apiCallCount = 0
        const resolver = createMockedResolver({
            cacheTtl: 60000,
            quotasSend: () => {
                apiCallCount++
                return Promise.resolve({
                    Quotas: [
                        { QuotaName: 'ml.g5.xlarge for endpoint usage', Value: 5 }
                    ],
                    NextToken: undefined
                })
            },
            sagemakerSend: () => {
                apiCallCount++
                return Promise.resolve({
                    Endpoints: [],
                    NextToken: undefined
                })
            }
        })

        // First call — should hit API
        const result1 = await resolver.getQuotaHeadroom(['ml.g5.xlarge'])
        const callsAfterFirst = apiCallCount

        // Second call — should use cache
        const result2 = await resolver.getQuotaHeadroom(['ml.g5.xlarge'])

        assert.strictEqual(apiCallCount, callsAfterFirst, 'should not make additional API calls on cache hit')
        assert.deepStrictEqual(result1, result2, 'cached result should match first result')
    })

    await test('cache expires after TTL', async () => {
        let apiCallCount = 0
        const resolver = createMockedResolver({
            cacheTtl: 1, // 1ms TTL for testing
            quotasSend: () => {
                apiCallCount++
                return Promise.resolve({
                    Quotas: [
                        { QuotaName: 'ml.g5.xlarge for endpoint usage', Value: 5 }
                    ],
                    NextToken: undefined
                })
            },
            sagemakerSend: () => {
                apiCallCount++
                return Promise.resolve({
                    Endpoints: [],
                    NextToken: undefined
                })
            }
        })

        // First call
        await resolver.getQuotaHeadroom(['ml.g5.xlarge'])
        const callsAfterFirst = apiCallCount

        // Wait for TTL to expire
        await new Promise(resolve => setTimeout(resolve, 10))

        // Second call — cache should be expired
        await resolver.getQuotaHeadroom(['ml.g5.xlarge'])
        assert.ok(apiCallCount > callsAfterFirst, 'should make new API calls after cache expires')
    })

    await test('getTrainingPlans uses cache on second call', async () => {
        let apiCallCount = 0
        const resolver = createMockedResolver({
            cacheTtl: 60000,
            sagemakerSend: () => {
                apiCallCount++
                return Promise.resolve({
                    TrainingPlanSummaries: [],
                    NextToken: undefined
                })
            }
        })

        await resolver.getTrainingPlans()
        const callsAfterFirst = apiCallCount

        await resolver.getTrainingPlans()
        assert.strictEqual(apiCallCount, callsAfterFirst, 'should use cache on second call')
    })

    // ── Timeout Handling ─────────────────────────────────────────────────────

    console.log('\nquota-resolver: timeout handling\n')

    await test('timeout error is handled gracefully (returns null)', async () => {
        const resolver = createMockedResolver({
            timeout: 5000,
            quotasSend: () => {
                const err = new Error('Connection timed out after 5000ms')
                err.name = 'TimeoutError'
                return Promise.reject(err)
            },
            sagemakerSend: () => {
                const err = new Error('Connection timed out after 5000ms')
                err.name = 'TimeoutError'
                return Promise.reject(err)
            }
        })

        const result = await resolver.getQuotaHeadroom(['ml.g5.xlarge'])
        assert.strictEqual(result, null, 'should return null on timeout')
    })

    await test('constructor sets timeout to 5000ms by default', () => {
        const resolver = new QuotaResolver('us-east-1')
        assert.strictEqual(resolver.timeout, 5000)
    })

    await test('constructor accepts custom timeout', () => {
        const resolver = new QuotaResolver('us-east-1', { timeout: 10000 })
        assert.strictEqual(resolver.timeout, 10000)
    })

    // ── getCapacityReservations (EC2-based) ─────────────────────────────────────

    console.log('\nquota-resolver: getCapacityReservations (EC2 DescribeCapacityReservations)\n')

    await test('returns Map of ml.* instance types with ODCR reservation info', async () => {
        const resolver = createMockedResolver({
            ec2Send: () => Promise.resolve({
                CapacityReservations: [
                    {
                        CapacityReservationId: 'cr-odcr-001',
                        CapacityReservationArn: 'arn:aws:ec2:us-east-1:123456789012:capacity-reservation/cr-odcr-001',
                        InstanceType: 'g5.xlarge',
                        State: 'active',
                        CapacityReservationType: 'default',
                        AvailableInstanceCount: 3,
                        StartDate: '2025-01-01T00:00:00Z',
                        EndDate: null
                    }
                ],
                NextToken: undefined
            })
        })

        const result = await resolver.getCapacityReservations()
        assert.ok(result instanceof Map, 'should return a Map')
        assert.ok(result.has('ml.g5.xlarge'), 'should map bare EC2 type to ml. prefixed key')
        const info = result.get('ml.g5.xlarge')
        assert.strictEqual(info.reservationId, 'cr-odcr-001')
        assert.strictEqual(info.reservationArn, 'arn:aws:ec2:us-east-1:123456789012:capacity-reservation/cr-odcr-001')
        assert.strictEqual(info.type, 'odcr')
        assert.strictEqual(info.count, 3)
    })

    await test('returns Capacity Block reservations within time window', async () => {
        const now = new Date()
        const pastDate = new Date(now.getTime() - 86400000).toISOString() // yesterday
        const futureDate = new Date(now.getTime() + 86400000).toISOString() // tomorrow

        const resolver = createMockedResolver({
            ec2Send: () => Promise.resolve({
                CapacityReservations: [
                    {
                        CapacityReservationId: 'cr-cb-001',
                        CapacityReservationArn: 'arn:aws:ec2:us-east-1:123456789012:capacity-reservation/cr-cb-001',
                        InstanceType: 'p4d.24xlarge',
                        State: 'active',
                        CapacityReservationType: 'capacity-block',
                        AvailableInstanceCount: 2,
                        StartDate: pastDate,
                        EndDate: futureDate
                    }
                ],
                NextToken: undefined
            })
        })

        const result = await resolver.getCapacityReservations()
        assert.ok(result instanceof Map, 'should return a Map')
        assert.ok(result.has('ml.p4d.24xlarge'), 'should map bare p4d.24xlarge to ml.p4d.24xlarge')
        const info = result.get('ml.p4d.24xlarge')
        assert.strictEqual(info.reservationId, 'cr-cb-001')
        assert.strictEqual(info.reservationArn, 'arn:aws:ec2:us-east-1:123456789012:capacity-reservation/cr-cb-001')
        assert.strictEqual(info.type, 'capacity-block')
        assert.strictEqual(info.count, 2)
        assert.ok(info.startDate, 'should have startDate')
        assert.ok(info.endDate, 'should have endDate')
    })

    await test('excludes expired Capacity Blocks (endDate in the past)', async () => {
        const pastStart = new Date(Date.now() - 172800000).toISOString() // 2 days ago
        const pastEnd = new Date(Date.now() - 86400000).toISOString() // yesterday

        const resolver = createMockedResolver({
            ec2Send: () => Promise.resolve({
                CapacityReservations: [
                    {
                        CapacityReservationId: 'cr-cb-expired',
                        InstanceType: 'p4d.24xlarge',
                        State: 'active',
                        CapacityReservationType: 'capacity-block',
                        AvailableInstanceCount: 4,
                        StartDate: pastStart,
                        EndDate: pastEnd
                    }
                ],
                NextToken: undefined
            })
        })

        const result = await resolver.getCapacityReservations()
        assert.ok(result instanceof Map, 'should return a Map')
        assert.strictEqual(result.size, 0, 'should exclude expired Capacity Block')
    })

    await test('excludes Capacity Blocks not yet started (startDate in the future)', async () => {
        const futureStart = new Date(Date.now() + 86400000).toISOString() // tomorrow
        const futureEnd = new Date(Date.now() + 172800000).toISOString() // 2 days from now

        const resolver = createMockedResolver({
            ec2Send: () => Promise.resolve({
                CapacityReservations: [
                    {
                        CapacityReservationId: 'cr-cb-future',
                        InstanceType: 'g5.2xlarge',
                        State: 'active',
                        CapacityReservationType: 'capacity-block',
                        AvailableInstanceCount: 2,
                        StartDate: futureStart,
                        EndDate: futureEnd
                    }
                ],
                NextToken: undefined
            })
        })

        const result = await resolver.getCapacityReservations()
        assert.ok(result instanceof Map, 'should return a Map')
        assert.strictEqual(result.size, 0, 'should exclude not-yet-started Capacity Block')
    })

    await test('maps bare EC2 instance types to ml. prefixed keys', async () => {
        const resolver = createMockedResolver({
            ec2Send: () => Promise.resolve({
                CapacityReservations: [
                    {
                        CapacityReservationId: 'cr-ec2-001',
                        InstanceType: 'p4d.24xlarge',
                        State: 'active',
                        CapacityReservationType: 'default',
                        AvailableInstanceCount: 2,
                        StartDate: '2025-01-01T00:00:00Z',
                        EndDate: null
                    },
                    {
                        CapacityReservationId: 'cr-ml-001',
                        InstanceType: 'g5.xlarge',
                        State: 'active',
                        CapacityReservationType: 'default',
                        AvailableInstanceCount: 1,
                        StartDate: '2025-01-01T00:00:00Z',
                        EndDate: null
                    }
                ],
                NextToken: undefined
            })
        })

        const result = await resolver.getCapacityReservations()
        assert.strictEqual(result.size, 2, 'should include both reservations')
        assert.ok(result.has('ml.p4d.24xlarge'), 'should map p4d.24xlarge to ml.p4d.24xlarge')
        assert.ok(result.has('ml.g5.xlarge'), 'should map g5.xlarge to ml.g5.xlarge')
    })

    await test('handles mixed ODCR and Capacity Block results', async () => {
        const now = new Date()
        const pastDate = new Date(now.getTime() - 86400000).toISOString()
        const futureDate = new Date(now.getTime() + 86400000).toISOString()

        const resolver = createMockedResolver({
            ec2Send: () => Promise.resolve({
                CapacityReservations: [
                    {
                        CapacityReservationId: 'cr-odcr-mix',
                        InstanceType: 'g5.xlarge',
                        State: 'active',
                        CapacityReservationType: 'default',
                        AvailableInstanceCount: 2,
                        StartDate: '2025-01-01T00:00:00Z',
                        EndDate: null
                    },
                    {
                        CapacityReservationId: 'cr-cb-mix',
                        InstanceType: 'p4d.24xlarge',
                        State: 'active',
                        CapacityReservationType: 'capacity-block',
                        AvailableInstanceCount: 4,
                        StartDate: pastDate,
                        EndDate: futureDate
                    }
                ],
                NextToken: undefined
            })
        })

        const result = await resolver.getCapacityReservations()
        assert.strictEqual(result.size, 2, 'should have both reservations')

        const odcr = result.get('ml.g5.xlarge')
        assert.strictEqual(odcr.type, 'odcr')
        assert.strictEqual(odcr.reservationId, 'cr-odcr-mix')

        const cb = result.get('ml.p4d.24xlarge')
        assert.strictEqual(cb.type, 'capacity-block')
        assert.strictEqual(cb.reservationId, 'cr-cb-mix')
    })

    await test('returns empty Map when no reservations exist', async () => {
        const resolver = createMockedResolver({
            ec2Send: () => Promise.resolve({
                CapacityReservations: [],
                NextToken: undefined
            })
        })

        const result = await resolver.getCapacityReservations()
        assert.ok(result instanceof Map, 'should return a Map')
        assert.strictEqual(result.size, 0, 'should be empty when no reservations')
    })

    await test('excludes reservations with zero available capacity', async () => {
        const resolver = createMockedResolver({
            ec2Send: () => Promise.resolve({
                CapacityReservations: [
                    {
                        CapacityReservationId: 'cr-full',
                        InstanceType: 'g5.xlarge',
                        State: 'active',
                        CapacityReservationType: 'default',
                        AvailableInstanceCount: 0,
                        StartDate: '2025-01-01T00:00:00Z',
                        EndDate: null
                    }
                ],
                NextToken: undefined
            })
        })

        const result = await resolver.getCapacityReservations()
        assert.strictEqual(result.size, 0, 'should exclude reservations with zero capacity')
    })

    await test('getCapacityReservations returns null on AccessDeniedException', async () => {
        const resolver = createMockedResolver({
            ec2Send: () => {
                const err = new Error('Access Denied')
                err.name = 'AccessDeniedException'
                return Promise.reject(err)
            }
        })

        const result = await resolver.getCapacityReservations()
        assert.strictEqual(result, null)
    })

    await test('getCapacityReservations returns null on ThrottlingException', async () => {
        const resolver = createMockedResolver({
            ec2Send: () => {
                const err = new Error('Rate exceeded')
                err.name = 'ThrottlingException'
                return Promise.reject(err)
            }
        })

        const result = await resolver.getCapacityReservations()
        assert.strictEqual(result, null)
    })

    await test('getCapacityReservations uses cache on second call', async () => {
        let apiCallCount = 0
        const resolver = createMockedResolver({
            cacheTtl: 60000,
            ec2Send: () => {
                apiCallCount++
                return Promise.resolve({
                    CapacityReservations: [
                        {
                            CapacityReservationId: 'cr-cached',
                            InstanceType: 'g5.xlarge',
                            State: 'active',
                            CapacityReservationType: 'default',
                            AvailableInstanceCount: 1,
                            StartDate: '2025-01-01T00:00:00Z',
                            EndDate: null
                        }
                    ],
                    NextToken: undefined
                })
            }
        })

        await resolver.getCapacityReservations()
        const callsAfterFirst = apiCallCount

        await resolver.getCapacityReservations()
        assert.strictEqual(apiCallCount, callsAfterFirst, 'should use cache on second call')
    })

    // ── getTrainingPlans ─────────────────────────────────────────────────────

    console.log('\nquota-resolver: getTrainingPlans\n')

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
        })

        const result = await resolver.getTrainingPlans()
        assert.ok(result instanceof Map, 'should return a Map')
        assert.ok(result.has('ml.p4d.24xlarge'), 'should have the instance type')
        const info = result.get('ml.p4d.24xlarge')
        assert.strictEqual(info.planName, 'my-plan')
        assert.strictEqual(info.remainingCapacity, 4)
        assert.strictEqual(info.expiresAt, '2025-06-30T00:00:00Z')
    })

    await test('returns empty Map when no active plans exist', async () => {
        const resolver = createMockedResolver({
            sagemakerSend: () => Promise.resolve({
                TrainingPlanSummaries: [],
                NextToken: undefined
            })
        })

        const result = await resolver.getTrainingPlans()
        assert.ok(result instanceof Map, 'should return a Map')
        assert.strictEqual(result.size, 0, 'should be empty when no plans')
    })

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
        })

        const result = await resolver.getTrainingPlans()
        assert.strictEqual(result.size, 0, 'should skip plans with zero capacity')
    })

    // ── Summary ──────────────────────────────────────────────────────────────

    console.log(`\n  ${passed} passing, ${failed} failing\n`)
    process.exit(failed > 0 ? 1 : 0)
}

run()
