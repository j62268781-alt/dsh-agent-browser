/**
 * JSX 走全局工厂 `__dshReact.createElement`（esbuild 的 jsxFactory），而不是模块绑定——
 * 模块内的 import 绑定会被打包重命名，全局不会。
 *
 * 每个含 JSX 的模块第一行 `import './react.js'`，保证在任何模块体求值之前全局就已就位。
 */
import React from 'react'

globalThis.__dshReact = React

export default React
