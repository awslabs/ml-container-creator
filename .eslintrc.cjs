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
        'no-console': 'off', // Yeoman generators use console
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
    ignorePatterns: [
        'node_modules/',
        'generators/app/templates/**',
        'test/fixtures/**',
        'site/**',
        'drafts/**',
        '*.min.js',
        'test-*.sh'
    ]
};