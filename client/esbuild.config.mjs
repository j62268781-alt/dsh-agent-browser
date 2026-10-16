/**
 * 客户端（browser half）打包。
 *
 * DSH 的 ModuleLoader 每个客户端包只求值一个文件，所以 `client/**` 被压成
 * `lib/client.js`，并用 banner/footer 包成它要的那一个交接形状：
 *
 *   window.__ModuleLoader__.load({ id: <包名>, factory: (require) => { … return module.exports } });
 *
 * `react` 与 `@deepseek-ai/*` 保持外部依赖：它们由宿主的模块表提供，打进包里会拿到
 * 第二份 React（hooks 立刻失效）。JSX 用全局工厂 `__dshReact.createElement`，
 * 由 client/react.js 在模块体求值前挂到全局。
 */
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

const PKG = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

await build({
  entryPoints: ['client/index.jsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react', 'react/*', '@deepseek-ai/*'],
  jsx: 'transform',
  jsxFactory: '__dshReact.createElement',
  jsxFragment: '__dshReact.Fragment',
  loader: { '.jsx': 'jsx', '.css': 'text' },
  banner: {
    js: [
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG.name)}, factory: (require) => {`,
      'var module = { exports: {} }; var exports = module.exports;',
    ].join('\n'),
  },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'info',
})
