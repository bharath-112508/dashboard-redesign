import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierPlugin from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

export default [
    {
        ignores: ['dist', 'node_modules', 'coverage'],
    },
    {
        // Verbatim ports of PDF templates + Playwright renderer, kept byte-identical
        // for PDF fidelity. Their double-quote / 2-space style intentionally differs
        // from this repo's Prettier config (single-quote, 4-space); reformatting
        // reflows whitespace inside HTML template literals and breaks output.
        // Do not lint or `--fix` these files — edit source-of-truth upstream instead.
        ignores: [
            'src/services/payroll/payslip-template.ts',
            'src/services/payroll/letter-template.ts',
            'src/services/payroll/offer-letter-template.ts',
            'src/services/payroll/pdf.service.ts',
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    prettierConfig,
    {
        files: ['**/*.ts'],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                ecmaVersion: 'latest',
                sourceType: 'module',
            },
        },
        plugins: {
            prettier: prettierPlugin,
        },
        rules: {
            'prettier/prettier': 'error',
            semi: ['error', 'always'],
            quotes: ['error', 'single', { avoidEscape: true }],
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
        },
    },
];
