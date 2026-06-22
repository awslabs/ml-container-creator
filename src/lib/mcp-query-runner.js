// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * MCP Query Runner - Handles all MCP server queries for the prompt runner.
 * Uses delegation pattern: receives parent PromptRunner reference to access shared state.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import {
    baseImageSearchPrompts,
    formatImageChoices
} from './prompts/index.js';

const __mcp_filename = fileURLToPath(import.meta.url);
const __mcp_dirname = path.dirname(__mcp_filename);
const GENERATOR_ROOT = path.resolve(__mcp_dirname, '..', '..');

/**
 * Resolve MCP server args — converts relative paths to absolute using GENERATOR_ROOT.
 * @param {string[]} args - The args array from mcp.json serverConfig
 * @returns {string[]} Args with relative paths resolved
 */
function resolveMcpArgs(args) {
    return (args || []).map(arg => {
        if (arg && !path.isAbsolute(arg) && !arg.startsWith('-')) {
            return path.resolve(GENERATOR_ROOT, arg);
        }
        return arg;
    });
}

export default class McpQueryRunner {
    constructor(runner) {
        this.runner = runner;
    }

    async _queryMcpForRegion(frameworkAnswers, explicitConfig) {
        const cm = this.runner.configManager;
        if (!cm) return;

        const mcpServers = cm.getMcpServerNames();
        if (mcpServers.length === 0) return;

        const smart = this.runner.options.smart === true;

        // Region: skip MCP query if region was explicitly provided via CLI, config file, or bootstrap profile
        const cliRegion = this.runner.options.region;
        const bootstrapRegion = explicitConfig.awsRegion;
        const skipRegionQuery = (cliRegion !== undefined && cliRegion !== null) ||
            (bootstrapRegion !== undefined && bootstrapRegion !== null);

        if (!skipRegionQuery && mcpServers.includes('region-picker')) {
            const { regionSearch } = await this.runner._runPrompts([{
                type: 'input',
                name: 'regionSearch',
                message: '🔌 Search for a region (e.g. "europe", "us west", "tokyo"):',
                default: ''
            }]);

            if (regionSearch && regionSearch.trim()) {
                console.log(`   🔍 Querying region-picker${smart ? ' [smart]' : ''}...`);
                const result = await cm.queryMcpServer('region-picker', {
                    ...frameworkAnswers,
                    regionSearch: regionSearch.trim()
                });
                if (result && result.choices?.awsRegion?.length > 0) {
                    const choices = result.choices.awsRegion;
                    const preview = choices.length <= 5
                        ? choices.join(', ')
                        : `${choices.slice(0, 5).join(', ')  } (+${choices.length - 5} more)`;
                    console.log(`   ✓ ${choices.length} region(s): [${preview}]`);
                } else {
                    console.log('   ↳ No MCP results, using static list');
                }
            }
        }
    }

    /**
     * Query MCP instance-sizer server with tag-based search after deployment target is known.
     * Used when no model name is available for VRAM-based sizing.
     * Populates configManager.mcpChoices so _runPhase injects them into list prompts.
     * @private
     */
    async _queryMcpForInstance(frameworkAnswers, explicitConfig) {
        const cm = this.runner.configManager;
        if (!cm) return;

        const mcpServers = cm.getMcpServerNames();
        if (mcpServers.length === 0) return;

        const smart = this.runner.options.smart === true;

        // Instance type: query if not already provided via CLI/config
        if (!explicitConfig.instanceType && mcpServers.includes('instance-sizer')) {
            const { instanceSearch } = await this.runner._runPrompts([{
                type: 'input',
                name: 'instanceSearch',
                message: '🔌 Describe your instance needs (e.g. "multi-gpu", "cost-effective cpu"):',
                default: frameworkAnswers.framework || ''
            }]);

            if (instanceSearch && instanceSearch.trim()) {
                console.log(`   🔍 Querying instance-sizer [search]${smart ? ' [smart]' : ''}...`);
                const result = await cm.queryMcpServer('instance-sizer', {
                    ...frameworkAnswers,
                    instanceSearch: instanceSearch.trim()
                });
                if (result && result.choices?.instanceType?.length > 0) {
                    const choices = result.choices.instanceType;
                    const preview = choices.length <= 5
                        ? choices.join(', ')
                        : `${choices.slice(0, 5).join(', ')  } (+${choices.length - 5} more)`;
                    console.log(`   ✓ ${choices.length} instance(s): [${preview}]`);
                } else {
                    console.log('   ↳ No MCP results, using static list');
                }
            }
        }
    }

    /**
     * Query the instance-sizer MCP server after model is known.
     * Estimates VRAM requirements and returns filtered, ranked instance recommendations.
     * Stores results in this.runner._mcpInstanceSizerChoices and this.runner._instanceSizerMetadata.
     * Requirements: 4.4, 4.5, 4.7, 3.6, 3.7
     * @private
     */
    async _queryMcpForInstanceSizing(frameworkAnswers, modelFormatAnswers, explicitConfig, sizerContext = {}) {
        const cm = this.runner.configManager;
        if (!cm) return;

        const mcpServers = cm.getMcpServerNames();
        if (!mcpServers.includes('instance-sizer')) return;

        // Resolve model name from answers or explicit config
        const modelName = modelFormatAnswers.customModelName || modelFormatAnswers.modelName || explicitConfig.modelName;
        if (!modelName || modelName === 'Custom (enter manually)') return;

        const smart = this.runner.options.smart === true;
        const discover = this.runner.options.discover !== false;

        const modeLabel = [smart && '[smart]', !discover && '[no-discover]'].filter(Boolean).join(' ');
        console.log(`   🔍 Querying instance-sizer${modeLabel ? ` ${modeLabel}` : ''}...`);

        try {
            const mcpConfigPath = path.join(GENERATOR_ROOT, 'config', 'mcp.json');
            if (!fs.existsSync(mcpConfigPath)) return;

            const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
            const serverConfig = mcpConfig.mcpServers?.['instance-sizer'];
            if (!serverConfig) return;

            const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
            const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

            const serverArgs = [...resolveMcpArgs(serverConfig.args)];
            if (!discover && !serverArgs.includes('--no-discover')) {
                serverArgs.push('--no-discover');
            }

            const transport = new StdioClientTransport({
                command: serverConfig.command,
                args: serverArgs,
                env: {
                    ...process.env,
                    ...(serverConfig.env || {}),
                    ...(smart ? { BEDROCK_SMART: 'true' } : {})
                },
                stderr: 'pipe'
            });

            const mcpClient = new Client(
                { name: 'ml-container-creator', version: '1.0.0' },
                { capabilities: {} }
            );

            await mcpClient.connect(transport);

            const toolArgs = {
                modelName,
                limit: 10,
                context: {
                    architecture: frameworkAnswers.architecture || undefined,
                    backend: frameworkAnswers.backend || undefined,
                    deploymentTarget: frameworkAnswers.deploymentTarget || undefined,
                    profileEnvVars: sizerContext.profileEnvVars || undefined
                }
            };

            // Add CUDA version from base image for filtering
            if (sizerContext.cudaVersion) {
                toolArgs.cudaVersion = sizerContext.cudaVersion;
            }

            // Add quantization if available from model format answers
            if (modelFormatAnswers.quantization) {
                toolArgs.quantization = modelFormatAnswers.quantization;
            }

            const result = await mcpClient.callTool({
                name: 'get_instance_recommendation',
                arguments: toolArgs
            });

            await mcpClient.close();

            // Parse the response
            const textBlock = result?.content?.find(b => b.type === 'text');
            if (textBlock) {
                const parsed = JSON.parse(textBlock.text);

                if (parsed.choices?.instanceType?.length > 0) {
                    this.runner._instanceSizerMetadata = parsed.metadata || null;

                    // Store maxModelLen from sizer if context was capped (AC-1.7)
                    if (parsed.values?.maxModelLen) {
                        this.runner._sizerMaxModelLen = parsed.values.maxModelLen;
                        console.log(`   ✓ Context length capped: max_model_len=${parsed.values.maxModelLen}`);
                    }

                    // Build display labels with VRAM estimate and utilization percentage
                    const recommendations = parsed.metadata?.recommendations || [];
                    const estimatedVramGb = parsed.metadata?.estimatedVramGb;
                    
                    // Store choices with display labels for the instance prompt
                    this.runner._mcpInstanceSizerChoices = parsed.choices.instanceType;
                    this.runner._mcpInstanceSizerDisplayChoices = recommendations.map(rec => ({
                        name: rec.displayLabel || `${rec.instanceType} (${estimatedVramGb ? estimatedVramGb.toFixed(1) : '?'}GB / ${rec.totalVramGb || '?'}GB — ${rec.utilizationPercent || '?'}% utilization)`,
                        value: rec.instanceType,
                        short: rec.instanceType
                    }));

                    const choices = parsed.choices.instanceType;
                    const topRec = recommendations[0];
                    const vramInfo = estimatedVramGb
                        ? ` (model needs ~${estimatedVramGb.toFixed(1)}GB VRAM)`
                        : '';

                    console.log(`   ✓ ${choices.length} compatible instance(s) found${vramInfo}`);

                    // Warn if all instances had zero quota but were restored for visibility
                    if (parsed.metadata?.allFilteredByQuota) {
                        console.log('   ⚠️  All instances have zero quota — request a quota increase for your preferred type');
                    }

                    // Check if availability data is present (recommendations have capacityType)
                    const hasAvailabilityData = recommendations.some(r => r.capacityType);

                    if (hasAvailabilityData) {
                        // Group by capacityType for display
                        const reserved = recommendations.filter(r => r.capacityType === 'reserved' || r.capacityType === 'ftp');
                        const onDemand = recommendations.filter(r => r.capacityType === 'on-demand');

                        if (reserved.length > 0) {
                            console.log('     ── Reserved Capacity ──');
                            for (const rec of reserved) {
                                const tp = rec.tensorParallelism > 1 ? ` TP=${rec.tensorParallelism}` : '';
                                const vram = rec.totalVramGb ? `${rec.totalVramGb}GB` : '?';
                                const util = rec.utilizationPercent ? `${rec.utilizationPercent}%` : '?';
                                const tag = rec.capacityType === 'reserved'
                                    ? ` [CR] ${rec.reservationInfo?.planName || rec.reservationInfo?.reservationId || ''}`
                                    : ` [FTP] ${rec.ftpInfo?.planName || ''}`;
                                console.log(`     ${rec === topRec ? '→' : ' '} ${rec.instanceType.padEnd(20)} ${vram.padStart(5)} VRAM  ${util.padStart(4)} util${tp}${tag}`);
                            }
                        }

                        if (onDemand.length > 0) {
                            console.log('     ── On-Demand ──');
                            for (const rec of onDemand) {
                                const tp = rec.tensorParallelism > 1 ? ` TP=${rec.tensorParallelism}` : '';
                                const vram = rec.totalVramGb ? `${rec.totalVramGb}GB` : '?';
                                const util = rec.utilizationPercent ? `${rec.utilizationPercent}%` : '?';
                                const deployed = rec.quotaDeployed;
                                const quota = rec.quotaLimit;
                                const tag = quota !== null && quota !== undefined ? ` [Q:${deployed ?? 0}/${quota}]` : '';
                                console.log(`     ${rec === topRec ? '→' : ' '} ${rec.instanceType.padEnd(20)} ${vram.padStart(5)} VRAM  ${util.padStart(4)} util${tp}${tag}`);
                            }
                        }
                    } else {
                        // Fallback: display compact recommendation table (no availability data)
                        for (const rec of recommendations) {
                            const tp = rec.tensorParallelism > 1 ? ` TP=${rec.tensorParallelism}` : '';
                            const vram = rec.totalVramGb ? `${rec.totalVramGb}GB` : '?';
                            const util = rec.utilizationPercent ? `${rec.utilizationPercent}%` : '?';
                            console.log(`     ${rec === topRec ? '→' : ' '} ${rec.instanceType.padEnd(20)} ${vram.padStart(5)} VRAM  ${util.padStart(4)} util${tp}`);
                        }
                    }
                } else if (parsed.metadata?.allFilteredByQuota) {
                    // All VRAM-compatible instances had zero quota
                    console.log('   ⚠️ No quota available for compatible instances. Request a quota increase.');
                    this.runner._instanceSizerMetadata = parsed.metadata || null;
                } else if (parsed.metadata?.warning) {
                    console.log(`   ⚠️  ${parsed.metadata.warning}`);
                } else {
                    // Apply architecture heuristic fallback when sizer returns empty
                    const archForHeuristic = frameworkAnswers.architecture || frameworkAnswers.deploymentConfig?.split('-')[0];
                    this.runner._architectureHeuristicDefault = this.runner._getArchitectureHeuristicDefault(archForHeuristic);
                    console.log(`   ↳ No instance-sizer results, using heuristic default: ${this.runner._architectureHeuristicDefault}`);
                }
            }
        } catch (err) {
            // Sizer unavailable — apply architecture heuristic fallback
            const archForHeuristic = frameworkAnswers.architecture || frameworkAnswers.deploymentConfig?.split('-')[0];
            this.runner._architectureHeuristicDefault = this.runner._getArchitectureHeuristicDefault(archForHeuristic);
            console.log(`   ⚠️  instance-sizer: ${err.message}`);
            console.log(`   ↳ Using heuristic default: ${this.runner._architectureHeuristicDefault}`);
        }
    }

    /**
     * Query the hyperpod-cluster-picker MCP server for available HyperPod EKS clusters.
     * Populates configManager.mcpChoices.hyperPodCluster so _runPhase injects them into the list prompt.
     * Falls back to manual entry if the MCP server is not configured or fails.
     * Requirements: 12.1, 12.2, 12.3
     * @private
     */
    async _queryMcpForHyperPod(infraAnswers, explicitConfig) {
        const cm = this.runner.configManager;
        if (!cm) return;

        const mcpServers = cm.getMcpServerNames();
        if (!mcpServers.includes('hyperpod-cluster-picker')) return;

        // Skip if cluster already provided via CLI/config
        if (explicitConfig.hyperPodCluster) return;

        const smart = this.runner.options.smart === true;
        console.log(`   🔍 Querying hyperpod-cluster-picker${smart ? ' [smart]' : ''}...`);

        const result = await cm.queryMcpServer('hyperpod-cluster-picker', {
            ...infraAnswers
        });

        if (result && result.choices?.hyperPodCluster?.length > 0) {
            const choices = result.choices.hyperPodCluster;
            const preview = choices.length <= 5
                ? choices.join(', ')
                : `${choices.slice(0, 5).join(', ')} (+${choices.length - 5} more)`;
            console.log(`   ✓ ${choices.length} cluster(s): [${preview}]`);
        } else {
            // Surface any error message from the MCP server
            if (result?.message) {
                console.log(`   ⚠️  ${result.message}`);
            } else {
                console.log('   ↳ No HyperPod clusters found via MCP, manual entry available');
            }
        }
    }

    /**
     * Query the endpoint-picker MCP server for available InService real-time endpoints.
     * Populates this.runner._mcpEndpointChoices for the existing endpoint selection prompt.
     * Graceful fallback: if MCP server fails (no credentials, timeout), skip and create new endpoint.
     * Requirements: 3.3, 4.3, 4.4
     * @private
     */
    async _queryMcpForEndpoints(infraAnswers, explicitConfig) {
        const cm = this.runner.configManager;
        if (!cm) return;

        const mcpServers = cm.getMcpServerNames();
        if (!mcpServers.includes('endpoint-picker')) return;

        // Skip if existing endpoint already provided via CLI/config
        if (explicitConfig.existingEndpointName) return;

        console.log('   🔍 Querying endpoint-picker...');

        try {
            const result = await cm.queryMcpServer('endpoint-picker', {
                awsRegion: infraAnswers.awsRegion,
                deploymentTarget: 'realtime-inference'
            });

            if (result && result.choices?.endpointName?.length > 0) {
                const endpointNames = result.choices.endpointName;
                const metadata = result.metadata || {};

                // Build choices with metadata annotations
                this.runner._mcpEndpointChoices = endpointNames.map(name => {
                    const meta = metadata[name];
                    if (meta) {
                        const gpuInfo = meta.availableGpus === '?' ? 'GPUs: ?' : `${meta.availableGpus} GPUs free`;
                        return {
                            name: `${name} (${meta.instanceType}, ${gpuInfo}, ${meta.icCount} IC${meta.icCount !== 1 ? 's' : ''})`,
                            value: name
                        };
                    }
                    return { name, value: name };
                });

                console.log(`   ✓ ${endpointNames.length} endpoint(s) with available capacity`);
            } else {
                if (result?.message) {
                    console.log(`   ↳ ${result.message}`);
                } else {
                    console.log('   ↳ No endpoints with available capacity found');
                }
            }
        } catch (err) {
            // Graceful fallback: if MCP server fails, skip and create new endpoint
            console.log(`   ⚠️  endpoint-picker: ${err.message || 'query failed'} — will create new endpoint`);
        }
    }

    /**
     * Query MCP base-image-picker server after deployment config is selected.
     * Populates _mcpBaseImageChoices for the base image selection prompt.
     * Requirements: 5.1, 5.2, 5.3, 5.4, 9.1, 9.2, 9.3
     * @private
     */
    async _queryMcpForBaseImage(frameworkAnswers, _explicitConfig) {
        // Skip if base image provided via CLI --base-image flag
        if (this.runner.options['base-image']) return;

        const cm = this.runner.configManager;
        if (!cm) return;

        const mcpServers = cm.getMcpServerNames();
        if (!mcpServers.includes('base-image-picker')) return;

        const smart = this.runner.options.smart === true;
        const discover = this.runner.options.discover !== false;
        const framework = frameworkAnswers.framework;
        const modelServer = frameworkAnswers.modelServer;
        const architecture = frameworkAnswers.architecture || frameworkAnswers.deploymentConfig?.split('-')[0];
        const isTransformer = framework === 'transformers';
        const isTriton = architecture === 'triton';
        const isDiffusors = architecture === 'diffusors';

        // For non-transformer, non-triton, non-diffusors frameworks, prompt for optional search criteria
        let searchCriteria;
        if (!isTransformer && !isTriton && !isDiffusors) {
            const searchAnswer = await this.runner._runPrompts(baseImageSearchPrompts.map(p => ({
                ...p,
                when: () => true // Always show for non-transformer since we already checked
            })));
            searchCriteria = searchAnswer.baseImageSearch;
        }

        const modeLabel = [smart && '[smart]', discover && '[discover]'].filter(Boolean).join(' ');
        console.log(`   🔍 Querying base-image-picker${modeLabel ? ` ${modeLabel}` : ''}...`);

        const context = { framework, modelServer, architecture };
        if (searchCriteria && searchCriteria.trim()) {
            context.searchCriteria = searchCriteria.trim();
        }

        const result = await cm.queryMcpServer('base-image-picker', context);

        if (result && result.metadata?.baseImage?.length > 0) {
            const entries = result.metadata.baseImage;
            this.runner._mcpBaseImageChoices = formatImageChoices(entries, isTransformer || isTriton || isDiffusors);
            const count = entries.length;
            console.log(`   ✓ ${count} base image(s) available`);
        } else {
            console.log('   ↳ No MCP results, using default image');
        }
    }

    /**
     * Query model-picker MCP server catalog for model choices.
     * Reads the architecture-specific catalog (popular-transformers.json or
     * popular-diffusors.json) to populate the model selection prompt.
     * @param {string} [architecture] - Current architecture ('transformers', 'diffusors', etc.)
     * @private
     */
    _queryMcpForModels(architecture) {
        const cm = this.runner.configManager;
        if (!cm) return;

        const mcpServers = cm.getMcpServerNames();
        if (!mcpServers.includes('model-picker')) return;

        try {
            const mcpConfigPath = path.join(GENERATOR_ROOT, 'config', 'mcp.json');
            if (!fs.existsSync(mcpConfigPath)) return;

            const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
            const serverConfig = mcpConfig.mcpServers?.['model-picker'];
            if (!serverConfig?.args?.length) return;

            // Resolve the server entry point directory from the args
            const serverEntryPoint = serverConfig.args[serverConfig.args.length - 1];
            const serverDir = path.dirname(serverEntryPoint);

            // Read manifest to find catalog path
            const manifestPath = path.join(serverDir, 'manifest.json');
            if (!fs.existsSync(manifestPath)) return;

            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

            // Select catalog based on architecture
            const catalogKey = architecture === 'diffusors'
                ? 'popular-diffusors'
                : 'popular-transformers';
            const catalogRelPath = manifest.catalogs?.[catalogKey];
            if (!catalogRelPath) return;

            const catalogPath = path.resolve(serverDir, catalogRelPath);
            if (!fs.existsSync(catalogPath)) return;

            const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

            // Extract model IDs, filtering out glob patterns (entries with *)
            const modelIds = Object.keys(catalog).filter(id => !id.includes('*'));

            if (modelIds.length > 0) {
                this.runner._mcpModelChoices = modelIds;
            }
        } catch {
            // Silently fall back to hardcoded defaults
        }
    }

    /**
     * Fetch and display model information from HuggingFace API and Model Registry
     * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.11, 11.1, 11.2, 11.3, 11.5, 11.6, 11.7
     * @private
     */
    async _fetchAndDisplayModelInfo(modelId) {
        console.log('\n   🔍 Querying model-picker [discover]...');

        const sources = [];
        let chatTemplate = null;
        let modelFamily = null;
        let mcpUsed = false;

        // Try model-picker MCP server in discover mode (queries HuggingFace + merges with catalog)
        const cm = this.runner.configManager;
        if (cm) {
            const mcpServers = cm.getMcpServerNames();
            if (mcpServers.includes('model-picker')) {
                try {
                    const mcpConfigPath = path.join(GENERATOR_ROOT, 'config', 'mcp.json');
                    if (fs.existsSync(mcpConfigPath)) {
                        const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
                        const serverConfig = mcpConfig.mcpServers?.['model-picker'];
                        if (serverConfig) {
                            const { McpClient } = await import('./mcp-client.js');
                            const client = new McpClient(serverConfig, { timeout: 15000 });

                            // Override _buildContext to pass model_id and mode directly
                            client._getUnboundedParameterNames = () => [];
                            client._buildContext = () => ({});

                            // Connect and call get_models directly
                            const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
                            const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

                            const transport = new StdioClientTransport({
                                command: serverConfig.command,
                                args: resolveMcpArgs(serverConfig.args),
                                env: { ...process.env, ...(serverConfig.env || {}) },
                                stderr: 'pipe'
                            });

                            const mcpClient = new Client(
                                { name: 'ml-container-creator', version: '1.0.0' },
                                { capabilities: {} }
                            );

                            await mcpClient.connect(transport);

                            const result = await mcpClient.callTool({
                                name: 'get_models',
                                arguments: { model_id: modelId, mode: 'discover' }
                            });

                            await mcpClient.close();

                            // Parse the response
                            const textBlock = result?.content?.find(b => b.type === 'text');
                            if (textBlock) {
                                const parsed = JSON.parse(textBlock.text);
                                if (parsed.values && Object.keys(parsed.values).length > 0) {
                                    mcpUsed = true;
                                    const vals = parsed.values;

                                    if (vals.chat_template) {
                                        chatTemplate = vals.chat_template;
                                    }
                                    if (vals.family) {
                                        modelFamily = vals.family;
                                    }

                                    // Extract model_type for architecture validation
                                    // Requirements: 4.1
                                    if (vals.model_type) {
                                        this.runner._modelType = vals.model_type;
                                    }

                                    // Extract model source metadata for loading adapter
                                    // Requirements: 2.1, 2.2, 2.3, 2.4
                                    if (vals.provider) {
                                        this.runner._mcpModelSource = vals.provider;
                                    }
                                    if (vals.artifactUri) {
                                        this.runner._mcpArtifactUri = vals.artifactUri;
                                    }

                                    // Determine sources based on what was returned
                                    if (vals.tags || vals.pipeline_tag) {
                                        sources.push('HuggingFace_Hub_API');
                                    }
                                    if (vals.validation_level || vals.framework_compatibility) {
                                        sources.push('Model_Picker_Catalog');
                                    }
                                    if (sources.length === 0) {
                                        sources.push('model-picker');
                                    }
                                    console.log(`   ✓ Resolved: ${modelId}`);
                                } else if (parsed.message) {
                                    console.log(`   ↳ ${parsed.message}`);
                                }
                            }
                        }
                    }
                } catch (err) {
                    console.log('   ↳ model-picker unavailable, using fallback');
                }
            }
        }

        // Fallback to legacy path if MCP didn't resolve
        if (!mcpUsed) {
            const registryConfigManager = this.runner.registryConfigManager;
            if (registryConfigManager) {
                // Only try HuggingFace API for bare model IDs (not prefixed URIs)
                const isNonHfUri = modelId.startsWith('s3://') ||
                        modelId.startsWith('registry://');

                if (!isNonHfUri) {
                    // Try HuggingFace API directly
                    try {
                        const hfData = await registryConfigManager._fetchHuggingFaceData(modelId);
                        if (hfData) {
                            sources.push('HuggingFace_Hub_API');
                            if (hfData.chatTemplate) {
                                chatTemplate = hfData.chatTemplate;
                            }
                            // Extract model_type for architecture validation
                            // Requirements: 4.1
                            if (hfData.modelConfig?.model_type) {
                                this.runner._modelType = hfData.modelConfig.model_type;
                            }
                            console.log('   ✅ Found on HuggingFace Hub');
                        } else {
                            console.log('   ℹ️  Not found on HuggingFace Hub (may be private or offline)');
                        }
                    } catch (error) {
                        console.log('   ⚠️  HuggingFace API unavailable');
                    }
                } else {
                    // Non-HF URI (s3://, registry://, etc.) — skip HF lookup silently
                }

                // Check Model Registry for overrides
                if (registryConfigManager.modelRegistry) {
                    let modelConfig = registryConfigManager.modelRegistry[modelId];

                    if (!modelConfig) {
                        for (const [pattern, config] of Object.entries(registryConfigManager.modelRegistry)) {
                            if (pattern.includes('*')) {
                                const regex = new RegExp(`^${  pattern.replace(/\*/g, '.*')  }$`);
                                if (regex.test(modelId)) {
                                    modelConfig = config;
                                    console.log(`   ✅ Matched pattern in Model_Registry: ${pattern}`);
                                    break;
                                }
                            }
                        }
                    } else {
                        console.log('   ✅ Found in Model_Registry');
                    }

                    if (modelConfig) {
                        sources.push('Model_Registry');
                        if (modelConfig.chatTemplate) {
                            chatTemplate = modelConfig.chatTemplate;
                        }
                        if (modelConfig.family) {
                            modelFamily = modelConfig.family;
                        }
                    }
                }
            }
        }

        // Display information
        if (sources.length > 0) {
            console.log('\n📋 Model Information:');
            console.log(`   • Model ID: ${modelId}`);
            if (modelFamily) {
                console.log(`   • Family: ${modelFamily}`);
            }
            if (chatTemplate) {
                console.log('   • Chat Template: ✅ Available');
                console.log('     (Will be injected into generated files)');
            } else {
                console.log('   • Chat Template: ❌ Not available');
                console.log('     (Chat endpoints may require manual configuration)');
            }
            console.log(`   • Sources: ${sources.join(', ')}`);
        } else {
            console.log('   ℹ️  No additional model information available');
            console.log('   Proceeding with default configuration');
        }
    }

    /**
     * Validate and display instance type compatibility
     * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
     * @private
     */
    async _validateAndDisplayInstanceType(instanceType, framework, version) {
        const registryConfigManager = this.runner.registryConfigManager;
        
        if (!registryConfigManager) {
            return;
        }
        
        // Get framework configuration
        const frameworkConfig = registryConfigManager.frameworkRegistry?.[framework]?.[version];
        if (!frameworkConfig) {
            return; // No framework config, skip validation
        }
        
        console.log(`\n🔍 Validating instance type: ${instanceType}`);
        
        // Validate instance type
        const validationResult = registryConfigManager.validateInstanceType(instanceType, frameworkConfig);
        
        if (validationResult.compatible) {
            console.log('   ✅ Instance type is compatible');
            if (validationResult.info) {
                console.log(`   ℹ️  ${validationResult.info}`);
            }
        } else {
            console.log('   ❌ Instance type compatibility issue detected');
            if (validationResult.error) {
                console.log(`   Error: ${validationResult.error}`);
            }
            if (validationResult.recommendations && validationResult.recommendations.length > 0) {
                console.log(`   💡 Recommended instances: ${validationResult.recommendations.join(', ')}`);
            }
            
            // In test mode or non-interactive mode, throw error instead of prompting
            if (this.runner.options.skipPrompts || process.env.NODE_ENV === 'test') {
                throw new Error('Instance type validation failed. Please select a compatible instance type.');
            }
            
            // Ask user if they want to proceed
            const proceed = await this.runner._runPrompts([{
                type: 'confirm',
                name: 'proceedWithIncompatible',
                message: 'Instance type may not be compatible. Proceed anyway?',
                default: false
            }]);
            
            if (!proceed.proceedWithIncompatible) {
                throw new Error('Instance type validation failed. Please select a compatible instance type.');
            }
        }
        
        if (validationResult.warning) {
            console.log(`   ⚠️  Warning: ${validationResult.warning}`);
        }
    }
}
