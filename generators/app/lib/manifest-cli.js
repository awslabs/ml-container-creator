#!/usr/bin/env node

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Manifest CLI Wrapper
 *
 * A standalone Node.js script invoked by the `do/manifest` shell helper.
 * Reads the bootstrap config to resolve the active profile, instantiates
 * AssetManager, and dispatches commands.
 *
 * Usage:
 *   node do/lib/manifest-cli.js add --type <type> --id <id> --project <project> [--meta <json>]
 *   node do/lib/manifest-cli.js delete --id <id>
 *   node do/lib/manifest-cli.js list [--project <project>] [--status <status>] [--type <type>]
 *
 * Validates: Requirements 9.1–9.7
 */

import AssetManager, { VALID_RESOURCE_TYPES, VALID_STATUSES } from './asset-manager.js'
import BootstrapConfig from './bootstrap-config.js'

/**
 * Parse command-line arguments into a map of flag → value pairs.
 * Supports --flag value syntax. Positional args are ignored.
 *
 * @param {string[]} argv - The raw process.argv array
 * @returns {{ subcommand: string|null, flags: Object }}
 */
function parseArgs(argv) {
    // argv[0] = node, argv[1] = script path, argv[2] = subcommand, argv[3..] = flags
    const args = argv.slice(2)
    const subcommand = args.length > 0 && !args[0].startsWith('--') ? args[0] : null
    const flags = {}

    for (let i = subcommand ? 1 : 0; i < args.length; i++) {
        if (args[i].startsWith('--') && i + 1 < args.length) {
            const key = args[i].slice(2)
            flags[key] = args[i + 1]
            i++
        }
    }

    return { subcommand, flags }
}

/**
 * Print usage information and exit.
 */
function printUsage() {
    console.log('Usage:')
    console.log('  manifest add --type <resourceType> --id <resourceId> --project <projectName> [--meta <json>]')
    console.log('  manifest delete --id <resourceId>')
    console.log('  manifest list [--project <project>] [--status <status>] [--type <type>]')
    console.log('  manifest prune')
    console.log('')
    console.log('Valid resource types:')
    console.log(`  ${VALID_RESOURCE_TYPES.join(', ')}`)
    console.log('')
    console.log('Valid statuses:')
    console.log(`  ${VALID_STATUSES.join(', ')}`)
}

/**
 * Format resources as a table for console output.
 *
 * @param {Array<Object>} resources - Array of Asset_Records
 */
function printResourceTable(resources) {
    if (resources.length === 0) {
        console.log('No resources found.')
        return
    }

    // Header
    const header = ['Type', 'Resource ID', 'Project', 'Status', 'Created At']
    const widths = header.map(h => h.length)

    // Calculate column widths
    for (const r of resources) {
        widths[0] = Math.max(widths[0], (r.resourceType || '').length)
        widths[1] = Math.max(widths[1], Math.min((r.resourceId || '').length, 60))
        widths[2] = Math.max(widths[2], (r.project || '').length)
        widths[3] = Math.max(widths[3], (r.status || '').length)
        widths[4] = Math.max(widths[4], (r.createdAt || '').length)
    }

    const pad = (str, width) => String(str).padEnd(width)
    const separator = widths.map(w => '-'.repeat(w)).join('  ')

    console.log(header.map((h, i) => pad(h, widths[i])).join('  '))
    console.log(separator)

    for (const r of resources) {
        const id = (r.resourceId || '').length > 60
            ? r.resourceId.slice(0, 57) + '...'
            : r.resourceId || ''
        console.log([
            pad(r.resourceType || '', widths[0]),
            pad(id, widths[1]),
            pad(r.project || '', widths[2]),
            pad(r.status || '', widths[3]),
            pad(r.createdAt || '', widths[4])
        ].join('  '))
    }
}

/**
 * Handle the `add` subcommand.
 *
 * @param {Object} flags - Parsed flags
 * @param {AssetManager} assetManager - The AssetManager instance
 */
function handleAdd(flags, assetManager) {
    const { type, id, project, meta } = flags

    if (!type || !id || !project) {
        console.error('Error: --type, --id, and --project are required for the add command.')
        console.log('')
        printUsage()
        process.exitCode = 1
        return
    }

    if (!VALID_RESOURCE_TYPES.includes(type)) {
        console.error(`Error: Invalid resource type "${type}".`)
        console.error(`Valid types: ${VALID_RESOURCE_TYPES.join(', ')}`)
        process.exitCode = 1
        return
    }

    let metadata = {}
    if (meta) {
        try {
            metadata = JSON.parse(meta)
        } catch (err) {
            console.error(`Error: Invalid JSON for --meta: ${err.message}`)
            process.exitCode = 1
            return
        }
    }

    const now = new Date().toISOString()
    const record = {
        resourceId: id,
        resourceType: type,
        createdAt: now,
        lastUpdatedAt: now,
        project,
        status: 'active',
        metadata
    }

    assetManager.addResource(record)
    console.log(`Added ${type}: ${id}`)
}

/**
 * Handle the `delete` subcommand.
 *
 * @param {Object} flags - Parsed flags
 * @param {AssetManager} assetManager - The AssetManager instance
 */
function handleDelete(flags, assetManager) {
    const { id } = flags

    if (!id) {
        console.error('Error: --id is required for the delete command.')
        console.log('')
        printUsage()
        process.exitCode = 1
        return
    }

    const updated = assetManager.updateStatus(id, 'deleted')
    if (updated) {
        console.log(`Marked as deleted: ${id}`)
    } else {
        console.log(`Resource not found in manifest: ${id}`)
    }
}

/**
 * Handle the `list` subcommand.
 *
 * @param {Object} flags - Parsed flags
 * @param {AssetManager} assetManager - The AssetManager instance
 */
function handleList(flags, assetManager) {
    const filters = {}
    if (flags.project) filters.project = flags.project
    if (flags.status) filters.status = flags.status
    if (flags.type) filters.resourceType = flags.type

    const resources = assetManager.listResources(filters)
    printResourceTable(resources)
}

/**
 * Handle the `prune` subcommand — remove deleted and unknown records.
 *
 * @param {AssetManager} assetManager - The AssetManager instance
 */
function handlePrune(assetManager) {
    const all = assetManager.listResources()
    const stale = all.filter(r => r.status === 'deleted' || r.status === 'unknown')

    if (stale.length === 0) {
        console.log('Nothing to prune — all resources are active.')
        return
    }

    for (const resource of stale) {
        assetManager.removeResource(resource.resourceId)
        console.log(`  🗑️  [${resource.status}] ${resource.resourceType}: ${resource.resourceId}`)
    }

    const remaining = assetManager.listResources()
    console.log(`\nPruned ${stale.length} record${stale.length === 1 ? '' : 's'}. ${remaining.length} remaining.`)
}

/**
 * Main entry point. Resolves the active bootstrap profile,
 * instantiates AssetManager, and dispatches the subcommand.
 *
 * @param {string[]} argv - The raw process.argv array
 */
export function main(argv) {
    const { subcommand, flags } = parseArgs(argv)

    if (!subcommand) {
        printUsage()
        process.exitCode = 1
        return
    }

    // Resolve active bootstrap profile
    const bootstrapConfig = new BootstrapConfig()
    const activeProfile = bootstrapConfig.getActiveProfile()

    if (!activeProfile) {
        console.warn('Warning: No active bootstrap profile configured. Skipping manifest operation.')
        console.warn('Run "yo @aws/ml-container-creator --bootstrap" to configure a profile.')
        return
    }

    const assetManager = new AssetManager(activeProfile.name)

    switch (subcommand) {
        case 'add':
            handleAdd(flags, assetManager)
            break
        case 'delete':
            handleDelete(flags, assetManager)
            break
        case 'list':
            handleList(flags, assetManager)
            break
        case 'prune':
            handlePrune(assetManager)
            break
        default:
            console.error(`Unknown subcommand: ${subcommand}`)
            console.log('')
            printUsage()
            process.exitCode = 1
            break
    }
}

// Run when executed directly
const isDirectExecution = process.argv[1] && (
    process.argv[1].endsWith('manifest-cli.js') ||
    process.argv[1].endsWith('do/lib/manifest-cli.js')
)

if (isDirectExecution) {
    main(process.argv)
}
