import js from '@eslint/js';
import importX from 'eslint-plugin-import-x';
import perfectionist from 'eslint-plugin-perfectionist';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import promise from 'eslint-plugin-promise';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [
      js.configs['recommended'],
      importX.flatConfigs.recommended,
      importX.flatConfigs.typescript,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
      promise.configs['flat/recommended'],
      prettierRecommended,
      perfectionist.configs['recommended-natural'],
    ],
    files: ['src/*.{ts,tsx}', 'env.ts', 'vite.config.ts'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      'import-x/order': 'off',
      'import-x/no-dynamic-require': 'warn',
      'import-x/no-nodejs-modules': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      curly: 'error',
      'func-style': ['error', 'declaration'],
      'no-else-return': 'error',
      'perfectionist/sort-imports': [
        'error',
        {
          groups: [
            'react',
            ['builtin', 'external'],
            'internal-type',
            'internal',
            ['parent-type', 'sibling-type', 'index-type'],
            ['parent', 'sibling', 'index'],
            'type',
            'object',
            'unknown',
          ],
          customGroups: {
            type: {
              react: ['^react$', '^react-.+'],
            },
            value: {
              react: ['^react$', '^react-.+'],
            },
          },
          environment: 'node',
        },
      ],
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
  },
);
