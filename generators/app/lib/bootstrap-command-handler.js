// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bootstrap Command Handler
 *
 * Handles the `bootstrap` CLI subcommand tree for provisioning shared
 * AWS infrastructure (IAM role, ECR repository, S3 buckets) and
 * persisting configuration to ~/.ml-container-creator/config.json.
 *
 * Subcommands:
 *   (no args)                          Interactive setup flow
 *   status                             Show active profile and resource state
 *   use <profile>                      Switch active bootstrap profile
 *   list                               List all bootstrap profiles
 *   remove <profile> [--force]         Remove a bootstrap profile
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import BootstrapConfig from './bootstrap-config.js'
import AwsProfileParser from './aws-profile-parser.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default class BootstrapCommandHandler {
    constructor(generator) {
        this.generator = generator
        this.config = new BootstrapConfig()
        this.profileParser = new AwsProfileParser()
    }

    /**
     * Dispatch bootstrap subcommands.
     * @param {string[]} args - Remaining positional args after 'bootstrap'
     * @param {object} options - Parsed CLI options
     */
    async handle(args, options) {
        if (args.length === 0) {
            await this._handleInteractiveSetup(options)
            return
        }

        const subcommand = args[0].toLowerCase()

        switch (subcommand) {
            case 'status':
                await this._handleStatus()
                break
            case 'use':
                await this._handleUse(args[1])
                break
            case 'list':
                await this._handleList()
                break
            case 'remove':
                await this._handleRemove(args[1], options)
                break
            default:
                console.log(`Unknown bootstrap subcommand: ${subcommand}`)
                this._showHelp()
                break
        }
    }

    /**
     * Interactive setup flow — provisions AWS resources and saves profile.
     * @param {object} options - Parsed CLI options
     */
    async _handleInteractiveSetup(options) {
        const nonInteractive = options['non-interactive']

        // Non-interactive mode: validate required flags upfront
        if (nonInteractive) {
            const missingFlags = []
            if (!options.profile) {
                missingFlags.push('--profile')
            }
            if (!options.region) {
                missingFlags.push('--region')
            }
            if (missingFlags.length > 0) {
                console.log(`❌ Missing required flags for non-interactive mode: ${missingFlags.join(', ')}`)
                return
            }
        }

        console.log('\n🚀 Bootstrap — Shared AWS Infrastructure Setup\n')

        // Determine bootstrap profile name
        let profileName
        if (nonInteractive) {
            profileName = options.name || 'default'
        } else {
            const answer = await this.generator.prompt([{
                type: 'input',
                name: 'profileName',
                message: 'Bootstrap profile name:',
                default: 'default'
            }])
            profileName = answer.profileName
        }

        const profileData = {}

        // Step 1: AWS profile selection
        this._displayProgress('🔍', 'Selecting AWS profile...')
        let awsProfile
        if (nonInteractive) {
            awsProfile = options.profile
        } else {
            awsProfile = await this._selectProfile(options)
        }
        profileData.awsProfile = awsProfile
        this._currentProfile = awsProfile

        // Step 2: Credential validation
        this._displayProgress('🔑', 'Validating AWS credentials...')
        const { accountId, region } = await this._validateCredentials(awsProfile, nonInteractive ? options.region : undefined)
        profileData.accountId = accountId
        profileData.awsRegion = region
        this._currentRegion = region
        this._currentAccountId = accountId

        // Step 3: IAM role setup
        this._displayProgress('👤', 'Setting up IAM role...')
        try {
            if (nonInteractive && options['role-arn']) {
                profileData.roleArn = options['role-arn']
                console.log(`  ✅ Using provided IAM role ARN: ${options['role-arn']}`)
            } else {
                const roleArn = await this._setupIamRole(options)
                profileData.roleArn = roleArn
            }
        } catch (error) {
            console.log(`⚠️  IAM role setup failed: ${error.message}`)
        }

        // Step 4: ECR repository setup
        this._displayProgress('📦', 'Setting up ECR repository...')
        try {
            const ecrRepositoryName = await this._setupEcrRepository()
            profileData.ecrRepositoryName = ecrRepositoryName
        } catch (error) {
            console.log(`⚠️  ECR repository setup failed: ${error.message}`)
        }

        // Step 5: S3 bucket setup
        this._displayProgress('🪣', 'Setting up S3 buckets...')
        try {
            if (nonInteractive && options['skip-s3']) {
                console.log('  ⏭️  Skipping S3 bucket creation (--skip-s3)')
            } else {
                const buckets = await this._setupS3Buckets()
                if (buckets) {
                    if (buckets.asyncS3Bucket) {
                        profileData.asyncS3Bucket = buckets.asyncS3Bucket
                    }
                    if (buckets.batchS3Bucket) {
                        profileData.batchS3Bucket = buckets.batchS3Bucket
                    }
                }
            }
        } catch (error) {
            console.log(`⚠️  S3 bucket setup failed: ${error.message}`)
        }

        // Save profile to config
        this.config.setProfile(profileName, profileData)
        this._displayProgress('✅', `Profile "${profileName}" saved to config`)

        // Display summary
        this._displaySummary(profileName, profileData)
    }

    /**
     * Display active bootstrap profile and resource state.
     */
    async _handleStatus() {
        const config = this.config.read()
        if (!config) {
            console.log('No bootstrap configuration found.')
            console.log('Run `yo @aws/ml-container-creator bootstrap` to set up shared infrastructure.')
            return
        }

        const profile = this.config.getActiveProfile()
        if (!profile) {
            console.log('No active bootstrap profile found.')
            console.log('Run `yo @aws/ml-container-creator bootstrap` to set up shared infrastructure.')
            return
        }

        const allProfiles = this.config.listProfiles()
        console.log(`\n📋 Active Profile: ${profile.name} (${allProfiles.length} profile${allProfiles.length === 1 ? '' : 's'} total)`)
        console.log('─'.repeat(40))

        for (const [key, value] of Object.entries(profile.config)) {
            console.log(`  ${key}: ${value}`)
        }

        console.log('─'.repeat(40))

        // Validate resources still exist
        console.log('\n🔍 Resource Validation:')

        try {
            const roleExists = this._resourceExists(
                'iam get-role --role-name mlcc-sagemaker-execution-role',
                profile.config.awsProfile
            )
            if (roleExists) {
                console.log('  ✅ IAM role: mlcc-sagemaker-execution-role')
            } else {
                console.log('  ⚠️  IAM role: mlcc-sagemaker-execution-role — missing')
            }
        } catch {
            console.log('  ⚠️  IAM role: could not validate (AWS CLI may not be available)')
        }

        try {
            const ecrExists = this._resourceExists(
                `ecr describe-repositories --repository-names ml-container-creator --region ${profile.config.awsRegion}`,
                profile.config.awsProfile
            )
            if (ecrExists) {
                console.log('  ✅ ECR repository: ml-container-creator')
            } else {
                console.log('  ⚠️  ECR repository: ml-container-creator — missing')
            }
        } catch {
            console.log('  ⚠️  ECR repository: could not validate (AWS CLI may not be available)')
        }

        if (profile.config.asyncS3Bucket) {
            try {
                const asyncExists = this._resourceExists(
                    `s3api head-bucket --bucket ${profile.config.asyncS3Bucket}`,
                    profile.config.awsProfile
                )
                if (asyncExists) {
                    console.log(`  ✅ S3 bucket: ${profile.config.asyncS3Bucket}`)
                } else {
                    console.log(`  ⚠️  S3 bucket: ${profile.config.asyncS3Bucket} — missing`)
                }
            } catch {
                console.log(`  ⚠️  S3 bucket: ${profile.config.asyncS3Bucket} — could not validate (AWS CLI may not be available)`)
            }
        }

        if (profile.config.batchS3Bucket) {
            try {
                const batchExists = this._resourceExists(
                    `s3api head-bucket --bucket ${profile.config.batchS3Bucket}`,
                    profile.config.awsProfile
                )
                if (batchExists) {
                    console.log(`  ✅ S3 bucket: ${profile.config.batchS3Bucket}`)
                } else {
                    console.log(`  ⚠️  S3 bucket: ${profile.config.batchS3Bucket} — missing`)
                }
            } catch {
                console.log(`  ⚠️  S3 bucket: ${profile.config.batchS3Bucket} — could not validate (AWS CLI may not be available)`)
            }
        }
    }

    /**
     * Switch the active bootstrap profile.
     * @param {string} profileName - Profile name to activate
     */
    async _handleUse(profileName) {
        if (!profileName) {
            console.log('Usage: yo @aws/ml-container-creator bootstrap use <profile>')
            return
        }

        const profile = this.config.getProfile(profileName)
        if (!profile) {
            const available = this.config.listProfiles()
            console.log(`Profile "${profileName}" not found.`)
            if (available.length > 0) {
                console.log(`Available profiles: ${available.join(', ')}`)
            } else {
                console.log('No profiles configured. Run `yo @aws/ml-container-creator bootstrap` to create one.')
            }
            return
        }

        this.config.setActiveProfile(profileName)
        console.log(`Switched active profile to "${profileName}".`)
    }

    /**
     * List all bootstrap profiles.
     */
    async _handleList() {
        const profiles = this.config.listProfiles()

        if (profiles.length === 0) {
            console.log('No bootstrap profiles configured.')
            console.log('Run `yo @aws/ml-container-creator bootstrap` to set up shared infrastructure.')
            return
        }

        const config = this.config.read()
        const activeProfileName = config ? config.activeProfile : null

        console.log('\nBootstrap Profiles:')
        for (const name of profiles) {
            if (name === activeProfileName) {
                console.log(`  * ${name} (active)`)
            } else {
                console.log(`    ${name}`)
            }
        }
    }

    /**
     * Remove a bootstrap profile.
     * @param {string} profileName - Profile name to remove
     * @param {object} options - Parsed CLI options (e.g., --force)
     */
    async _handleRemove(profileName, options) {
        if (!profileName) {
            console.log('Usage: yo @aws/ml-container-creator bootstrap remove <profile> [--force]')
            return
        }

        const profile = this.config.getProfile(profileName)
        if (!profile) {
            console.log(`Profile "${profileName}" not found.`)
            return
        }

        if (!options.force) {
            const { confirm } = await this.generator.prompt([{
                type: 'confirm',
                name: 'confirm',
                message: `Remove bootstrap profile "${profileName}"?`,
                default: false
            }])

            if (!confirm) {
                console.log('Removal cancelled.')
                return
            }
        }

        this.config.removeProfile(profileName)
        console.log(`Profile "${profileName}" removed.`)
        console.log('Note: AWS resources (IAM role, ECR repository, S3 buckets) were left in place.')
    }

    // ── Provisioning steps ──────────────────────────────────────────

    /**
     * Prompt user to select an AWS profile.
     * @param {object} options - Parsed CLI options
     * @returns {Promise<string>} Selected AWS profile name
     */
    async _selectProfile(options) {
        const profiles = this.profileParser.getProfiles()

        if (profiles.length === 0) {
            console.log('❌ No AWS profiles found. Run `aws configure` first.')
            process.exit(1)
        }

        const defaultProfile = profiles.includes('default') ? 'default' : profiles[0]

        const { awsProfile } = await this.generator.prompt([{
            type: 'list',
            name: 'awsProfile',
            message: 'Select an AWS profile:',
            choices: profiles,
            default: defaultProfile
        }])

        return awsProfile
    }

    /**
     * Validate AWS credentials via STS and extract account ID.
     * @param {string} profile - AWS profile name
     * @param {string} [providedRegion] - Optional region to use (skips prompt when provided)
     * @returns {Promise<object>} Object with accountId and region
     */
    async _validateCredentials(profile, providedRegion) {
        const identity = this._execAws('sts get-caller-identity', profile)
        const accountId = identity.Account

        let region
        if (providedRegion) {
            region = providedRegion
        } else {
            const answer = await this.generator.prompt([{
                type: 'input',
                name: 'region',
                message: 'AWS region for resources:',
                default: 'us-east-1'
            }])
            region = answer.region
        }

        return { accountId, region }
    }

    /**
     * Create or reuse the SageMaker execution IAM role.
     * @param {object} options - Parsed CLI options
     * @returns {Promise<string>} Role ARN
     */
    async _setupIamRole(options) {
        const roleName = 'mlcc-sagemaker-execution-role'

        // Check if role already exists
        const roleExists = this._resourceExists(
            `iam get-role --role-name ${roleName}`,
            this._currentProfile
        )

        if (roleExists) {
            const existingRole = this._execAws(
                `iam get-role --role-name ${roleName}`,
                this._currentProfile
            )
            const roleArn = existingRole.Role.Arn
            console.log(`  ✅ IAM role "${roleName}" already exists — reused`)
            return roleArn
        }

        // Define trust policy for SageMaker
        const trustPolicy = {
            Version: '2012-10-17',
            Statement: [
                {
                    Effect: 'Allow',
                    Principal: {
                        Service: 'sagemaker.amazonaws.com'
                    },
                    Action: 'sts:AssumeRole'
                }
            ]
        }

        // Define execution policy with least-privilege permissions
        const executionPolicy = {
            Version: '2012-10-17',
            Statement: [
                {
                    Sid: 'ECRPull',
                    Effect: 'Allow',
                    Action: [
                        'ecr:GetAuthorizationToken',
                        'ecr:BatchCheckLayerAvailability',
                        'ecr:GetDownloadUrlForLayer',
                        'ecr:BatchGetImage'
                    ],
                    Resource: 'arn:aws:ecr:*:*:repository/ml-container-creator'
                },
                {
                    Sid: 'ECRAuth',
                    Effect: 'Allow',
                    Action: 'ecr:GetAuthorizationToken',
                    Resource: '*'
                },
                {
                    Sid: 'CloudWatchLogs',
                    Effect: 'Allow',
                    Action: [
                        'logs:CreateLogGroup',
                        'logs:CreateLogStream',
                        'logs:PutLogEvents'
                    ],
                    Resource: 'arn:aws:logs:*:*:*'
                },
                {
                    Sid: 'S3ModelRead',
                    Effect: 'Allow',
                    Action: [
                        's3:GetObject',
                        's3:ListBucket'
                    ],
                    Resource: [
                        'arn:aws:s3:::ml-container-creator-*',
                        'arn:aws:s3:::ml-container-creator-*/*'
                    ]
                }
            ]
        }

        // Display policies to user before creation
        console.log('\n  Trust Policy:')
        console.log(JSON.stringify(trustPolicy, null, 2))
        console.log('\n  Execution Policy:')
        console.log(JSON.stringify(executionPolicy, null, 2))
        console.log('')

        try {
            // Create the IAM role
            const createRoleResult = this._execAws(
                `iam create-role --role-name ${roleName} --assume-role-policy-document ${JSON.stringify(JSON.stringify(trustPolicy))}`,
                this._currentProfile
            )
            const roleArn = createRoleResult.Role.Arn

            // Attach inline execution policy
            this._execAws(
                `iam put-role-policy --role-name ${roleName} --policy-name mlcc-execution-policy --policy-document ${JSON.stringify(JSON.stringify(executionPolicy))}`,
                this._currentProfile
            )

            // Apply resource tags
            const tags = this._buildResourceTags()
            this._execAws(
                `iam tag-role --role-name ${roleName} --tags ${this._formatTagsForCli(tags)}`,
                this._currentProfile
            )

            console.log(`  ✅ IAM role "${roleName}" — created`)
            return roleArn
        } catch (error) {
            const errorMessage = error.message || ''
            if (errorMessage.includes('AccessDenied') || errorMessage.includes('UnauthorizedAccess')) {
                console.log('  ⚠️  Permission denied for iam:CreateRole. Please provide an existing role ARN.')
                const { roleArn } = await this.generator.prompt([{
                    type: 'input',
                    name: 'roleArn',
                    message: 'Enter an existing IAM role ARN for SageMaker execution:'
                }])
                return roleArn
            }
            throw error
        }
    }

    /**
     * Create or reuse the ECR repository.
     * @returns {Promise<string>} ECR repository name
     */
    async _setupEcrRepository() {
        const repoName = 'ml-container-creator'

        // Check if repository already exists
        const repoExists = this._resourceExists(
            `ecr describe-repositories --repository-names ${repoName} --region ${this._currentRegion}`,
            this._currentProfile
        )

        if (repoExists) {
            console.log(`  ✅ ECR repository "${repoName}" already exists — reused`)
            return repoName
        }

        // Build resource tags
        const tags = this._buildResourceTags()

        // Create the ECR repository with image scanning and AES256 encryption
        this._execAws(
            `ecr create-repository --repository-name ${repoName} --image-scanning-configuration scanOnPush=true --encryption-configuration encryptionType=AES256 --region ${this._currentRegion} --tags ${this._formatTagsForCli(tags)}`,
            this._currentProfile
        )

        // Apply lifecycle policy to expire untagged images after 30 days
        const lifecyclePolicy = {
            rules: [
                {
                    rulePriority: 1,
                    description: 'Expire untagged images after 30 days',
                    selection: {
                        tagStatus: 'untagged',
                        countType: 'sinceImagePushed',
                        countUnit: 'days',
                        countNumber: 30
                    },
                    action: {
                        type: 'expire'
                    }
                }
            ]
        }

        this._execAws(
            `ecr put-lifecycle-policy --repository-name ${repoName} --lifecycle-policy-text ${JSON.stringify(JSON.stringify(lifecyclePolicy))} --region ${this._currentRegion}`,
            this._currentProfile
        )

        console.log(`  ✅ ECR repository "${repoName}" — created`)
        return repoName
    }

    /**
     * Optionally create S3 buckets for async/batch deployments.
     * @returns {Promise<object|null>} Bucket names or null if skipped
     */
    async _setupS3Buckets() {
        const { useS3 } = await this.generator.prompt([{
            type: 'confirm',
            name: 'useS3',
            message: 'Will you use async inference or batch transform?',
            default: false
        }])

        if (!useS3) {
            return null
        }

        const asyncBucketName = `ml-container-creator-async-${this._currentRegion}-${this._currentAccountId}`
        const batchBucketName = `ml-container-creator-batch-${this._currentRegion}-${this._currentAccountId}`

        const tags = this._buildResourceTags()
        const asyncS3Bucket = await this._createS3Bucket(asyncBucketName, tags)
        const batchS3Bucket = await this._createS3Bucket(batchBucketName, tags)

        return { asyncS3Bucket, batchS3Bucket }
    }

    /**
     * Create or reuse a single S3 bucket with versioning, encryption, and tags.
     * @param {string} bucketName - S3 bucket name
     * @param {Array<{Key: string, Value: string}>} tags - Resource tags
     * @returns {Promise<string>} Bucket name
     */
    async _createS3Bucket(bucketName, tags) {
        // Check if bucket already exists
        const bucketExists = this._resourceExists(
            `s3api head-bucket --bucket ${bucketName}`,
            this._currentProfile
        )

        if (bucketExists) {
            console.log(`  ✅ S3 bucket "${bucketName}" already exists — reused`)
            return bucketName
        }

        // Build create-bucket command with region-appropriate configuration
        let createCommand = `s3api create-bucket --bucket ${bucketName} --region ${this._currentRegion}`
        if (this._currentRegion !== 'us-east-1') {
            createCommand += ` --create-bucket-configuration LocationConstraint=${this._currentRegion}`
        }

        this._execAws(createCommand, this._currentProfile)

        // Enable versioning
        this._execAws(
            `s3api put-bucket-versioning --bucket ${bucketName} --versioning-configuration Status=Enabled`,
            this._currentProfile
        )

        // Enable AES256 server-side encryption
        this._execAws(
            `s3api put-bucket-encryption --bucket ${bucketName} --server-side-encryption-configuration ${JSON.stringify(JSON.stringify({ Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] }))}`,
            this._currentProfile
        )

        // Apply resource tags
        const tagSet = tags.map(tag => `{Key=${tag.Key},Value=${tag.Value}}`).join(',')
        this._execAws(
            `s3api put-bucket-tagging --bucket ${bucketName} --tagging TagSet=[${tagSet}]`,
            this._currentProfile
        )

        console.log(`  ✅ S3 bucket "${bucketName}" — created`)
        return bucketName
    }

    // ── AWS CLI helpers ─────────────────────────────────────────────

    /**
     * Execute an AWS CLI command and return parsed JSON output.
     * @param {string} command - AWS CLI command (without 'aws' prefix)
     * @param {string} profile - AWS profile name
     * @returns {object} Parsed JSON output
     */
    _execAws(command, profile) {
        const fullCommand = `aws ${command} --profile ${profile} --output json`
        const output = execSync(fullCommand, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
        return JSON.parse(output)
    }

    /**
     * Check whether an AWS resource exists by running a check command.
     * @param {string} checkCommand - AWS CLI command to check existence
     * @param {string} profile - AWS profile name
     * @returns {boolean} True if resource exists
     */
    _resourceExists(checkCommand, profile) {
        try {
            this._execAws(checkCommand, profile)
            return true
        } catch {
            return false
        }
    }

    // ── Tag helpers ─────────────────────────────────────────────────

    /**
     * Build the standard resource tag set.
     * @returns {Array<{Key: string, Value: string}>} Tag array
     */
    _buildResourceTags() {
        const packageJsonPath = path.resolve(__dirname, '../../../package.json')
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
        return [
            { Key: 'mlcc:managed-by', Value: 'ml-container-creator' },
            { Key: 'mlcc:created-by', Value: 'bootstrap' },
            { Key: 'mlcc:version', Value: packageJson.version }
        ]
    }

    /**
     * Format tags for the AWS CLI --tags parameter.
     * @param {Array<{Key: string, Value: string}>} tags - Tag array
     * @returns {string} Formatted tags string
     */
    _formatTagsForCli(tags) {
        return tags.map(tag => `Key=${tag.Key},Value=${tag.Value}`).join(' ')
    }

    // ── Display helpers ─────────────────────────────────────────────

    /**
     * Show bootstrap usage help.
     */
    _showHelp() {
        console.log(`
Bootstrap — Shared AWS Infrastructure Setup

USAGE:
  yo @aws/ml-container-creator bootstrap [subcommand] [options]

SUBCOMMANDS:
  (no subcommand)                     Interactive setup (default)
  status                              Show active profile and resource state
  use <profile>                       Switch active bootstrap profile
  list                                List all bootstrap profiles
  remove <profile>                    Remove a bootstrap profile

SETUP OPTIONS:
  --non-interactive                   Run without interactive prompts
  --name <name>                       Bootstrap profile name (default: "default")
  --profile <profile>                 AWS CLI profile to use
  --region <region>                   AWS region for resources
  --role-arn <arn>                    Use existing IAM role ARN (skip role creation)
  --skip-s3                           Skip S3 bucket creation

REMOVE OPTIONS:
  --force                             Skip confirmation prompt

EXAMPLES:
  yo @aws/ml-container-creator bootstrap
  yo @aws/ml-container-creator bootstrap status
  yo @aws/ml-container-creator bootstrap use prod
  yo @aws/ml-container-creator bootstrap list
  yo @aws/ml-container-creator bootstrap remove dev
  yo @aws/ml-container-creator bootstrap remove dev --force
  yo @aws/ml-container-creator bootstrap --non-interactive --profile my-aws-profile --region us-west-2
  yo @aws/ml-container-creator bootstrap --non-interactive --profile my-aws-profile --role-arn arn:aws:iam::123456789012:role/MyRole --skip-s3
`)
    }

    /**
     * Display a summary of the bootstrap profile configuration.
     * @param {string} profileName - Bootstrap profile name
     * @param {object} profileConfig - Profile configuration object
     */
    _displaySummary(profileName, profileConfig) {
        console.log(`\n📋 Bootstrap Profile: ${profileName}`)
        console.log('─'.repeat(40))
        for (const [key, value] of Object.entries(profileConfig)) {
            console.log(`  ${key}: ${value}`)
        }
        console.log('─'.repeat(40))
    }

    /**
     * Display a progress indicator line.
     * @param {string} emoji - Emoji prefix
     * @param {string} message - Progress message
     */
    _displayProgress(emoji, message) {
        console.log(`${emoji} ${message}`)
    }
}
