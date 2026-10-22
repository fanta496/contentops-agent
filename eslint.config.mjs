// ESLint 扁平配置：项目当前是零依赖，这份配置先放着，装了 eslint 就能直接跑。
// 用法：
//   npm i -D eslint
//   npx eslint .
// 重点规则是 no-undef —— 它能抓出「调用了没注入的函数」这类拆分事故，
// 也是这几轮复审反复出现的同一类 bug。
export default [
  {
    files: ['**/*.cjs', '**/*.js'],
    ignores: ['.git/**', 'launcher/**', 'node_modules/**'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        structuredClone: 'readonly',
        AbortSignal: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly'
      }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none' }],
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error'
    }
  },
  {
    // 浏览器内注入的脚本片段：这些标识符由页面提供
    files: ['collector/**/*.cjs'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        location: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
        performance: 'readonly',
        HTMLElement: 'readonly',
        MutationObserver: 'readonly',
        getComputedStyle: 'readonly',
        requestAnimationFrame: 'readonly'
      }
    }
  }
];
