// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Quota Resolver
 *
 * Queries AWS APIs to determine account-level quota headroom, capacity
 * reservations, and Flexible Training Plans for SageMaker instance types.
 * Used in discover mode to filter and prioritize instance recommendations.
 *
 * All methods degrade gracefully — API failures return null and log to stderr.
 */

import { ServiceQuotasClient, ListServiceQuotasCommand } from '@aws-sdk/client-service-quotas';
import { SageMakerClient, ListEndpointsCommand, DescribeEndpointCommand, DescribeEndpointConfigCommand, ListTrainingPlansCommand } from '@aws-sdk/client-sagemaker';

// ── Constants ────────────────────────────────────────────────────────────────

const SAGEMAKER_SERVICE_CODE = 'sagemaker';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_CACHE_TTL_MS = 300000; // 5 minutes

// Quota name patterns per deployment target
const QUOTA_PATTERNS = {
    'managed-inference': /^(ml\.[a-z0-9]+\.[a-z0-9]+) for endpoint usage$/,
    'async-inference': /^(ml\.[a-z0-9]+\.[a-z0-9]+) for endpoint usage$/,
    'batch-transform': /^(ml\.[a-z0-9]+\.[a-z0-9]+) for transform job usage$/,
    'hyperpod-eks': /^(ml\.[a-z0-9]+\.[a-z0-9]+) for cluster usage$/
};
// Default fallback (endpoint usage)
const QUOTA_NAME_PATTERN = /^(ml\.[a-z0-9]+\.[a-z0-9]+) for endpoint usage$/;

// ── Logging ──────────────────────────────────────────────────────────────────

function log(message) {
    process.stderr.write(`[quota-resolver] ${message}\n`);
}

// ── QuotaResolver Class ──────────────────────────────────────────────────────

class QuotaResolver {
    /**
     * @param {string} region - AWS region to query
     * @param {object} [options={}]
     * @param {number} [options.timeout=5000] - Timeout per API call in ms
     * @param {number} [options.cacheTtl=300000] - Cache TTL in ms (default 5 min)
     */
    constructor(region, options = {}) {
        this.region = region;
        this.timeout = options.timeout || DEFAULT_TIMEOUT_MS;
        this.cacheTtl = options.cacheTtl || DEFAULT_CACHE_TTL_MS;
        this.cache = new Map();

        const clientConfig = {
            region: this.region,
            requestHandler: {
                requestTimeout: this.timeout
            }
        };

        this.quotasClient = new ServiceQuotasClient(clientConfig);
        this.sagemakerClient = new SageMakerClient(clientConfig);
    }

    /**
     * Check cache for a key. Returns cached value if within TTL, else null.
     * @param {string} key - Cache key
     * @returns {*|null} Cached value or null
     */
    _getCached(key) {
        const entry = this.cache.get(key);
        if (!entry) return null;
        if (Date.now() - entry.timestamp > this.cacheTtl) {
            this.cache.delete(key);
            return null;
        }
        return entry.value;
    }

    /**
     * Store a value in the cache with current timestamp.
     * @param {string} key - Cache key
     * @param {*} value - Value to cache
     */
    _setCache(key, value) {
        this.cache.set(key, { value, timestamp: Date.now() });
    }

    /**
     * Parse a SageMaker quota name to extract the instance type.
     * Expected pattern: "ml.<family>.<size> for endpoint usage"
     *
     * @param {string} quotaName - Quota name from Service Quotas API
     * @returns {string|null} Instance type or null if pattern doesn't match
     */
    _parseQuotaName(quotaName) {
        const match = quotaName.match(QUOTA_NAME_PATTERN);
        return match ? match[1] : null;
    }

    /**
     * Get quota headroom for a list of instance types.
     *
     * Queries Service Quotas for SageMaker instance limits appropriate to the
     * deployment target, and counts currently deployed instances per type.
     * Headroom = quota limit - deployed count.
     *
     * @param {string[]} instanceTypes - Instance types to check (e.g., ['ml.g5.xlarge'])
     * @param {object} [options={}]
     * @param {string} [options.deploymentTarget] - Target to select the right quota pattern
     * @returns {Promise<Map|null>} Map: instanceType → { quota, deployed, headroom }, or null on failure
     */
    /**
     * Get quota headroom for a list of instance types.
     *
     * Queries Service Quotas for SageMaker instance limits appropriate to the
     * deployment target, and counts currently deployed instances per type.
     * Headroom = quota limit - deployed count.
     *
     * @param {string[]} instanceTypes - Instance types to check (e.g., ['ml.g5.xlarge'])
     * @param {object} [options={}]
     * @param {string} [options.deploymentTarget] - Target to select the right quota pattern
     * @returns {Promise<Map|null>} Map: instanceType → { quota, deployed, headroom }, or null on failure
     */
    async getQuotaHeadroom(instanceTypes, options = {}) {
        const deploymentTarget = options.deploymentTarget || 'managed-inference';
        const cacheKey = `quotaHeadroom:${deploymentTarget}`;
        const cached = this._getCached(cacheKey);
        if (cached) return cached;

        try {
            const quotaPattern = QUOTA_PATTERNS[deploymentTarget] || QUOTA_NAME_PATTERN;

            // Only count deployed resources matching the target type
            let deployedFetcher;
            switch (deploymentTarget) {
            case 'batch-transform':
                deployedFetcher = this._fetchRunningTransformJobs();
                break;
            case 'hyperpod-eks':
                // Cluster nodes are managed by HyperPod — no easy count
                deployedFetcher = Promise.resolve(new Map());
                break;
            default:
                deployedFetcher = this._fetchDeployedCounts();
                break;
            }

            const [quotaMap, deployedMap] = await Promise.allSettled([
                this._fetchServiceQuotas(quotaPattern),
                deployedFetcher
            ]);

            const quotas = quotaMap.status === 'fulfilled' ? quotaMap.value : null;
            const deployed = deployedMap.status === 'fulfilled' ? deployedMap.value : null;

            if (!quotas) {
                return null;
            }

            const result = new Map();
            const deployedCounts = deployed || new Map();

            for (const instanceType of instanceTypes) {
                const quota = quotas.get(instanceType);
                if (quota !== null && quota !== undefined) {
                    const deployedCount = deployedCounts.get(instanceType) || 0;
                    const headroom = quota - deployedCount;
                    result.set(instanceType, {
                        quota,
                        deployed: deployedCount,
                        headroom
                    });
                }
            }

            this._setCache(cacheKey, result);
            return result;
        } catch (err) {
            if (err.name === 'AccessDeniedException' || err.Code === 'AccessDeniedException') {
                log('AccessDenied: insufficient permissions for quota queries — skipping');
            } else if (err.name === 'ThrottlingException' || err.Code === 'ThrottlingException') {
                log('Throttled: Service Quotas API rate limit hit — skipping');
            } else {
                log(`Failed to get quota headroom: ${err.message}`);
            }
            return null;
        }
    }

    /**
     * Fetch all SageMaker service quotas for endpoint instance types.
     * Paginates through all results.
     *
     * @param {RegExp} pattern - Regex to extract instance type from quota name
     * @returns {Promise<Map>} Map: instanceType → quota limit (number)
     */
    async _fetchServiceQuotas(pattern) {
        const quotaMap = new Map();
        let nextToken = undefined;

        do {
            const command = new ListServiceQuotasCommand({
                ServiceCode: SAGEMAKER_SERVICE_CODE,
                ...(nextToken && { NextToken: nextToken })
            });

            const response = await this.quotasClient.send(command);

            for (const quota of (response.Quotas || [])) {
                const match = (quota.QuotaName || '').match(pattern);
                const instanceType = match ? match[1] : null;
                if (instanceType && quota.Value !== null && quota.Value !== undefined) {
                    quotaMap.set(instanceType, quota.Value);
                }
            }

            nextToken = response.NextToken;
        } while (nextToken);

        return quotaMap;
    }

    /**
     * Fetch currently deployed endpoint instances and count per type.
     * For IC-based endpoints, InstanceType is in EndpointConfig (not
     * in the live ProductionVariants). We DescribeEndpoint to get the
     * config name, then DescribeEndpointConfig for instance type.
     *
     * @returns {Promise<Map>} Map: instanceType → deployed instance count
     */
    async _fetchDeployedCounts() {
        const deployedMap = new Map();
        let nextToken = undefined;

        // First, list all InService endpoints
        const endpointNames = [];
        do {
            const command = new ListEndpointsCommand({
                StatusEquals: 'InService',
                ...(nextToken && { NextToken: nextToken })
            });

            const response = await this.sagemakerClient.send(command);
            for (const ep of (response.Endpoints || [])) {
                endpointNames.push(ep.EndpointName);
            }
            nextToken = response.NextToken;
        } while (nextToken);

        // Then describe each to get instance type + count
        const describePromises = endpointNames.slice(0, 50).map(async (name) => {
            try {
                const epResp = await this.sagemakerClient.send(
                    new DescribeEndpointCommand({ EndpointName: name })
                );

                // Try live variants first (non-IC endpoints)
                let found = false;
                for (const variant of (epResp.ProductionVariants || [])) {
                    if (variant.CurrentInstanceCount && variant.InstanceType) {
                        const current = deployedMap.get(variant.InstanceType) || 0;
                        deployedMap.set(variant.InstanceType, current + variant.CurrentInstanceCount);
                        found = true;
                    }
                }

                // IC-based endpoints: InstanceType is null in live
                // variants. Get it from the EndpointConfig instead.
                if (!found && epResp.EndpointConfigName) {
                    const cfgResp = await this.sagemakerClient.send(
                        new DescribeEndpointConfigCommand({
                            EndpointConfigName: epResp.EndpointConfigName
                        })
                    );
                    for (const variant of (cfgResp.ProductionVariants || [])) {
                        if (variant.InstanceType) {
                            const count = epResp.ProductionVariants?.[0]?.CurrentInstanceCount || variant.InitialInstanceCount || 1;
                            const current = deployedMap.get(variant.InstanceType) || 0;
                            deployedMap.set(variant.InstanceType, current + count);
                        }
                    }
                }
            } catch {
                // Skip endpoints that fail to describe
            }
        });

        await Promise.allSettled(describePromises);
        if (deployedMap.size > 0) {
            log(`Deployed instance counts: ${[...deployedMap].map(([k, v]) => `${k}=${v}`).join(', ')}`);
        }
        return deployedMap;
    }

    /**
     * Count currently running transform jobs by instance type.
     * Only counts InProgress jobs (not Completed/Failed/Stopped).
     *
     * @returns {Promise<Map>} Map: instanceType → running job instance count
     */
    async _fetchRunningTransformJobs() {
        const deployedMap = new Map();
        let nextToken = undefined;

        try {
            const { ListTransformJobsCommand, DescribeTransformJobCommand } = await import('@aws-sdk/client-sagemaker');

            // List InProgress transform jobs
            const jobNames = [];
            do {
                const response = await this.sagemakerClient.send(
                    new ListTransformJobsCommand({
                        StatusEquals: 'InProgress',
                        ...(nextToken && { NextToken: nextToken })
                    })
                );
                for (const job of (response.TransformJobSummaries || [])) {
                    jobNames.push(job.TransformJobName);
                }
                nextToken = response.NextToken;
            } while (nextToken);

            // Describe each to get instance type + count
            for (const name of jobNames.slice(0, 20)) {
                try {
                    const resp = await this.sagemakerClient.send(
                        new DescribeTransformJobCommand({ TransformJobName: name })
                    );
                    const instanceType = resp.TransformResources?.InstanceType;
                    const count = resp.TransformResources?.InstanceCount || 1;
                    if (instanceType) {
                        const current = deployedMap.get(instanceType) || 0;
                        deployedMap.set(instanceType, current + count);
                    }
                } catch { /* skip */ }
            }

            if (deployedMap.size > 0) {
                log(`Running transform jobs: ${[...deployedMap].map(([k, v]) => `${k}=${v}`).join(', ')}`);
            }
        } catch (err) {
            log(`Failed to fetch running transform jobs: ${err.message}`);
        }

        return deployedMap;
    }

    /**
     * Get active Training Plan reservations for inference endpoints.
     *
     * Queries ListTrainingPlans for active plans with TargetResources=endpoint.
     * These are SageMaker-managed capacity reservations that can be referenced
     * via MlReservationArn in CreateEndpointConfig.
     *
     * ⚠️  EXPERIMENTAL: Training Plans for inference is a newer feature.
     *
     * @returns {Promise<Map|null>} Map: instanceType → { planName, planArn, remainingCapacity, startDate, endDate }, or null on failure
     */
    async getCapacityReservations() {
        const cacheKey = 'capacityReservations';
        const cached = this._getCached(cacheKey);
        if (cached) return cached;

        try {
            const result = new Map();
            let nextToken = undefined;

            do {
                const command = new ListTrainingPlansCommand({
                    StatusEquals: 'Active',
                    ...(nextToken && { NextToken: nextToken })
                });

                const response = await this.sagemakerClient.send(command);
                const now = new Date();

                for (const plan of (response.TrainingPlanSummaries || [])) {
                    // Only include plans targeting inference endpoints
                    const targetResources = plan.TargetResources || [];
                    if (!targetResources.includes('endpoint')) continue;

                    const instanceType = plan.InstanceType || plan.ReservedCapacityInstanceType;
                    if (!instanceType) continue;

                    const planArn = plan.TrainingPlanArn;
                    const planName = plan.TrainingPlanName || 'unknown';
                    const remainingCapacity = plan.AvailableInstanceCount
                        ?? plan.RemainingCapacity
                        ?? plan.TotalInstanceCount
                        ?? 0;
                    const startDate = plan.StartTime || null;
                    const endDate = plan.EndTime || plan.ExpirationTime || null;

                    // Skip plans outside their time window
                    if (startDate && new Date(startDate) > now) continue;
                    if (endDate && new Date(endDate) < now) continue;

                    // Only include if there's remaining capacity
                    if (remainingCapacity <= 0) continue;

                    result.set(instanceType, {
                        planName,
                        planArn,
                        type: 'training-plan',
                        count: remainingCapacity,
                        startDate: startDate ? (startDate instanceof Date ? startDate.toISOString() : startDate) : null,
                        endDate: endDate ? (endDate instanceof Date ? endDate.toISOString() : endDate) : null
                    });
                }

                nextToken = response.NextToken;
            } while (nextToken);

            this._setCache(cacheKey, result);
            return result;
        } catch (err) {
            if (err.name === 'AccessDeniedException' || err.Code === 'AccessDeniedException') {
                log('AccessDenied: insufficient permissions for training plan queries — skipping');
            } else if (err.name === 'ValidationException') {
                log(`ListTrainingPlans not available in region ${this.region} — skipping`);
            } else if (err.name === 'ThrottlingException' || err.Code === 'ThrottlingException') {
                log('Throttled: ListTrainingPlans rate limit hit — skipping');
            } else {
                log(`Failed to get capacity reservations: ${err.message}`);
            }
            return null;
        }
    }

    /**
     * Get active Flexible Training Plans with remaining capacity.
     *
     * Calls ListTrainingPlans with status filter for active plans and
     * extracts instance types and remaining capacity from each plan.
     *
     * @returns {Promise<Map|null>} Map: instanceType → { planName, remainingCapacity, expiresAt }, or null on failure
     */
    async getTrainingPlans() {
        const cacheKey = 'trainingPlans';
        const cached = this._getCached(cacheKey);
        if (cached) return cached;

        try {
            const result = new Map();
            let nextToken = undefined;

            do {
                const command = new ListTrainingPlansCommand({
                    StatusEquals: 'Active',
                    ...(nextToken && { NextToken: nextToken })
                });

                const response = await this.sagemakerClient.send(command);

                for (const plan of (response.TrainingPlanSummaries || [])) {
                    const instanceType = plan.InstanceType || plan.ReservedCapacityInstanceType;
                    const planName = plan.TrainingPlanName || plan.TrainingPlanArn || 'unknown';
                    const remainingCapacity = plan.AvailableInstanceCount
                        ?? plan.RemainingCapacity
                        ?? plan.TotalInstanceCount
                        ?? 0;
                    const expiresAt = plan.EndTime || plan.ExpirationTime || null;

                    if (instanceType && remainingCapacity > 0) {
                        result.set(instanceType, {
                            planName,
                            remainingCapacity,
                            expiresAt
                        });
                    }
                }

                nextToken = response.NextToken;
            } while (nextToken);

            this._setCache(cacheKey, result);
            return result;
        } catch (err) {
            if (err.name === 'AccessDeniedException' || err.Code === 'AccessDeniedException') {
                log('AccessDenied: insufficient permissions for training plan queries — skipping');
            } else if (err.name === 'ValidationException') {
                log(`ListTrainingPlans not available in region ${this.region} — skipping`);
            } else {
                log(`Failed to get training plans: ${err.message}`);
            }
            return null;
        }
    }
}

export { QuotaResolver, QUOTA_NAME_PATTERN, QUOTA_PATTERNS, SAGEMAKER_SERVICE_CODE, DEFAULT_TIMEOUT_MS, DEFAULT_CACHE_TTL_MS };
