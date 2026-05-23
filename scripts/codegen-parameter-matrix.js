#!/usr/bin/env node
/**
 * codegen-parameter-matrix.js — Generates the parameter matrix from parameter-schema-v2.json
 *
 * Replaces the 726-line hand-written _getParameterMatrix() in config-manager.js.
 * The matrix defines how each parameter is loaded from various sources.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'parameter-schema-v2.json'), 'utf8'));
const outDir = path.join(ROOT, 'src', 'lib', 'generated');
fs.mkdirSync(outDir, { recursive: true });

/**
 * Parameters that are required for generation.
 * Conditional requirements are handled at validation time, not in the matrix.
 */
const REQUIRED_PARAMS = new Set([
    'deploymentConfig'
]);

/**
 * Parameters that can be set via MCP server responses.
 */
const MCP_PARAMS = new Set([
    'instanceType', 'awsRegion', 'baseImage', 'modelName'
]);

/**
 * Parameters that are promptable (shown in interactive mode).
 */
const NON_PROMPTABLE = new Set([
    'skipPrompts', 'autoPrompt', 'config', 'force', 'projectDir',
    'smart', 'discover', 'noValidate', 'validateEnvVars', 'validateWithDocker', 'offline'
]);

/**
 * Parameters with ambient environment variables (read from env without ML_ prefix).
 */
const AMBIENT_ENV_VARS = {
    'awsRegion': 'AWS_REGION',
    'hfToken': 'HF_TOKEN'
};

/**
 * Parameters that are schema-validated at deploy time.
 */
const SCHEMA_VALIDATED = new Set([
    'endpointInitialInstanceCount', 'endpointDataCapturePercent', 'endpointVariantName',
    'endpointVolumeSize', 'icCpuCount', 'icMemorySize', 'icGpuCount', 'icCopyCount', 'icModelWeight'
]);

/**
 * Derived/internal parameters not in the CLI schema but needed in the matrix.
 */
const INTERNAL_PARAMS = {
    architecture: { cliOption: null, envVar: null, configFile: false, packageJson: false, mcp: false, promptable: false, required: false, default: null, valueSpace: 'bounded' },
    backend: { cliOption: null, envVar: null, configFile: false, packageJson: false, mcp: false, promptable: false, required: false, default: null, valueSpace: 'bounded' },
    engine: { cliOption: 'engine', envVar: null, configFile: true, packageJson: false, mcp: false, promptable: true, required: false, default: null, valueSpace: 'bounded' },
    destinationDir: { cliOption: 'project-dir', envVar: 'ML_PROJECT_DIR', configFile: false, packageJson: false, mcp: false, promptable: false, required: false, default: null, valueSpace: 'unbounded' },
    modelPackageArn: { cliOption: null, envVar: null, configFile: true, packageJson: false, mcp: false, promptable: false, required: false, default: null, valueSpace: 'unbounded' },
    codebuildProjectName: { cliOption: null, envVar: null, configFile: true, packageJson: false, mcp: false, promptable: false, required: false, default: null, valueSpace: 'unbounded' },
    skipPrompts: { cliOption: 'skip-prompts', envVar: 'MCC_SKIP_PROMPTS', configFile: false, packageJson: false, mcp: false, promptable: false, required: false, default: false, valueSpace: 'bounded' },
    asyncS3OutputPath: { cliOption: 'async-s3-output-path', envVar: 'ML_ASYNC_S3_OUTPUT_PATH', configFile: true, packageJson: false, mcp: false, promptable: true, required: false, default: null, valueSpace: 'unbounded' },
    configFile: { cliOption: 'config', envVar: null, configFile: false, packageJson: false, mcp: false, promptable: false, required: false, default: null, valueSpace: 'unbounded' }
};

// Build the matrix
const matrix = {};

/**
 * Map schema configKey to the internal matrix key used by config-manager.
 * Most are 1:1, these are the exceptions.
 */
const KEY_MAP = {
    'region': 'awsRegion',
    'roleArn': 'awsRoleArn',
    'asyncMaxConcurrent': 'asyncMaxConcurrentInvocations',
    'batchMaxConcurrent': 'batchMaxConcurrentTransforms',
    'batchMaxPayload': 'batchMaxPayloadInMB',
    'benchmarkInputTokens': 'benchmarkInputTokensMean',
    'benchmarkOutputTokens': 'benchmarkOutputTokensMean',
    'hyperpodCluster': 'hyperPodCluster',
    'hyperpodNamespace': 'hyperPodNamespace',
    'hyperpodReplicas': 'hyperPodReplicas',
    'includeSample': 'includeSampleModel'
};

/**
 * Parameters in the schema that should NOT appear in the matrix
 * (pure CLI behavior flags, deprecated, or handled differently).
 */
const SKIP_PARAMS = new Set([
    'autoPrompt', 'config', 'force', 'projectDir',
    'smart', 'discover', 'noValidate', 'validateEnvVars', 'validateWithDocker', 'offline',
    'framework', 'modelServer', 'modelEnv', 'serverEnv', 'ngcToken',
    'testTypes'
]);

// Add schema-derived parameters
for (const [key, param] of Object.entries(schema.parameters)) {
    if (SKIP_PARAMS.has(key)) continue;
    if (INTERNAL_PARAMS[KEY_MAP[key] || key]) continue;

    const matrixKey = KEY_MAP[key] || key;
    const cliOption = param.cliFlag ? param.cliFlag.replace(/^--/, '') : null;

    matrix[matrixKey] = {
        cliOption,
        envVar: param.envVar || null,
        configFile: true,
        packageJson: false,
        mcp: MCP_PARAMS.has(key),
        promptable: !NON_PROMPTABLE.has(key) && param.prompt !== null,
        required: REQUIRED_PARAMS.has(key),
        default: param.default !== undefined ? param.default : null,
        valueSpace: param.validation?.enum ? 'bounded' : (param.type === 'boolean' ? 'bounded' : 'unbounded')
    };

    if (AMBIENT_ENV_VARS[matrixKey]) {
        matrix[matrixKey].ambientEnvVar = AMBIENT_ENV_VARS[matrixKey];
    }

    if (SCHEMA_VALIDATED.has(matrixKey)) {
        matrix[matrixKey].schemaValidated = true;
    }
}

// Add internal/derived parameters
for (const [key, entry] of Object.entries(INTERNAL_PARAMS)) {
    matrix[key] = entry;
}

// Generate the output
const output = `// AUTO-GENERATED by scripts/codegen-parameter-matrix.js — DO NOT EDIT
// Source: config/parameter-schema-v2.json
// Generated: ${new Date().toISOString()}

/**
 * Parameter matrix defining how each parameter is loaded from various sources.
 * Used by ConfigManager for configuration loading and validation.
 */
export const parameterMatrix = ${JSON.stringify(matrix, null, 4)};
`;

fs.writeFileSync(path.join(outDir, 'parameter-matrix.js'), output);
console.log(`✅ Generated src/lib/generated/parameter-matrix.js (${Object.keys(matrix).length} parameters)`);
