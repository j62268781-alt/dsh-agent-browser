/**
 * **手写的 Remote contribution**：让设置页（客户端半）能调用 host 半的
 * `ctx.browser.probe(deep)` —— 安装自检。
 *
 * 为什么能手写：DSH 的 Gateway 有**运行期 SRC fallback** —— host 侧只要用
 * `TypertRemoteService` + `@Remote` 暴露方法，Gateway 就会在调用时扫 `typertRemote` 绑定
 * 与装饰器 marker 现推 descriptor。所以本插件**不需要** typert/tsdown 代码生成管线。
 *
 * ⚠️ **两个必须遵守的约束**（都来自 Gateway 的实现，破坏它们是静默失效）：
 *
 * 1. **`wire` 必须逐字等于 host 方法的形参名**（host 半不能被压缩/改名）。
 * 2. **实参个数必须与 `parameters.length` 相等**：`probe(deep)` 必须显式传一个布尔，
 *    不能省——否则客户端会抛 `expected 1 argument(s), got 0`。
 *
 * 另外实测行为：返回的是**信封**（`{ok:true,value}` / `{ok:false,error}`，resolve 不 reject）。
 * 参照 dsh-judgment 的同款通路（`client/judgment-remote.js`）。
 */

const PACKAGE = '@j62268781-alt/dsh-agent-browser'
const SERVICE = 'browser'

/** 名义 strict codec：客户端只校验 `mode`，不会调用 `create()`（纯为过闸）。 */
function codec(typeSymbol) {
  return { mode: 'strict', typeSymbol, create: () => ({ parse: (value) => value }) }
}

/** 一条方法的 descriptor。`wire` 见文件头第 1 条约束。 */
function descriptor(method, parameters) {
  const endpoint = `${SERVICE}/${method}`
  return {
    id: `${PACKAGE}#${endpoint}`,
    service: SERVICE,
    namespace: SERVICE,
    method,
    invocation: { kind: 'direct' },
    parameters: parameters.map((name) => ({
      name,
      wire: name,
      source: 'json',
      codec: codec(`${PACKAGE}#${endpoint}:${name}`),
    })),
    // 结果原样透传（`ProbeResult` 全是 JSON 值）。
    result: { mode: 'src-json' },
  }
}

export function browserContribution() {
  return {
    package: PACKAGE,
    descriptors: [
      // host: probe() —— 安装自检：**零实参**，客户端一个都不能多传
      descriptor('probe', []),
      // host: install(target) —— 帮忙装 CLI（'cli'）；wire 名必须等于形参名
      descriptor('installCli', ['target']),
      // host: checkJudgment() —— 「决策」的依赖检查（零实参）：dsh-judgment 的 ctx.judgment 在不在
      descriptor('checkJudgment', []),
    ],
  }
}
