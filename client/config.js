/**
 * 读 Host 配置的小工具。形状照 dsh-judgment/client/config.js：
 * `form` 是 `ctx.configForms.get(entryId)` 给的一侧，有 `getSnapshot()` 与 `set`/`mutate`。
 */

/** Host 行 id 的候选：cordis.patch.yml 里的 id 是 `agent-browser`，也可能是包名。 */
export const ENTRY_CANDIDATES = ['agent-browser', 'dsh-agent-browser']

/** 取配置表单；未提供的 entry 会抛错，所以逐个试。 */
export function findForm(ctx) {
  for (const entryId of ENTRY_CANDIDATES) {
    try {
      const form = ctx?.configForms?.get?.(entryId)
      if (form) return { form, entryId }
    } catch {
      // 这个 entry 没有配置表单：换下一个候选。
    }
  }
  return { form: undefined, entryId: ENTRY_CANDIDATES[0] }
}

/** 设置文档的值；表单未就绪时是 `{}`。 */
export function snapshotOf(form) {
  const snapshot = form?.getSnapshot?.() ?? form?.store?.getSnapshot?.() ?? form?.snapshot
  return snapshot?.value ?? snapshot ?? {}
}

/** 表单状态字符串（宿主没说时按 `ready`）。 */
export function statusOf(form) {
  const snapshot = form?.getSnapshot?.() ?? form?.store?.getSnapshot?.() ?? form?.snapshot
  return snapshot?.status ?? 'ready'
}

/** 取一个对象字段；非对象读成空对象（页面里就不用到处判空）。 */
export function objectOf(value, field) {
  const group = value?.[field]
  return group !== null && typeof group === 'object' && !Array.isArray(group) ? group : {}
}

/** 取一个数组字段；非数组读成空数组。 */
export function arrayOf(value, field) {
  const list = value?.[field]
  return Array.isArray(list) ? list : []
}

/** 与 src/config.ts 一致的域名形状。 */
export const DOMAIN_PATTERN = /^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/
/** 与 src/config.ts 一致的会话名。 */
export const SESSION_PATTERN = /^[A-Za-z0-9._-]*$/
/** 与 src/config.ts 一致的空闲超时。 */
export const IDLE_PATTERN = /^(?:$|\d+(?:ms|s|m|h)?)$/

/** `a.com, *.b.com` / 一行一个 → `['a.com', '*.b.com']`，顺便把不合法的挑出来。 */
export function parseDomains(text) {
  // 多行 textarea：**换行与逗号都算分隔**（用户可能两种混着用）。
  const parts = String(text ?? '').split(/[,\n]/).map((part) => part.trim()).filter((part) => part !== '')
  const invalid = parts.filter((part) => !DOMAIN_PATTERN.test(part))
  return { domains: parts, invalid }
}

/** 界面用秒、配置存毫秒（用户口径）：30 秒 ↔ 30000。 */
export function msToSeconds(ms) {
  const value = Number(ms)
  return Number.isFinite(value) ? Math.round(value / 1000) : 0
}

export function secondsToMs(seconds) {
  const value = Number(seconds)
  return Number.isFinite(value) ? Math.round(value * 1000) : 0
}
