// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test Performance Monitoring
 * 
 * Tracks slow tests and reports performance metrics.
 * Can be imported into test files to add performance tracking.
 */

const slowTests = [];
let SLOW_TEST_THRESHOLD = 1000; // 1 second

/**
 * Setup performance monitoring hooks for a test suite
 * Call this in your describe block to enable monitoring
 */
export function setupPerformanceMonitoring() {
    beforeEach(function() {
        this.testStartTime = Date.now();
    });

    afterEach(function() {
        const duration = Date.now() - this.testStartTime;
        
        if (duration > SLOW_TEST_THRESHOLD) {
            slowTests.push({
                name: this.currentTest.fullTitle(),
                duration,
                file: this.currentTest.file
            });
        }
    });

    after(() => {
        if (slowTests.length > 0) {
            console.log(`\n⚠️  Slow Tests Detected (>${  SLOW_TEST_THRESHOLD  }ms):`);
            slowTests
                .sort((a, b) => b.duration - a.duration)
                .slice(0, 10)
                .forEach(test => {
                    console.log(`   ${test.duration}ms - ${test.name}`);
                });
            console.log('');
        }
    });
}

/**
 * Get all slow tests recorded so far
 */
export function getSlowTests() {
    return [...slowTests];
}

/**
 * Clear slow test records
 */
export function clearSlowTests() {
    slowTests.length = 0;
}

/**
 * Set custom threshold for slow tests
 */
export function setSlowTestThreshold(threshold) {
    SLOW_TEST_THRESHOLD = threshold;
}

/**
 * Generate performance report
 */
export function generatePerformanceReport() {
    const totalTests = slowTests.length;
    
    if (totalTests === 0) {
        return 'No slow tests detected. All tests completed quickly!';
    }
    
    const totalDuration = slowTests.reduce((sum, test) => sum + test.duration, 0);
    const avgDuration = totalDuration / totalTests;
    const slowest = slowTests.sort((a, b) => b.duration - a.duration)[0];
    
    return {
        totalSlowTests: totalTests,
        totalDuration: `${totalDuration}ms`,
        averageDuration: `${Math.round(avgDuration)}ms`,
        slowestTest: {
            name: slowest.name,
            duration: `${slowest.duration}ms`
        },
        top10: slowTests.slice(0, 10).map(test => ({
            name: test.name,
            duration: `${test.duration}ms`
        }))
    };
}

export default {
    setupPerformanceMonitoring,
    getSlowTests,
    clearSlowTests,
    setSlowTestThreshold,
    generatePerformanceReport
};
