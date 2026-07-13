import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/reports/**',
    ],
  },
  js.configs.recommended,
  // Backend (Node.js, ES Modules)
  {
    files: ['backend/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      eqeqeq: 'error',
      'no-unreachable': 'error',
      'prefer-const': 'error',
    },
  },
  // Backend tests (vitest globals)
  {
    files: ['backend/test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  // Frontend (React, browser)
  {
    files: ['frontend/**/*.{js,jsx}'],
    ...react.configs.flat.recommended,
    plugins: {
      ...react.configs.flat.recommended.plugins,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      ...react.configs.flat.recommended.languageOptions,
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
      },
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      eqeqeq: 'error',
      'no-unreachable': 'error',
      'prefer-const': 'error',
    },
  },
  // Frontend tests (vitest + Testing Library, node-like + browser globals)
  {
    files: ['frontend/**/*.test.{js,jsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
];
