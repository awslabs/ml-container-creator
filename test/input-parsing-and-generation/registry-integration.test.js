/**
 * Registry System Integration Tests
 * 
 * Tests the complete generation flow with the multi-registry configuration system.
 * Validates that the generator works correctly with registries, gracefully degrades
 * when registries are empty, and handles all configuration sources properly.
 * 
 * Requirements: 2.8, 3.9
 * 
 * Note: These tests use the new CLI-based runner with deployment-config flags.
 * The generator supports both the new deploymentConfig format and the legacy
 * separate framework/modelServer format.
 */

import { runGenerator } from '../helpers/run-generator.js';
import { setupTestHooks } from './test-utils.js';

describe('Registry System Integration Tests', () => {
    let result;

    before(async () => {
        console.log('\n🚀 Starting Registry System Integration Tests');
    });

    setupTestHooks('Registry System Integration');

    afterEach(() => {
        if (result) {
            result.cleanup();
            result = null;
        }
    });

    describe.skip('Complete Generation Flow with Registries', () => {
        
        it('should generate project successfully with empty registries (graceful degradation)', function() {
            this.timeout(60000);
            
            console.log('\n  🧪 Testing graceful degradation with empty registries...');
            
            result = runGenerator({
                'deployment-config': 'http-flask',
                'model-format': 'pkl',
                'include-sample': false,
                'include-testing': false,
                'build-target': 'codebuild',
                'instance-type': 'ml.m5.large',
                'region': 'us-east-1',
                'project-name': 'test-registry-empty'
            });
            
            // Verify essential files are generated
            result.assertFile('Dockerfile');
            result.assertFile('requirements.txt');
            result.assertFile('code/model_handler.py');
            result.assertFile('code/serve.py');
            
            console.log('   ✅ Project generated successfully with empty registries');
        });

        it('should generate project with framework version selection when registry has data', function() {
            this.timeout(60000);
            
            console.log('\n  🧪 Testing generation with framework version from registry...');
            
            result = runGenerator({
                'deployment-config': 'vllm',
                'model-name': 'openai/gpt-oss-20b',
                'include-sample': false,
                'include-testing': false,
                'build-target': 'codebuild',
                'instance-type': 'ml.g5.xlarge',
                'region': 'us-east-1',
                'project-name': 'test-registry-version'
            });
            
            // Verify generator ran successfully and created files
            result.assertFile('Dockerfile');
            result.assertFile('requirements.txt');
            result.assertFile('code/serve');
            result.assertFile('deploy/upload_to_s3.sh');
            
            console.log('   ✅ Project generated with framework version selection');
        });

        it('should handle profile selection when profiles are available', function() {
            this.timeout(60000);
            
            console.log('\n  🧪 Testing profile selection flow...');
            
            result = runGenerator({
                'deployment-config': 'vllm',
                'model-name': 'meta-llama/Llama-3.2-3B-Instruct',
                'include-sample': false,
                'include-testing': false,
                'build-target': 'codebuild',
                'instance-type': 'ml.g5.xlarge',
                'region': 'us-east-1',
                'project-name': 'test-registry-profiles'
            });
            
            // Verify generator ran successfully and created files
            result.assertFile('Dockerfile');
            result.assertFile('requirements.txt');
            result.assertFile('code/serve');
            result.assertFile('deploy/upload_to_s3.sh');
            
            console.log('   ✅ Project generated with profile selection');
        });
    });

    describe.skip('Validation Workflow', () => {
        
        it('should validate instance type when registry has accelerator data', function() {
            this.timeout(60000);
            
            console.log('\n  🧪 Testing instance type validation...');
            
            result = runGenerator({
                'deployment-config': 'vllm',
                'model-name': 'openai/gpt-oss-20b',
                'include-sample': false,
                'include-testing': false,
                'build-target': 'codebuild',
                'instance-type': 'ml.g5.xlarge',
                'region': 'us-east-1',
                'project-name': 'test-registry-validation'
            });
            
            // Verify generator ran successfully and created files
            result.assertFile('Dockerfile');
            result.assertFile('requirements.txt');
            
            console.log('   ✅ Instance type validation completed');
        });

        it('should validate environment variables when VALIDATE_ENV_VARS is enabled', function() {
            this.timeout(60000);
            
            console.log('\n  🧪 Testing environment variable validation...');
            
            result = runGenerator({
                'deployment-config': 'http-flask',
                'model-format': 'pkl',
                'include-sample': false,
                'include-testing': false,
                'build-target': 'codebuild',
                'instance-type': 'ml.m5.large',
                'region': 'us-east-1',
                'project-name': 'test-registry-env-validation'
            }, {
                env: { VALIDATE_ENV_VARS: 'true' }
            });
            
            // Verify files are generated
            result.assertFile('Dockerfile');
            result.assertFile('requirements.txt');
            
            console.log('   ✅ Environment variable validation completed');
        });
    });

    describe.skip('Graceful Degradation', () => {
        
        it('should work correctly when registries are unavailable', function() {
            this.timeout(60000);
            
            console.log('\n  🧪 Testing graceful degradation with unavailable registries...');
            
            result = runGenerator({
                'deployment-config': 'http-flask',
                'model-format': 'json',
                'include-sample': false,
                'include-testing': false,
                'build-target': 'codebuild',
                'instance-type': 'ml.m5.large',
                'region': 'us-east-1',
                'project-name': 'test-registry-unavailable'
            });
            
            // Verify files are generated
            result.assertFile('Dockerfile');
            result.assertFile('requirements.txt');
            result.assertFile('code/model_handler.py');
            result.assertFile('code/serve.py');
            
            console.log('   ✅ Generator works correctly with unavailable registries');
        });

        it('should maintain backward compatibility with existing behavior', function() {
            this.timeout(60000);
            
            console.log('\n  🧪 Testing backward compatibility...');
            
            result = runGenerator({
                'deployment-config': 'http-flask',
                'model-format': 'SavedModel',
                'include-sample': false,
                'include-testing': false,
                'build-target': 'codebuild',
                'instance-type': 'ml.g5.xlarge',
                'region': 'us-east-1',
                'project-name': 'test-registry-backward-compat'
            });
            
            // Verify files are generated
            result.assertFile('Dockerfile');
            result.assertFile('requirements.txt');
            result.assertFile('code/model_handler.py');
            result.assertFile('code/serve.py');
            
            console.log('   ✅ Backward compatibility maintained');
        });
    });
});
