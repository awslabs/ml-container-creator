// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Property-Based Testing Configuration
 * 
 * Global configuration for property-based tests using fast-check.
 * This file sets up the testing environment and provides utilities
 * for running property tests consistently.
 */

import fc from 'fast-check';

// Global property test configuration
export const GLOBAL_PROPERTY_CONFIG = {
    // Test execution settings
    numRuns: 100,           // Minimum 100 iterations as specified in design
    timeout: 30000,         // 30 second timeout per property test
    verbose: true,          // Show detailed output
    seed: 42,               // For reproducible tests
    
    // Error handling
    maxSkipsPerRun: 100,    // Maximum skips before failing
    interruptAfterTimeLimit: 25000, // Interrupt after 25 seconds
    
    // Shrinking configuration
    maxShrinks: 1000,       // Maximum shrinking attempts
    
    // Async configuration
    asyncTimeout: 30000,    // Timeout for async properties
    
    // Reporting
    reporter: (runDetails) => {
        if (runDetails.failed) {
            console.log(`\n❌ Property test failed after ${runDetails.numRuns} runs`);
            console.log(`🔍 Counterexample: ${JSON.stringify(runDetails.counterexample, null, 2)}`);
            if (runDetails.error) {
                console.log(`💥 Error: ${runDetails.error.message}`);
            }
        } else {
            console.log(`✅ Property test passed after ${runDetails.numRuns} runs`);
        }
    }
};

// Configure fast-check globally
fc.configureGlobal({
    ...GLOBAL_PROPERTY_CONFIG
});

/**
 * Wrapper for running property tests with consistent configuration
 */
export function runPropertyTest(property, options = {}) {
    const config = {
        ...GLOBAL_PROPERTY_CONFIG,
        ...options
    };
    
    return fc.assert(property, config);
}

/**
 * Wrapper for async property tests
 */
export function runAsyncPropertyTest(property, options = {}) {
    const config = {
        ...GLOBAL_PROPERTY_CONFIG,
        ...options
    };
    
    return fc.assert(property, config);
}

/**
 * Property test utilities
 */
export const PropertyTestUtils = {
    // Create a test that should always pass (for testing the framework)
    alwaysPass: () => fc.property(fc.anything(), () => true),
    
    // Create a test that should always fail (for testing error handling)
    alwaysFail: () => fc.property(fc.anything(), () => false),
    
    // Skip a test conditionally
    skipIf: (condition, property) => {
        if (condition) {
            return fc.property(fc.anything(), () => {
                fc.pre(false); // Skip this test
                return true;
            });
        }
        return property;
    },
    
    // Log property test progress
    logProgress: (testName, iteration, total) => {
        if (iteration % 10 === 0 || iteration === total) {
            console.log(`    📊 ${testName}: ${iteration}/${total} iterations completed`);
        }
    }
};

/**
 * Property test hooks for Mocha integration
 */
export function setupPropertyTestHooks() {
    // Set longer timeout for property tests
    beforeEach(function() {
        this.timeout(GLOBAL_PROPERTY_CONFIG.timeout);
    });
    
    // Clean up after each test
    afterEach(() => {
        // Reset any global state if needed
    });
}

/**
 * Property test reporting utilities
 */
export const PropertyTestReporter = {
    // Report property test results
    reportResults: (testName, results) => {
        console.log(`\n📊 Property Test Results: ${testName}`);
        console.log(`   Runs: ${results.numRuns}`);
        console.log(`   Passed: ${!results.failed}`);
        
        if (results.failed) {
            console.log(`   Failed at run: ${results.numRunsBeforeFailure}`);
            console.log(`   Counterexample: ${JSON.stringify(results.counterexample)}`);
        }
        
        if (results.numSkips > 0) {
            console.log(`   Skips: ${results.numSkips}`);
        }
    },
    
    // Report test suite summary
    reportSummary: (suiteName, testResults) => {
        const totalTests = testResults.length;
        const passedTests = testResults.filter(r => !r.failed).length;
        const failedTests = totalTests - passedTests;
        
        console.log(`\n📈 Property Test Suite Summary: ${suiteName}`);
        console.log(`   Total Tests: ${totalTests}`);
        console.log(`   Passed: ${passedTests}`);
        console.log(`   Failed: ${failedTests}`);
        console.log(`   Success Rate: ${((passedTests / totalTests) * 100).toFixed(1)}%`);
    }
};

export default {
    GLOBAL_PROPERTY_CONFIG,
    runPropertyTest,
    runAsyncPropertyTest,
    PropertyTestUtils,
    setupPropertyTestHooks,
    PropertyTestReporter
};