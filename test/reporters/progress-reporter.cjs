// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Progress Bar Reporter
 * 
 * Shows a progress bar with minimal output
 * No dependencies - uses Mocha's built-in Base reporter
 */

const Mocha = require('mocha');
const { reporters } = Mocha;
const { Base } = reporters;

class ProgressReporter extends Base {
    constructor(runner, options) {
        super(runner, options);
        
        let passes = 0;
        let failures = 0;
        let pending = 0;
        let totalTests = 0;
        let completedTests = 0;
        const failedTests = [];
        
        // Detect if output is being piped (not a TTY)
        const isTTY = process.stdout.isTTY;
        
        // Count total tests
        runner.on('suite', (suite) => {
            totalTests += suite.tests.length;
        });
        
        runner.on('start', () => {
            console.log('\nRunning tests...\n');
        });
        
        runner.on('pass', (test) => {
            completedTests++;
            passes++;
            this.updateProgress(completedTests, totalTests, passes, failures, pending, isTTY);
        });
        
        runner.on('fail', (test, err) => {
            completedTests++;
            failures++;
            
            failedTests.push({
                title: test.fullTitle(),
                error: err.message,
                stack: err.stack
            });
            
            this.updateProgress(completedTests, totalTests, passes, failures, pending, isTTY);
        });
        
        runner.on('pending', (test) => {
            completedTests++;
            pending++;
            this.updateProgress(completedTests, totalTests, passes, failures, pending, isTTY);
        });
        
        runner.on('end', () => {
            console.log('\n');
            console.log('─'.repeat(80));
            
            const duration = runner.stats.duration;
            const seconds = (duration / 1000).toFixed(2);
            
            console.log(`✓ ${passes} passing  ✗ ${failures} failing  ○ ${pending} pending`);
            console.log(`Completed ${totalTests} tests in ${seconds}s`);
            
            if (failedTests.length > 0) {
                console.log(`\n${  '─'.repeat(80)}`);
                console.log('Failed Tests:\n');
                
                failedTests.forEach((test, index) => {
                    console.log(`${index + 1}. ${test.title}`);
                    console.log(`   ${test.error}\n`);
                });
                
                if (process.env.SHOW_STACK) {
                    console.log('Stack Traces:\n');
                    failedTests.forEach((test, index) => {
                        console.log(`${index + 1}. ${test.title}`);
                        console.log(test.stack);
                        console.log('');
                    });
                }
            }
            
            console.log('');
        });
    }
    
    updateProgress(current, total, passes, failures, pending, isTTY) {
        if (isTTY) {
            // Interactive mode: use progress bar with carriage returns
            // Clear line and move cursor to start
            process.stdout.write('\r\x1b[K');
            
            const percentage = Math.floor((current / total) * 100);
            const barLength = 40;
            const filled = Math.floor((current / total) * barLength);
            const empty = barLength - filled;
            
            // Color codes
            const green = '\x1b[32m';
            const red = '\x1b[31m';
            const yellow = '\x1b[33m';
            const reset = '\x1b[0m';
            
            const bar = '█'.repeat(filled) + '░'.repeat(empty);
            
            const status = `[${bar}] ${percentage}% | ` +
                          `${green}✓ ${passes}${reset} ` +
                          `${red}✗ ${failures}${reset} ` +
                          `${yellow}○ ${pending}${reset} ` +
                          `(${current}/${total})`;
            
            process.stdout.write(status);
        } else {
            // Non-interactive mode (piped): print periodic updates
            // Only print every 10% or on completion
            const percentage = Math.floor((current / total) * 100);
            const prevPercentage = Math.floor(((current - 1) / total) * 100);
            
            if (percentage % 10 === 0 && percentage !== prevPercentage) {
                console.log(`Progress: ${percentage}% (${current}/${total}) - ✓ ${passes} ✗ ${failures} ○ ${pending}`);
            }
        }
    }
}

module.exports = ProgressReporter;
