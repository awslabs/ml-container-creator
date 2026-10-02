module.exports = {
    env: {
        node: true,
        es2021: true,
        mocha: true
    },
    extends: [
        'eslint:recommended'
    ],
    parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module'
    },
    rules: {
    // Code Quality
        'no-unused-vars': ['error', { 'argsIgnorePattern': '^_' }],
        'no-console': 'off', // CLI tools use console
        'prefer-const': 'error',
        'no-var': 'error',

        // Style
        'indent': ['error', 4],
        'quotes': ['error', 'single'],
        'semi': ['error', 'always'],
        'comma-dangle': ['error', 'never'],

        // Best Practices
        'eqeqeq': 'error',
        'no-eval': 'error',
        'no-implied-eval': 'error',
        'no-new-func': 'error',
        'no-return-assign': 'error',

        // ES6+
        'arrow-spacing': 'error',
        'object-shorthand': 'error',
        'prefer-arrow-callback': 'error',
        'prefer-template': 'error'
    },
    overrides: [
        {
            files: ['test/property/**/*.test.js'],
            plugins: ['property-test-rules'],
            rules: {
                'property-test-rules/no-hardcoded-numruns': 'error'
            }
        },
        {
            // Module-header convention (docs/architecture/module-header-convention.md).
            // WARNING during the consolidation program (Waves 1-8); promoted to
            // 'error' in Wave 9 once every pattern-participating module conforms.
            // Scope expands wave by wave; starts at the shared MCP server libs
            // (Wave 2 factory lands here). Test files are excluded.
            files: ['servers/lib/**/*.js'],
            excludedFiles: ['**/*.test.js'],
            plugins: ['property-test-rules'],
            rules: {
                'property-test-rules/require-module-header': 'warn'
            }
        }
    ],
    ignorePatterns: [
        'node_modules/',
        'templates/**',
        'test/fixtures/**',
        'site/**',
        'drafts/**',
        '*.min.js',
        'test-*.sh'
    ]
};