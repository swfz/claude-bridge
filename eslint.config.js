import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import eslintConfigPrettier from 'eslint-config-prettier';

const noUnusedVarsRule = ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }];

export default [
  {
    ignores: ['client/dist/**', 'node_modules/**', 'client/node_modules/**', 'samples/**'],
  },
  js.configs.recommended,
  {
    files: ['server/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'e2e/**/*.js', 'playwright.config.js'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': noUnusedVarsRule,
    },
  },
  {
    files: ['client/vite.config.js'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': noUnusedVarsRule,
    },
  },
  {
    files: ['client/src/**/*.{js,jsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      // Note: eslint-plugin-react-hooks@7 の `recommended` は eslint 10 系でのみ
      // 動作するが、React Compiler 向けの多数のルール（refs/purity/immutability 等）を
      // 含み、既存コードの書き換え（挙動変更）を要求するため意図的に採用しない。
      // 従来どおり rules-of-hooks / exhaustive-deps の2つだけを有効化する。
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-unused-vars': noUnusedVarsRule,
    },
  },
  eslintConfigPrettier,
];
