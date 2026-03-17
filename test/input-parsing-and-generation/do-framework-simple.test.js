// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DO Framework - Simplified Tests
 * 
 * Simple tests that verify do-framework templates exist and have correct content.
 * No generator runs - just template validation.
 */

import { describe, it } from 'mocha';
import assert from 'assert';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('DO Framework - Simplified Tests', () => {
    const templatesDir = path.join(__dirname, '../../generators/app/templates');
    
    describe('Template Files Exist', () => {
        it('should have all do script templates', () => {
            const requiredScripts = [
                'do/build',
                'do/push',
                'do/deploy',
                'do/run',
                'do/test',
                'do/clean',
                'do/submit',
                'do/config',
                'do/README.md'
            ];
            
            requiredScripts.forEach(script => {
                const scriptPath = path.join(templatesDir, script);
                assert.ok(
                    existsSync(scriptPath),
                    `Template ${script} should exist`
                );
            });
        });
        
        it('should have legacy wrapper scripts', () => {
            const legacyScripts = [
                'deploy/build_and_push.sh',
                'deploy/deploy.sh',
                'deploy/submit_build.sh'
            ];
            
            legacyScripts.forEach(script => {
                const scriptPath = path.join(templatesDir, script);
                assert.ok(
                    existsSync(scriptPath),
                    `Legacy script ${script} should exist`
                );
            });
        });
    });
    
    describe('Script Content Validation', () => {
        it('should have shebang in all do scripts', () => {
            const scripts = ['do/build', 'do/push', 'do/deploy', 'do/run', 'do/test', 'do/clean', 'do/submit'];
            
            scripts.forEach(script => {
                const content = readFileSync(path.join(templatesDir, script), 'utf8');
                assert.ok(
                    content.startsWith('#!/bin/bash') || content.startsWith('#!/usr/bin/env bash'),
                    `${script} should have bash shebang`
                );
            });
        });
        
        it('should have set -e in all do scripts', () => {
            const scripts = ['do/build', 'do/push', 'do/deploy', 'do/run', 'do/test', 'do/clean', 'do/submit'];
            
            scripts.forEach(script => {
                const content = readFileSync(path.join(templatesDir, script), 'utf8');
                assert.ok(
                    content.includes('set -e'),
                    `${script} should have 'set -e' for error handling`
                );
            });
        });
        
        it('should source config in operational scripts', () => {
            const scripts = ['do/build', 'do/push', 'do/deploy', 'do/run', 'do/test', 'do/clean'];
            
            scripts.forEach(script => {
                const content = readFileSync(path.join(templatesDir, script), 'utf8');
                assert.ok(
                    content.includes('source') && content.includes('config'),
                    `${script} should source config file`
                );
            });
        });
        
        it('should have DEPRECATED warning in legacy scripts', () => {
            const legacyScripts = ['deploy/build_and_push.sh', 'deploy/deploy.sh'];
            
            legacyScripts.forEach(script => {
                const content = readFileSync(path.join(templatesDir, script), 'utf8');
                assert.ok(
                    content.includes('DEPRECATED') || content.includes('deprecated'),
                    `${script} should have deprecation warning`
                );
            });
        });
    });
    
    describe('Config Template', () => {
        it('should have required variable exports', () => {
            const configPath = path.join(templatesDir, 'do/config');
            const content = readFileSync(configPath, 'utf8');
            
            const requiredVars = [
                'PROJECT_NAME',
                'DEPLOYMENT_CONFIG',
                'FRAMEWORK',
                'MODEL_SERVER',
                'AWS_REGION',
                'BUILD_TARGET',
                'DEPLOYMENT_TARGET'
            ];
            
            requiredVars.forEach(varName => {
                assert.ok(
                    content.includes(`export ${varName}=`) || content.includes(`${varName}=`),
                    `Config should export ${varName}`
                );
            });
        });
        
        it('should use EJS template variables', () => {
            const configPath = path.join(templatesDir, 'do/config');
            const content = readFileSync(configPath, 'utf8');
            
            assert.ok(content.includes('<%'), 'Config should use EJS templates');
            assert.ok(content.includes('%>'), 'Config should use EJS templates');
        });
    });
    
    describe('Generator Integration', () => {
        it('should have _setExecutablePermissions method', () => {
            const generatorPath = path.join(__dirname, '../../generators/app/index.js');
            const content = readFileSync(generatorPath, 'utf8');
            
            assert.ok(
                content.includes('_setExecutablePermissions'),
                'Generator should have _setExecutablePermissions method'
            );
            
            // Check that it includes do scripts
            assert.ok(
                content.includes('do/build') || content.includes('\'do/'),
                '_setExecutablePermissions should reference do scripts'
            );
        });
    });
});
