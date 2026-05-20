import { strict as assert } from 'node:assert';
import DeploymentConfigResolver from '../../src/lib/deployment-config-resolver.js';

describe('DeploymentConfigResolver', () => {
    let resolver;

    beforeEach(() => {
        resolver = new DeploymentConfigResolver();
    });

    describe('getAllConfigs()', () => {
        it('should return exactly 16 valid deployment-config strings', () => {
            const configs = resolver.getAllConfigs();
            assert.equal(configs.length, 16);
        });

        it('should include 2 http, 5 transformers, 7 triton, 1 diffusors, and 1 marketplace configs', () => {
            const configs = resolver.getAllConfigs();
            const http = configs.filter(c => c.startsWith('http-'));
            const transformers = configs.filter(c => c.startsWith('transformers-'));
            const triton = configs.filter(c => c.startsWith('triton-'));
            const diffusors = configs.filter(c => c.startsWith('diffusors-'));
            const marketplace = configs.filter(c => c === 'marketplace');
            assert.equal(http.length, 2);
            assert.equal(transformers.length, 5);
            assert.equal(triton.length, 7);
            assert.equal(diffusors.length, 1);
            assert.equal(marketplace.length, 1);
        });
    });

    describe('decompose()', () => {
        it('should decompose http-flask correctly', () => {
            const result = resolver.decompose('http-flask');
            assert.deepEqual(result, { architecture: 'http', backend: 'flask', engine: null });
        });

        it('should decompose triton-fil correctly', () => {
            const result = resolver.decompose('triton-fil');
            assert.deepEqual(result, { architecture: 'triton', backend: 'fil', engine: null });
        });

        it('should decompose transformers-tensorrt-llm correctly', () => {
            const result = resolver.decompose('transformers-tensorrt-llm');
            assert.deepEqual(result, { architecture: 'transformers', backend: 'tensorrt-llm', engine: null });
        });

        it('should decompose diffusors-vllm-omni correctly', () => {
            const result = resolver.decompose('diffusors-vllm-omni');
            assert.deepEqual(result, { architecture: 'diffusors', backend: 'vllm-omni', engine: null });
        });

        it('should throw for invalid deployment-config', () => {
            assert.throws(
                () => resolver.decompose('sklearn-flask'),
                /Unsupported deployment-config: sklearn-flask/
            );
        });

        it('should return a copy, not a reference to internal data', () => {
            const a = resolver.decompose('http-flask');
            const b = resolver.decompose('http-flask');
            assert.notEqual(a, b);
            assert.deepEqual(a, b);
        });
    });

    describe('compose()', () => {
        it('should compose from architecture and backend', () => {
            assert.equal(
                resolver.compose({ architecture: 'triton', backend: 'fil' }),
                'triton-fil'
            );
        });

        it('should compose transformers-tensorrt-llm', () => {
            assert.equal(
                resolver.compose({ architecture: 'transformers', backend: 'tensorrt-llm' }),
                'transformers-tensorrt-llm'
            );
        });

        it('should compose diffusors-vllm-omni', () => {
            assert.equal(
                resolver.compose({ architecture: 'diffusors', backend: 'vllm-omni' }),
                'diffusors-vllm-omni'
            );
        });
    });

    describe('isValid()', () => {
        it('should return true for all 16 canonical configs', () => {
            for (const dc of resolver.getAllConfigs()) {
                assert.equal(resolver.isValid(dc), true, `Expected ${dc} to be valid`);
            }
        });

        it('should return false for old-format strings', () => {
            const oldFormats = [
                'sklearn-flask', 'sklearn-fastapi',
                'xgboost-flask', 'xgboost-fastapi',
                'tensorflow-flask', 'tensorflow-fastapi'
            ];
            for (const dc of oldFormats) {
                assert.equal(resolver.isValid(dc), false, `Expected ${dc} to be invalid`);
            }
        });

        it('should return false for arbitrary strings', () => {
            assert.equal(resolver.isValid(''), false);
            assert.equal(resolver.isValid('triton-openvino'), false);
            assert.equal(resolver.isValid('foo'), false);
        });
    });

    describe('getConfigsForArchitecture()', () => {
        it('should return 2 configs for http', () => {
            const configs = resolver.getConfigsForArchitecture('http');
            assert.equal(configs.length, 2);
            assert.ok(configs.includes('http-flask'));
            assert.ok(configs.includes('http-fastapi'));
        });

        it('should return 5 configs for transformers', () => {
            const configs = resolver.getConfigsForArchitecture('transformers');
            assert.equal(configs.length, 5);
        });

        it('should return 7 configs for triton', () => {
            const configs = resolver.getConfigsForArchitecture('triton');
            assert.equal(configs.length, 7);
        });

        it('should return empty array for unknown architecture', () => {
            const configs = resolver.getConfigsForArchitecture('unknown');
            assert.equal(configs.length, 0);
        });

        it('should return 1 config for diffusors', () => {
            const configs = resolver.getConfigsForArchitecture('diffusors');
            assert.equal(configs.length, 1);
            assert.ok(configs.includes('diffusors-vllm-omni'));
        });
    });
});
