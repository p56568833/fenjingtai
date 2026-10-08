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
  /* 分层规则（低耦合）：core 是纯数据规则，不碰状态 / 界面 / 原生；app 管状态与数据操作，不碰界面；
     platform 只包原生能力。上层可以用下层，下层不能反过来依赖上层。 */
  {
    files: ['renderer/src/core/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['../app/*', '../ui/*', '../features/*', '../platform/*'], message: 'core/ 只能依赖 core/' }] },
      ],
      'no-restricted-globals': ['error', 'document', 'window', 'localStorage'],
    },
  },
  {
    files: ['renderer/src/app/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['../ui/*', '../features/*'], message: 'app/ 不能依赖界面层（改用事件 / notify）' }] },
      ],
      'no-restricted-globals': ['error', 'document'],
    },
  },
  {
    files: ['renderer/src/platform/**/*.js'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['../*'], message: 'platform/ 不依赖任何业务模块' }] }],
    },
  },
  {
    files: ['renderer/src/ui/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['../features/*'], message: 'ui/ 不直接依赖功能模块（用 commands.js 的命令）' }] },
      ],
    },
  },
  {
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
