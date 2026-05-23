// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E CI Recorder
 *
 * Records E2E validation results to the DynamoDB CI table.
 * Gracefully degrades if the CI table is not provisioned —
 * all recording calls become no-ops.
 */

import { computeConfigId } from './ci-register-helpers.js'
import BootstrapConfig from './bootstrap-config.js'

export class E2ECIRecorder {
    constructor() {
        this.config = new BootstrapConfig()
        this.client = null
        this.tableName = null
    }

    /**
     * Initialize the recorder by checking if the CI table is provisioned.
     * If not provisioned, logs a warning and returns false — all subsequent
     * recordConfigResult calls become no-ops.
     *
     * @returns {Promise<boolean>} true if ready to record, false otherwise
     */
    async init() {
        const profile = this.config.getActiveProfileWithDefaults()
        if (!profile || !profile.config.ciInfraProvisioned) {
            console.warn('⚠️  CI table not provisioned — skipping result recording')
            return false
        }
        this.tableName = profile.config.ciTableName
        const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb')
        this.client = new DynamoDBClient({ region: profile.config.awsRegion })
        return true
    }

    /**
     * Record a config's E2E result to the DynamoDB CI table.
     * No-op if init() returned false or was not called.
     *
     * @param {object} catalogEntry - The catalog entry that was tested
     * @param {object} configResult - The result of running the config
     */
    async recordConfigResult(catalogEntry, configResult) {
        if (!this.client) return

        const configId = this.deriveConfigId(catalogEntry)
        const item = {
            configId,
            schemaVersion: 2,
            testStatus: configResult.status === 'pass'
                ? 'pass'
                : `fail-${configResult.steps.find(s => s.status === 'fail')?.name || 'unknown'}`,
            lastTestTimestamp: new Date().toISOString(),
            stageResults: Object.fromEntries(
                configResult.steps.map(s => [s.name, { status: s.status, duration: s.duration, error: s.error || '' }])
            ),
            e2eCatalogId: catalogEntry.id,
            tier: catalogEntry.tier,
            duration: configResult.duration
        }

        try {
            const { PutItemCommand } = await import('@aws-sdk/client-dynamodb')
            const { marshall } = await import('@aws-sdk/util-dynamodb')
            await this.client.send(new PutItemCommand({
                TableName: this.tableName,
                Item: marshall(item, { removeUndefinedValues: true })
            }))
        } catch (err) {
            console.warn(`⚠️  Failed to record ${catalogEntry.id} to CI table: ${err.message}`)
        }
    }

    /**
     * Derive a deterministic configId from a catalog entry's args field,
     * using the same SHA256 algorithm as `do/register --ci`.
     *
     * @param {object} catalogEntry - A catalog entry with an `args` string
     * @returns {string} 16-character hex configId
     */
    deriveConfigId(catalogEntry) {
        const args = Object.fromEntries(
            catalogEntry.args.split(/\s+/)
                .filter(a => a.startsWith('--'))
                .map(a => a.replace(/^--/, '').split('='))
        )
        const deploymentTarget = catalogEntry.track === 'realtime'
            ? 'realtime-inference'
            : catalogEntry.track
        return computeConfigId(
            args['deployment-config'] || '',
            args['model-name'] || 'none',
            args['instance-type'] || '',
            args['region'] || 'us-west-2',
            deploymentTarget
        )
    }
}
