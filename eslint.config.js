'use strict';

module.exports = [
  {
    files: ['src/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { process: 'readonly', console: 'readonly', module: 'writable', require: 'readonly',
        __dirname: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        globalThis: 'readonly', URL: 'readonly', AbortController: 'readonly', Promise: 'readonly' }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error'
    }
  }
];
