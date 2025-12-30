#!/bin/bash

# ML Container Creator Test Runner
# Provides different levels of test output verbosity

echo "🧪 ML Container Creator Test Runner"
echo

case "${1:-all}" in
    "quick")
        echo "🚀 Running quick test (dot reporter)..."
        npx mocha test/*.test.js --reporter dot --timeout 30000
        ;;
    "verbose")
        echo "📋 Running verbose test (spec reporter with details)..."
        npx mocha test/*.test.js --reporter spec --timeout 30000
        ;;
    "debug")
        echo "🔍 Running debug test (spec reporter with stack traces)..."
        npx mocha test/*.test.js --reporter spec --timeout 30000 --full-trace
        ;;
    "watch")
        echo "👀 Running in watch mode..."
        npx mocha test/*.test.js --reporter spec --timeout 30000 --watch
        ;;
    "single")
        if [ -z "$2" ]; then
            echo "❌ Please provide a test pattern"
            echo "Usage: ./scripts/test.sh single 'test pattern'"
            exit 1
        fi
        echo "🎯 Running single test: $2"
        npx mocha test/*.test.js --reporter spec --timeout 30000 --grep "$2"
        ;;
    "framework")
        if [ -z "$2" ]; then
            echo "❌ Please provide a framework name"
            echo "Usage: ./scripts/test.sh framework sklearn"
            exit 1
        fi
        echo "🔧 Running tests for framework: $2"
        npx mocha test/*.test.js --reporter spec --timeout 30000 --grep "$2"
        ;;
    "all"|*)
        echo "📊 Running all tests (default)..."
        npm test
        ;;
esac

echo
echo "📖 Available commands:"
echo "  ./scripts/test.sh quick     - Fast test with minimal output"
echo "  ./scripts/test.sh verbose   - Detailed test output"
echo "  ./scripts/test.sh debug     - Full debug output with stack traces"
echo "  ./scripts/test.sh watch     - Watch mode for development"
echo "  ./scripts/test.sh single 'pattern' - Run specific test"
echo "  ./scripts/test.sh framework sklearn - Run framework-specific tests"
echo "  ./scripts/test.sh all       - Run all tests (default)"