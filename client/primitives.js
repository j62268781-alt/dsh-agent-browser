/**
 * DSH 官方 UI primitives（`Switch` / `Button` …）。
 *
 * **必须用宿主的模块表（同步 `require`），不能用原生 `import()`**：DSH 把一个客户端包的
 * 外部依赖通过 `window.__ModuleLoader__.load({ factory: (require) => … })` 的 `require`
 * 暴露出来，浏览器里没有裸包名的 import map，`await import('@deepseek-ai/…')` 会直接失败。
 *
 * 取不到就返回 null，页面退回原生控件——拿不到官方组件不该让设置页不可用。
 */
export const primitives = (() => {
  try {
    return require('@deepseek-ai/dsh-client-ui-primitives')
  } catch {
    return null
  }
})()
