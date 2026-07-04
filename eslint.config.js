import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import nodePlugin from 'eslint-plugin-n';
import perfectionist from 'eslint-plugin-perfectionist';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import promise from 'eslint-plugin-promise';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    ignores: ['node_modules', 'dist/**', 'build', 'coverage', '**/.act/**'],
  },
  {
    extends: [
      js.configs['recommended'],
      nodePlugin.configs['flat/recommended-module'],
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
      stylistic.configs.customize({
        indent: 2,
        quotes: 'single',
        semi: true,
        jsx: false,
      }),
      promise.configs['flat/recommended'],
      prettierRecommended,
      perfectionist.configs['recommended-natural'],
      eslintConfigPrettier,
    ],
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.node,
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      'n/no-missing-import': 'off', // resolved by TS
      'n/no-unpublished-import': 'off', // dev-only imports in tests
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      'promise/always-return': ['error', { ignoreLastCallback: true }],
      curly: 'error',
      'func-style': ['error', 'declaration'],
      'no-else-return': 'error',
      'perfectionist/sort-imports': [
        'error',
        {
          groups: [
            ['value-builtin', 'value-external'],
            'type-internal',
            'value-internal',
            ['type-parent', 'type-sibling', 'type-index'],
            ['value-parent', 'value-sibling', 'value-index'],
            'ts-equals-import',
            'unknown',
          ],
          environment: 'node',
        },
      ],
      'perfectionist/sort-objects': 'off',
      'perfectionist/sort-modules': 'off', // keep logical (not alphabetical) declaration order
    },
  },
]);
