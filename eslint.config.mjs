import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import next from 'eslint-config-next/core-web-vitals';

const config = [
  { ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/generated/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...next,
  { rules: { '@typescript-eslint/no-explicit-any': 'error', '@next/next/no-html-link-for-pages': 'off' }, settings: { react: { version: '19' } } },
];
export default config;
