// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Accelerator Validators Tests
 * 
 * Consolidated tests for accelerator type and version validation.
 * 
 * Feature: transformer-server-env-config
 * 
 * Consolidates:
 * - accelerator-validators.test.js
 */

import { setupTestHooks } from './test-utils.js';
import assert from 'assert';
import CudaValidator from '../../src/lib/cuda-validator.js';
import NeuronValidator from '../../src/lib/neuron-validator.js';
import CpuValidator from '../../src/lib/cpu-validator.js';
import RocmValidator from '../../src/lib/rocm-validator.js';

describe('Accelerator Validators', () => {
    let validators;

    before(() => {
        validators = {
            cuda: new CudaValidator(),
            neuron: new NeuronValidator(),
            cpu: new CpuValidator(),
            rocm: new RocmValidator()
        };
    });

    setupTestHooks('Accelerator Validators');

    describe('CUDA Validator', () => {
        it('should validate compatible CUDA versions (same major, equal minor)', () => {
            const frameworkConfig = {
                accelerator: {
                    type: 'cuda',
                    version: '12.1'
                }
            };
            
            const instanceConfig = {
                accelerator: {
                    type: 'cuda',
                    versions: ['12.1', '12.2']
                }
            };
            
            const result = validators.cuda.validate(frameworkConfig, instanceConfig);
            
            assert.strictEqual(result.compatible, true, 'CUDA 12.1 should be compatible with 12.1');
            assert(result.info, 'Should have info message');
            assert(result.info.includes('12.1'), 'Info should mention version');
        });

        it('should validate compatible CUDA versions (same major, higher minor)', () => {
            const frameworkConfig = {
                accelerator: {
                    type: 'cuda',
                    version: '12.1'
                }
            };
            
            const instanceConfig = {
                accelerator: {
                    type: 'cuda',
                    versions: ['12.2', '12.3']
                }
            };
            
            const result = validators.cuda.validate(frameworkConfig, instanceConfig);
            
            assert.strictEqual(result.compatible, true, 'CUDA 12.2 should be compatible with required 12.1');
            assert(result.info, 'Should have info message');
        });

        it('should reject incompatible CUDA versions (different major)', () => {
            const frameworkConfig = {
                accelerator: {
                    type: 'cuda',
                    version: '12.1'
                }
            };
            
            const instanceConfig = {
                accelerator: {
                    type: 'cuda',
                    versions: ['11.8', '11.9']
                }
            };
            
            const result = validators.cuda.validate(frameworkConfig, instanceConfig);
            
            assert.strictEqual(result.compatible, false, 'CUDA 11.x should not be compatible with required 12.1');
            assert(result.error, 'Should have error message');
            assert(result.error.includes('12.1'), 'Error should mention required version');
            assert(result.error.includes('11.8'), 'Error should mention provided version');
        });

        it('should reject incompatible CUDA versions (same major, lower minor)', () => {
            const frameworkConfig = {
                accelerator: {
                    type: 'cuda',
                    version: '12.2'
                }
            };
            
            const instanceConfig = {
                accelerator: {
                    type: 'cuda',
                    versions: ['12.1', '12.0']
                }
            };
            
            const result = validators.cuda.validate(frameworkConfig, instanceConfig);
            
            assert.strictEqual(result.compatible, false, 'CUDA 12.1 should not be compatible with required 12.2');
            assert(result.error, 'Should have error message');
        });

        it('should generate user-friendly error messages', () => {
            const message = validators.cuda.getVersionMismatchMessage('12.1', ['11.8', '11.9']);
            
            assert(message.includes('12.1'), 'Message should include required version');
            assert(message.includes('11.8'), 'Message should include provided versions');
            assert(message.includes('ml.g5') || message.includes('ml.g6'), 
                'Message should suggest compatible instance types');
        });
    });

    describe('Neuron SDK Validator', () => {
        it('should validate compatible Neuron SDK versions (same major, equal minor)', () => {
            const frameworkConfig = {
                accelerator: {
                    type: 'neuron',
                    version: '2.15.0'
                }
            };
            
            const instanceConfig = {
                accelerator: {
                    type: 'neuron',
                    versions: ['2.15.0', '2.16.0']
                }
            };
            
            const result = validators.neuron.validate(frameworkConfig, instanceConfig);
            
            assert.strictEqual(result.compatible, true, 'Neuron SDK 2.15.0 should be compatible with 2.15.0');
            assert(result.info, 'Should have info message');
            assert(result.info.includes('2.15.0'), 'Info should mention version');
        });

        it('should validate compatible Neuron SDK versions (same major, higher minor)', () => {
            const frameworkConfig = {
                accelerator: {
                    type: 'neuron',
                    version: '2.15.0'
                }
            };
            
            const instanceConfig = {
                accelerator: {
                    type: 'neuron',
                    versions: ['2.16.0', '2.17.0']
                }
            };
            
            const result = validators.neuron.validate(frameworkConfig, instanceConfig);
            
            assert.strictEqual(result.compatible, true, 'Neuron SDK 2.16.0 should be compatible with required 2.15.0');
            assert(result.info, 'Should have info message');
        });

        it('should reject incompatible Neuron SDK versions (different major)', () => {
            const frameworkConfig = {
                accelerator: {
                    type: 'neuron',
                    version: '2.15.0'
                }
            };
            
            const instanceConfig = {
                accelerator: {
                    type: 'neuron',
                    versions: ['1.19.0', '1.20.0']
                }
            };
            
            const result = validators.neuron.validate(frameworkConfig, instanceConfig);
            
            assert.strictEqual(result.compatible, false, 'Neuron SDK 1.x should not be compatible with required 2.15.0');
            assert(result.error, 'Should have error message');
            assert(result.error.includes('2.15.0'), 'Error should mention required version');
        });

        it('should reject incompatible Neuron SDK versions (same major, lower minor)', () => {
            const frameworkConfig = {
                accelerator: {
                    type: 'neuron',
                    version: '2.16.0'
                }
            };
            
            const instanceConfig = {
                accelerator: {
                    type: 'neuron',
                    versions: ['2.15.0', '2.14.0']
                }
            };
            
            const result = validators.neuron.validate(frameworkConfig, instanceConfig);
            
            assert.strictEqual(result.compatible, false, 'Neuron SDK 2.15.0 should not be compatible with required 2.16.0');
            assert(result.error, 'Should have error message');
        });

        it('should generate user-friendly error messages', () => {
            const message = validators.neuron.getVersionMismatchMessage('2.16.0', ['2.15.0', '2.14.0']);
            
            assert(message.includes('2.16.0'), 'Message should include required version');
            assert(message.includes('2.15.0'), 'Message should include provided versions');
            assert(message.includes('ml.inf2'), 'Message should suggest compatible instance types');
        });
    });

    describe('CPU Validator', () => {
        it('should always validate CPU as compatible', () => {
            const frameworkConfig = {
                accelerator: {
                    type: 'cpu',
                    version: 'any'
                }
            };
            
            const instanceConfig = {
                accelerator: {
                    type: 'cpu',
                    versions: ['any']
                }
            };
            
            const result = validators.cpu.validate(frameworkConfig, instanceConfig);
            
            assert.strictEqual(result.compatible, true, 'CPU should always be compatible');
            assert(result.info, 'Should have info message');
            assert(result.info.includes('CPU'), 'Info should mention CPU');
        });

        it('should return empty string for version mismatch message', () => {
            const message = validators.cpu.getVersionMismatchMessage('any', ['any']);
            
            assert.strictEqual(message, '', 'CPU should return empty string for version mismatch');
        });
    });

    describe('ROCm Validator', () => {
        it('should validate compatible ROCm versions (same major, equal minor)', () => {
            const frameworkConfig = {
                accelerator: {
                    type: 'rocm',
                    version: '5.4.0'
                }
            };
            
            const instanceConfig = {
                accelerator: {
                    type: 'rocm',
                    versions: ['5.4.0', '5.5.0']
                }
            };
            
            const result = validators.rocm.validate(frameworkConfig, instanceConfig);
            
            assert.strictEqual(result.compatible, true, 'ROCm 5.4.0 should be compatible with 5.4.0');
            assert(result.info, 'Should have info message');
            assert(result.info.includes('5.4.0'), 'Info should mention version');
        });

        it('should validate compatible ROCm versions (same major, higher minor)', () => {
            const frameworkConfig = {
                accelerator: {
                    type: 'rocm',
                    version: '5.4.0'
                }
            };
            
            const instanceConfig = {
                accelerator: {
                    type: 'rocm',
                    versions: ['5.5.0', '5.6.0']
                }
            };
            
            const result = validators.rocm.validate(frameworkConfig, instanceConfig);
            
            assert.strictEqual(result.compatible, true, 'ROCm 5.5.0 should be compatible with required 5.4.0');
            assert(result.info, 'Should have info message');
        });

        it('should reject incompatible ROCm versions (different major)', () => {
            const frameworkConfig = {
                accelerator: {
                    type: 'rocm',
                    version: '5.4.0'
                }
            };
            
            const instanceConfig = {
                accelerator: {
                    type: 'rocm',
                    versions: ['4.5.0', '4.6.0']
                }
            };
            
            const result = validators.rocm.validate(frameworkConfig, instanceConfig);
            
            assert.strictEqual(result.compatible, false, 'ROCm 4.x should not be compatible with required 5.4.0');
            assert(result.error, 'Should have error message');
            assert(result.error.includes('5.4.0'), 'Error should mention required version');
        });

        it('should reject incompatible ROCm versions (same major, lower minor)', () => {
            const frameworkConfig = {
                accelerator: {
                    type: 'rocm',
                    version: '5.5.0'
                }
            };
            
            const instanceConfig = {
                accelerator: {
                    type: 'rocm',
                    versions: ['5.4.0', '5.3.0']
                }
            };
            
            const result = validators.rocm.validate(frameworkConfig, instanceConfig);
            
            assert.strictEqual(result.compatible, false, 'ROCm 5.4.0 should not be compatible with required 5.5.0');
            assert(result.error, 'Should have error message');
        });

        it('should generate user-friendly error messages', () => {
            const message = validators.rocm.getVersionMismatchMessage('5.5.0', ['5.4.0', '5.3.0']);
            
            assert(message.includes('5.5.0'), 'Message should include required version');
            assert(message.includes('5.4.0'), 'Message should include provided versions');
            assert(message.includes('AMD GPU') || message.includes('ROCm'), 
                'Message should mention AMD GPU or ROCm');
        });
    });
});
