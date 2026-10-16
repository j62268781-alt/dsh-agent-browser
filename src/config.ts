/**
 * 配置（schemastery）。**开关是普通字段而不是 `.volatile()`**：
 * 「浏览器功能」与「决策」要能**改变工具注册**，而注册发生在 entry 应用时——
 * 配置一写，loader 重新应用 entry，工具随之注册/撤销。这与 `dsh-tool-web` 的
 * `search`/`fetch` 是同一范式（`apply()` 里按解析后的值决定注册哪些工具）。
 *
 * 运行期每次调用都现读的值（域名白名单、超时）也放在这里：重新应用一次是廉价的。
 */

import s from '@deepseek-ai/schemastery'

/** 域名或 `*.域名`；空数组 = 不限制（CLI 的 `--allowed-domains` 语义）。 */
const DOMAIN = /^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/

/** `10s` / `3m` / `1h` / 裸毫秒；空 = 用 CLI 默认（1h）。 */
const IDLE_TIMEOUT = /^(?:$|\d+(?:ms|s|m|h)?)$/

const SESSION_NAME = /^[A-Za-z0-9._-]*$/

export const Config = s.object({
  /**
   * 浏览器功能总开关。关闭时**不注册任何工具**——模型面前零成本，也不启动任何会话。
   */
  enabled: s.boolean().default(true),

  browser: s.object({
    /** `--headed`：给人看 / 手工登录时打开。 */
    headed: s.boolean().default(false),
    /**
     * `--allowed-domains`：网络域名白名单。它同时会关掉 CDP / auto-connect / profile /
     * 状态回放等旁路（CLI 自己的 fail-closed 行为），所以这是我们最看重的确定性门控。
     * 空数组 = 不限制。
     */
    allowedDomains: s.array(s.string().pattern(DOMAIN)).default([]),
    /** `--max-output`：页面输出截断（0 = 用 CLI 默认）。 */
    maxOutput: s.number().step(1).min(0).max(10_000_000).default(0),
    /** `--idle-timeout`：守护进程空闲多久退出（空 = CLI 默认 1h）。 */
    idleTimeout: s.string().pattern(IDLE_TIMEOUT).default(''),
    /** `--profile`：复用登录态的 Chrome profile 名或目录；空 = 一次性 profile。 */
    profile: s.string().default(''),
    /** `--executable-path`：自定义浏览器可执行文件；空 = CLI 默认。 */
    executablePath: s.string().default(''),
    /**
     * `--content-boundaries`：把页面输出包在边界标记里。
     * 默认开：网页内容是不可信数据，边界是给模型的"这不是指令"的物理提示。
     */
    contentBoundaries: s.boolean().default(true),
  }).default({}),

  session: s.object({
    /**
     * `--session` 名。留空 = 插件按 profile 派生一个固定名（`dsh-agent-browser`）。
     * 为什么不留空给 CLI 默认：CLI 的默认会话**全机共享、跨对话持久**，
     * 会劫持别的 agent 的页面，或把人类开着的标签导航走。
     */
    name: s.string().pattern(SESSION_NAME).default(''),
  }).default({}),

  tools: s.object({
    /** 「决策」：开启后额外注册 `browser_run`——插件内部的有界循环。 */
    decision: s.boolean().default(false),
    /** `browser_raw` 逃生舱：白名单内的其它 CLI 子命令。默认关。 */
    raw: s.boolean().default(false),
    /** `browser_screenshot`。 */
    screenshot: s.boolean().default(true),
  }).default({}),

  limits: s.object({
    /** 单条 CLI 命令的超时（`spawn` 层）。 */
    commandTimeoutMs: s.number().step(1).min(1_000).max(600_000).default(30_000),
    /** `browser_run` 的最大步数（每次动作算一步）。 */
    maxSteps: s.number().step(1).min(1).max(100).default(16),
    /** `goal_done` 概率达到它就停（判定在**动作之前**）。 */
    goalThreshold: s.number().step(0.01).min(0.5).max(1).default(0.85),
    /** `stuck` 概率达到它就停（同上，先于动作）。 */
    stuckThreshold: s.number().step(0.01).min(0.5).max(1).default(0.85),
  }).default({}),

  judgment: s.object({
    /**
     * 交给 `ctx.judgment` 的**用途名**。用途是给消费者的稳定名字：换连接/模型/密钥
     * 只改「设置 → 决策」，不动这里。默认 `browser.action`——dsh-judgment 的配置示例里
     * 已经预留了这个名字。
     */
    purpose: s.string().pattern(/^[^\s]+$/).default('browser.action'),
  }).default({}),
})

/** 校验后的配置值类型（schemastery 的输出类型）。 */
export type AgentBrowserConfig = typeof Config extends s<any, infer T> ? T : never
