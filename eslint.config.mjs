/* ESLint（扁平配置）：只开「真错误」类规则，风格交给 Prettier。用法：npm run lint */
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'dist/**', '备份-*/**', '分镜台.html', '分章行缝交互-demo.html'] },
  js.configs.recommended,
  {
    files: ['renderer/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    files: ['renderer/src/theme-boot.js'],
    languageOptions: { sourceType: 'script' },
  },
  {
    files: ['electron/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    // 测试脚本里 page.evaluate 的回调在浏览器里跑，所以两套全局都认
    files: ['scripts/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
  },
  {
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
