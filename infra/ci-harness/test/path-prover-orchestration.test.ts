// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test: Path Prover Orchestration
 *
 * Tests the state machine execution with mocked brain/write-results responses.
 * Verifies:
 * - Loop/termination logic (PickNext → Brain → End)
 * - Failure routing to classification
 * - Tune branch conditional execution
 * - Budget controls (MAX_PROVES_PER_RUN, MAX_COST_PER_RUN)
 *
 * Requirements: 8.1, 8.7, 8.8
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Use require() for lambda modules since mocha+ts-node uses dynamic import() which
// triggers ESM resolution. require() via ts-node transpiles to CommonJS correctly.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: brainHandler } = require('../lambda/path-prover/brain')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: writeResultsHandler } = require('../lambda/path-prover/write-results')

// Load and parse the ASL definition
const aslPath = join(__dirname, '..', 'state-machines', 'path-prover.asl.json')
const aslDefinition = JSON.parse(readFileSync(aslPath, 'utf-8'))

describe('Path Prover Orchestration', () => {

    describe('ASL Definition Structure', () => {
        it('has all required states', () => {
            const requiredStates = [
                'Brain', 'CheckBrainDone', 'PrepareStageInput',
                'GenerateBuildPush', 'DeployTest', 'CheckTune',
                'TuneAdapterTest', 'Benchmark', 'WriteResults',
                'Clean', 'PickNext', 'CheckDone', 'ClassifyFailure',
                'WriteFailureRecord', 'CleanAfterFailure',
                'PickNextAfterFailure', 'UpdateIterationState', 'End'
            ]

            for (const state of requiredStates) {
                assert.ok(
                    aslDefinition.States[state],
                    `Missing required state: ${state}`
                )
            }
        })

        it('starts at Brain state', () => {
            assert.equal(aslDefinition.StartAt, 'Brain')
        })

        it('Brain state invokes Lambda', () => {
            assert.equal(aslDefinition.States.Brain.Type, 'Task')
            assert.equal(aslDefinition.States.Brain.Resource, '${BrainFunctionArn}')
        })

        it('GenerateBuildPush uses CodeBuild .sync integration', () => {
            assert.equal(
                aslDefinition.States.GenerateBuildPush.Resource,
                'arn:aws:states:::codebuild:startBuild.sync'
            )
        })

        it('DeployTest uses CodeBuild .sync integration', () => {
            assert.equal(
                aslDefinition.States.DeployTest.Resource,
                'arn:aws:states:::codebuild:startBuild.sync'
            )
        })

        it('CheckTune is a Choice state', () => {
            assert.equal(aslDefinition.States.CheckTune.Type, 'Choice')
        })

        it('CheckTune routes to TuneAdapterTest when tuneRequested is true', () => {
            const tuneChoice = aslDefinition.States.CheckTune.Choices[0]
            assert.equal(tuneChoice.Variable, '$.tuneRequested')
            assert.equal(tuneChoice.BooleanEquals, true)
            assert.equal(tuneChoice.Next, 'TuneAdapterTest')
        })

        it('CheckTune default routes to Benchmark (skip tune)', () => {
            assert.equal(aslDefinition.States.CheckTune.Default, 'Benchmark')
        })

        it('Benchmark uses CodeBuild .sync integration', () => {
            assert.equal(
                aslDefinition.States.Benchmark.Resource,
                'arn:aws:states:::codebuild:startBuild.sync'
            )
        })

        it('WriteResults invokes Lambda', () => {
            assert.equal(aslDefinition.States.WriteResults.Type, 'Task')
            assert.equal(aslDefinition.States.WriteResults.Resource, '${WriteResultsFunctionArn}')
        })

        it('PickNext invokes Brain Lambda', () => {
            assert.equal(aslDefinition.States.PickNext.Type, 'Task')
            assert.equal(aslDefinition.States.PickNext.Resource, '${BrainFunctionArn}')
        })

        it('CheckDone is a Choice state routing to End or UpdateIterationState', () => {
            const state = aslDefinition.States.CheckDone
            assert.equal(state.Type, 'Choice')
            assert.equal(state.Choices[0].Next, 'End')
            assert.equal(state.Default, 'UpdateIterationState')
        })

        it('UpdateIterationState loops back to CheckBrainDone', () => {
            assert.equal(aslDefinition.States.UpdateIterationState.Next, 'CheckBrainDone')
        })

        it('End state is Succeed type', () => {
            assert.equal(aslDefinition.States.End.Type, 'Succeed')
        })

        it('all CodeBuild stages pass PATH_PROVER_MODE=true', () => {
            const codeBuildStates = [
                'GenerateBuildPush', 'DeployTest', 'TuneAdapterTest',
                'Benchmark', 'Clean', 'CleanAfterFailure'
            ]

            for (const stateName of codeBuildStates) {
                const state = aslDefinition.States[stateName]
                const envVars = state.Parameters.EnvironmentVariablesOverride
                const pathProverVar = envVars.find(
                    (v: { Name: string }) => v.Name === 'PATH_PROVER_MODE'
                )
                assert.ok(
                    pathProverVar,
                    `${stateName} missing PATH_PROVER_MODE env var`
                )
                assert.equal(
                    pathProverVar.Value, 'true',
                    `${stateName} PATH_PROVER_MODE should be 'true'`
                )
            }
        })

        it('all CodeBuild stages have retry policies', () => {
            const codeBuildStates = [
                'GenerateBuildPush', 'DeployTest', 'TuneAdapterTest',
                'Benchmark', 'Clean', 'CleanAfterFailure'
            ]

            for (const stateName of codeBuildStates) {
                const state = aslDefinition.States[stateName]
                assert.ok(
                    state.Retry && state.Retry.length > 0,
                    `${stateName} missing Retry policy`
                )
                // Max 1 retry for retryable failures (except Clean which gets 2)
                const maxAttempts = state.Retry[0].MaxAttempts
                assert.ok(
                    maxAttempts <= 2,
                    `${stateName} MaxAttempts should be <= 2, got ${maxAttempts}`
                )
            }
        })

        it('failure states route to ClassifyFailure', () => {
            const statesWithCatch = [
                'Brain', 'GenerateBuildPush', 'DeployTest',
                'TuneAdapterTest', 'Benchmark', 'WriteResults'
            ]

            for (const stateName of statesWithCatch) {
                const state = aslDefinition.States[stateName]
                assert.ok(state.Catch, `${stateName} missing Catch`)
                const catchTarget = state.Catch[0].Next
                assert.equal(
                    catchTarget, 'ClassifyFailure',
                    `${stateName} Catch should route to ClassifyFailure, got ${catchTarget}`
                )
            }
        })

        it('ClassifyFailure routes to WriteFailureRecord', () => {
            assert.equal(aslDefinition.States.ClassifyFailure.Next, 'WriteFailureRecord')
        })

        it('WriteFailureRecord routes to CleanAfterFailure', () => {
            assert.equal(aslDefinition.States.WriteFailureRecord.Next, 'CleanAfterFailure')
        })

        it('CleanAfterFailure routes to PickNextAfterFailure', () => {
            assert.equal(aslDefinition.States.CleanAfterFailure.Next, 'PickNextAfterFailure')
        })
    })

    describe('Brain Lambda - Loop/Termination Logic', () => {
        it('returns done=true when no configs to prove (empty previousResults)', async () => {
            const result = await brainHandler({
                action: 'getNextConfig',
                iteration: 0,
                budgetSpent: 0,
                maxProvesPerRun: 10,
                maxCostPerRun: 100,
                previousResults: []
            })

            assert.equal(result.done, true)
            assert.equal(result.reason, 'all_gaps_filled')
        })

        it('returns next config when previousResults has items', async () => {
            const configs = [
                {
                    deployment_config: 'transformers-vllm',
                    model_family: 'qwen3',
                    instance_family: 'g5',
                    quantization: 'none',
                    tp_degree: '1',
                    deployment_target: 'realtime-inference'
                }
            ]

            const result = await brainHandler({
                action: 'getNextConfig',
                iteration: 0,
                budgetSpent: 0,
                maxProvesPerRun: 10,
                maxCostPerRun: 100,
                previousResults: configs
            })

            assert.equal(result.done, false)
            assert.ok(result.next)
            assert.equal(result.next!.deployment_config, 'transformers-vllm')
        })

        it('returns done=true when max_proves_reached', async () => {
            const result = await brainHandler({
                action: 'getNextConfig',
                iteration: 10,
                budgetSpent: 50,
                maxProvesPerRun: 10,
                maxCostPerRun: 100,
                previousResults: [{ deployment_config: 'vllm' }]
            })

            assert.equal(result.done, true)
            assert.equal(result.reason, 'max_proves_reached')
        })

        it('returns done=true when budget_exceeded', async () => {
            const result = await brainHandler({
                action: 'getNextConfig',
                iteration: 3,
                budgetSpent: 100,
                maxProvesPerRun: 10,
                maxCostPerRun: 100,
                previousResults: [{ deployment_config: 'vllm' }]
            })

            assert.equal(result.done, true)
            assert.equal(result.reason, 'budget_exceeded')
        })

        it('pickNext returns done=true after max proves', async () => {
            const result = await brainHandler({
                action: 'pickNext',
                iteration: 10,
                budgetSpent: 50,
                maxProvesPerRun: 10,
                maxCostPerRun: 100,
                previousResults: [
                    { deployment_config: 'vllm' },
                    { deployment_config: 'sglang' },
                    { deployment_config: 'trt' },
                    { deployment_config: 'lmi' },
                    { deployment_config: 'flask' },
                    { deployment_config: 'fastapi' },
                    { deployment_config: 'triton' },
                    { deployment_config: 'djl' },
                    { deployment_config: 'onnx' },
                    { deployment_config: 'python' },
                    { deployment_config: 'extra' }
                ],
                currentConfig: { deployment_config: 'vllm' },
                lastResult: 'success'
            })

            assert.equal(result.done, true)
            assert.equal(result.reason, 'max_proves_reached')
        })

        it('pickNext returns done=true when budget would be exceeded by next prove', async () => {
            const result = await brainHandler({
                action: 'pickNext',
                iteration: 0,
                budgetSpent: 99,
                maxProvesPerRun: 10,
                maxCostPerRun: 100,
                previousResults: [
                    { deployment_config: 'vllm', instance_family: 'g5' },
                    { deployment_config: 'sglang', instance_family: 'g5' },
                    { deployment_config: 'trt', instance_family: 'g5' }
                ],
                currentConfig: { deployment_config: 'vllm' },
                lastResult: 'success'
            })

            assert.equal(result.done, true)
            assert.equal(result.reason, 'budget_exceeded')
        })

        it('pickNext returns next config when budget allows', async () => {
            const result = await brainHandler({
                action: 'pickNext',
                iteration: 0,
                budgetSpent: 0,
                maxProvesPerRun: 10,
                maxCostPerRun: 100,
                previousResults: [
                    { deployment_config: 'vllm', instance_family: 'g5' },
                    { deployment_config: 'sglang', instance_family: 'g5' }
                ],
                currentConfig: { deployment_config: 'vllm' },
                lastResult: 'success'
            })

            assert.equal(result.done, false)
            assert.ok(result.next)
        })

        it('pickNext returns done=true when all configs exhausted', async () => {
            const result = await brainHandler({
                action: 'pickNext',
                iteration: 1,
                budgetSpent: 2,
                maxProvesPerRun: 10,
                maxCostPerRun: 100,
                previousResults: [
                    { deployment_config: 'vllm', instance_family: 'g5' }
                ],
                currentConfig: { deployment_config: 'vllm' },
                lastResult: 'success'
            })

            assert.equal(result.done, true)
            assert.equal(result.reason, 'all_gaps_filled')
        })
    })

    describe('Brain Lambda - Tune Stage Gating', () => {
        it('sets tuneRequested=false when no tuning requested', async () => {
            const result = await brainHandler({
                action: 'getNextConfig',
                iteration: 0,
                budgetSpent: 0,
                maxProvesPerRun: 10,
                maxCostPerRun: 100,
                previousResults: [
                    {
                        deployment_config: 'transformers-vllm',
                        model_family: 'qwen3',
                        instance_family: 'g5',
                        enable_lora: false
                    }
                ]
            })

            assert.equal(result.done, false)
            assert.equal(result.tuneRequested, false)
        })

        it('sets tuneRequested=true when enable_lora=true', async () => {
            const result = await brainHandler({
                action: 'getNextConfig',
                iteration: 0,
                budgetSpent: 0,
                maxProvesPerRun: 10,
                maxCostPerRun: 100,
                previousResults: [
                    {
                        deployment_config: 'transformers-vllm',
                        model_family: 'qwen3',
                        instance_family: 'g5',
                        enable_lora: true
                    }
                ]
            })

            assert.equal(result.done, false)
            assert.equal(result.tuneRequested, true)
        })

        it('sets tuneRequested=true when include_tuning=true', async () => {
            const result = await brainHandler({
                action: 'getNextConfig',
                iteration: 0,
                budgetSpent: 0,
                maxProvesPerRun: 10,
                maxCostPerRun: 100,
                previousResults: [
                    {
                        deployment_config: 'transformers-vllm',
                        model_family: 'qwen3',
                        instance_family: 'g5',
                        include_tuning: true
                    }
                ]
            })

            assert.equal(result.done, false)
            assert.equal(result.tuneRequested, true)
        })

        it('sets tuneRequested=true when tune_technique is specified', async () => {
            const result = await brainHandler({
                action: 'getNextConfig',
                iteration: 0,
                budgetSpent: 0,
                maxProvesPerRun: 10,
                maxCostPerRun: 100,
                previousResults: [
                    {
                        deployment_config: 'transformers-vllm',
                        model_family: 'qwen3',
                        instance_family: 'g5',
                        tune_technique: 'sft'
                    }
                ]
            })

            assert.equal(result.done, false)
            assert.equal(result.tuneRequested, true)
        })
    })

    describe('Brain Lambda - Failure Classification', () => {
        it('classifies InsufficientInstanceCapacity as capacity (retryable)', async () => {
            const result = await brainHandler({
                action: 'classifyFailure',
                error: {
                    Cause: 'InsufficientInstanceCapacity: Unable to provision ml.g5.xlarge'
                }
            })

            assert.equal(result.category, 'capacity')
            assert.equal(result.retryable, true)
            assert.equal(result.stage, 'unknown')
        })

        it('classifies timeout errors as timeout (retryable)', async () => {
            const result = await brainHandler({
                action: 'classifyFailure',
                error: {
                    Cause: 'Deploy endpoint timed out after 1200 seconds'
                }
            })

            assert.equal(result.category, 'timeout')
            assert.equal(result.retryable, true)
            assert.equal(result.stage, 'deploy')
        })

        it('classifies OOM as oom (non-retryable)', async () => {
            const result = await brainHandler({
                action: 'classifyFailure',
                error: {
                    Cause: 'CUDA out of memory when loading model'
                }
            })

            assert.equal(result.category, 'oom')
            assert.equal(result.retryable, false)
        })

        it('classifies template errors as code_bug (non-retryable)', async () => {
            const result = await brainHandler({
                action: 'classifyFailure',
                error: {
                    Cause: 'Template rendering error in generate stage: SyntaxError in serve.ejs'
                }
            })

            assert.equal(result.category, 'code_bug')
            assert.equal(result.retryable, false)
            assert.equal(result.stage, 'generate')
        })

        it('classifies model incompatibility (non-retryable)', async () => {
            const result = await brainHandler({
                action: 'classifyFailure',
                error: {
                    Cause: 'LoRA not supported for this model architecture'
                }
            })

            assert.equal(result.category, 'model_incompatibility')
            assert.equal(result.retryable, false)
        })

        it('classifies service limitations (non-retryable)', async () => {
            const result = await brainHandler({
                action: 'classifyFailure',
                error: {
                    Cause: 'Feature not available in region us-west-1'
                }
            })

            assert.equal(result.category, 'service_limitation')
            assert.equal(result.retryable, false)
        })

        it('defaults unrecognized errors to code_bug', async () => {
            const result = await brainHandler({
                action: 'classifyFailure',
                error: {
                    Cause: 'Something completely unexpected happened'
                }
            })

            assert.equal(result.category, 'code_bug')
            assert.equal(result.retryable, false)
        })

        it('handles null error gracefully', async () => {
            const result = await brainHandler({
                action: 'classifyFailure',
                error: undefined
            })

            assert.equal(result.category, 'code_bug')
            assert.equal(result.retryable, false)
            assert.equal(result.stage, 'unknown')
        })
    })

    describe('Write Results Lambda', () => {
        it('writes successful result with status=completed and run_type=path_prove', async () => {
            const result = await writeResultsHandler({
                action: 'writeResults',
                config: {
                    config_id: 'test-config-123',
                    deployment_config: 'transformers-vllm',
                    model_family: 'qwen3',
                    instance_family: 'g5'
                },
                benchmarkResult: {},
                runType: 'path_prove'
            })

            assert.equal(result.success, true)
            assert.equal(result.status, 'completed')
            assert.ok(result.recordId)
        })

        it('writes failure record with status=unfeasible for non-retryable', async () => {
            const result = await writeResultsHandler({
                action: 'writeFailure',
                config: {
                    config_id: 'test-config-456',
                    deployment_config: 'transformers-vllm',
                    model_family: 'qwen3'
                },
                error: { Cause: 'OOM during model loading' },
                classification: {
                    stage: 'deploy',
                    category: 'oom',
                    retryable: false
                },
                runType: 'path_prove'
            })

            assert.equal(result.success, true)
            assert.equal(result.status, 'unfeasible')
        })

        it('writes failure record with status=failed for retryable', async () => {
            const result = await writeResultsHandler({
                action: 'writeFailure',
                config: {
                    config_id: 'test-config-789',
                    deployment_config: 'transformers-vllm'
                },
                error: { Cause: 'InsufficientInstanceCapacity' },
                classification: {
                    stage: 'deploy',
                    category: 'capacity',
                    retryable: true
                },
                runType: 'path_prove'
            })

            assert.equal(result.success, true)
            assert.equal(result.status, 'failed')
        })
    })

    describe('Budget Controls', () => {
        it('respects custom MAX_PROVES_PER_RUN from execution input', async () => {
            const result = await brainHandler({
                action: 'getNextConfig',
                iteration: 3,
                budgetSpent: 0,
                maxProvesPerRun: 3,
                maxCostPerRun: 100,
                previousResults: [{ deployment_config: 'vllm' }]
            })

            assert.equal(result.done, true)
            assert.equal(result.reason, 'max_proves_reached')
        })

        it('respects custom MAX_COST_PER_RUN from execution input', async () => {
            const result = await brainHandler({
                action: 'getNextConfig',
                iteration: 0,
                budgetSpent: 50,
                maxProvesPerRun: 10,
                maxCostPerRun: 50,
                previousResults: [{ deployment_config: 'vllm' }]
            })

            assert.equal(result.done, true)
            assert.equal(result.reason, 'budget_exceeded')
        })

        it('estimates cost based on instance_family', async () => {
            // g5 family costs ~$1.21/hr × 1.5hr/prove = ~$1.82
            // With budget of $5 and starting at $4, the next prove ($1.82) would exceed
            const result = await brainHandler({
                action: 'pickNext',
                iteration: 0,
                budgetSpent: 4,
                maxProvesPerRun: 10,
                maxCostPerRun: 5,
                previousResults: [
                    { deployment_config: 'vllm', instance_family: 'g5' },
                    { deployment_config: 'sglang', instance_family: 'g5' }
                ],
                currentConfig: { deployment_config: 'vllm', instance_family: 'g5' },
                lastResult: 'success'
            })

            assert.equal(result.done, true)
            assert.equal(result.reason, 'budget_exceeded')
        })

        it('uses default budget values when not provided', async () => {
            // defaults: maxProvesPerRun=10, maxCostPerRun=100
            const result = await brainHandler({
                action: 'getNextConfig',
                previousResults: [
                    { deployment_config: 'vllm', instance_family: 'g5' }
                ]
            })

            // Should proceed (iteration=0, budget=0)
            assert.equal(result.done, false)
        })
    })

    describe('End-to-End State Transition Flow', () => {
        it('simulates a full successful prove cycle', async () => {
            // Step 1: Brain returns first config
            const brainResult = await brainHandler({
                action: 'getNextConfig',
                iteration: 0,
                budgetSpent: 0,
                maxProvesPerRun: 10,
                maxCostPerRun: 100,
                previousResults: [
                    {
                        deployment_config: 'transformers-vllm',
                        model_family: 'qwen3',
                        instance_family: 'g5',
                        quantization: 'none',
                        tp_degree: '1',
                        deployment_target: 'realtime-inference'
                    }
                ]
            })

            assert.equal(brainResult.done, false)
            assert.ok(brainResult.next)

            // Step 2: After successful stages, WriteResults
            const writeResult = await writeResultsHandler({
                action: 'writeResults',
                config: brainResult.next,
                benchmarkResult: { throughput_rps: 45.2 },
                runType: 'path_prove'
            })

            assert.equal(writeResult.success, true)
            assert.equal(writeResult.status, 'completed')

            // Step 3: PickNext decides if more work
            const pickNextResult = await brainHandler({
                action: 'pickNext',
                iteration: (brainResult as any).iteration ?? 1,
                budgetSpent: (brainResult as any).budgetSpent ?? 2,
                maxProvesPerRun: 10,
                maxCostPerRun: 100,
                previousResults: [
                    {
                        deployment_config: 'transformers-vllm',
                        model_family: 'qwen3',
                        instance_family: 'g5',
                        quantization: 'none',
                        tp_degree: '1',
                        deployment_target: 'realtime-inference'
                    }
                ],
                currentConfig: brainResult.next,
                lastResult: 'success'
            })

            // Only 1 config in list, so done
            assert.equal(pickNextResult.done, true)
            assert.equal(pickNextResult.reason, 'all_gaps_filled')
        })

        it('simulates a failure → classify → write failure → pick next flow', async () => {
            // Step 1: Brain returns config
            const brainResult = await brainHandler({
                action: 'getNextConfig',
                iteration: 0,
                budgetSpent: 0,
                maxProvesPerRun: 10,
                maxCostPerRun: 100,
                previousResults: [
                    {
                        deployment_config: 'transformers-vllm',
                        model_family: 'qwen3',
                        instance_family: 'g5'
                    },
                    {
                        deployment_config: 'transformers-sglang',
                        model_family: 'qwen3',
                        instance_family: 'g5'
                    }
                ]
            })

            assert.equal(brainResult.done, false)

            // Step 2: Failure occurs, classify it
            const classifyResult = await brainHandler({
                action: 'classifyFailure',
                error: {
                    Cause: 'CUDA out of memory during deploy — model too large for instance'
                },
                config: brainResult.next
            })

            assert.equal(classifyResult.category, 'oom')
            assert.equal(classifyResult.retryable, false)

            // Step 3: Write failure record
            const writeResult = await writeResultsHandler({
                action: 'writeFailure',
                config: brainResult.next,
                error: { Cause: 'CUDA out of memory' },
                classification: classifyResult as any,
                runType: 'path_prove'
            })

            assert.equal(writeResult.success, true)
            assert.equal(writeResult.status, 'unfeasible')

            // Step 4: PickNextAfterFailure decides to continue
            const pickNextResult = await brainHandler({
                action: 'pickNext',
                iteration: (brainResult as any).iteration ?? 1,
                budgetSpent: (brainResult as any).budgetSpent ?? 2,
                maxProvesPerRun: 10,
                maxCostPerRun: 100,
                previousResults: [
                    {
                        deployment_config: 'transformers-vllm',
                        model_family: 'qwen3',
                        instance_family: 'g5'
                    },
                    {
                        deployment_config: 'transformers-sglang',
                        model_family: 'qwen3',
                        instance_family: 'g5'
                    }
                ],
                currentConfig: brainResult.next,
                lastResult: 'failure',
                classification: classifyResult as any
            })

            // Should move to next config
            assert.equal(pickNextResult.done, false)
            assert.ok(pickNextResult.next)
        })
    })
})
