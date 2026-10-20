/**
 * 真网脚本共用：从 **profile 的插件配置**里读 `agent-browser` 这一段。
 *
 * 为什么需要它：`pnpm e2e` / `pnpm try` 是**旁路**启动浏览器的，不经过 DSH 的插件装载。
 * 早先脚本硬编码了 `--session … --content-boundaries`，于是用户在设置页里打开的
 * `browser.headed`（有头模式）对脚本完全无效——"我配了有头，测试却没弹窗"。
 * 现在脚本按 profile 里的真实配置组装 `globalArgs`（与插件同一个 `globalArgsOf`）。
 *
 * 解析：只处理 `cordis.patch.yml` 里 `- id: agent-browser` 这块的 **YAML 子集**
 * （嵌套对象 + 标量 + 简单列表）。解析不到就退回插件默认值并打印提示——
 * 这是开发脚本，不值得为它引入 YAML 依赖。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 与 src/config.ts 的默认值保持一致。 */
const DEFAULTS = {
  enabled: true,
  browser: {
    headed: false,
    allowedDomains: [],
    maxOutput: 0,
    idleTimeout: '',
    profile: '',
    executablePath: '',
    contentBoundaries: true,
  },
  session: { name: '' },
  tools: { decision: false, raw: false, screenshot: true },
  limits: { commandTimeoutMs: 30_000, maxSteps: 16, goalThreshold: 0.85, stuckThreshold: 0.85 },
  judgment: { purpose: 'browser.action' },
}

function parseScalar(raw) {
  const text = raw.trim()
  if (text === '' || text === '""' || text === "''") return ''
  if (text === '[]') return []
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text)
  return text.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
}

/**
 * 解析 `- id: agent-browser` 那一块的极简 YAML：缩进决定层级，支持嵌套对象、
 * `key: value` 标量与 `- item` 列表。其它条目（别的插件）不碰。
 */
export function parseAgentBrowserBlock(yamlText) {
  const lines = yamlText.split('\n')
  const start = lines.findIndex((line) => /^-\s*id:\s*agent-browser\s*$/.test(line))
  if (start < 0) return undefined
  const config = {}
  const stack = [{ indent: -1, node: config }]
  let listTarget
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^-\s*id:/.test(line) || /^-\s*insert:/.test(line)) break // 下一个顶层条目
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    // 列表项：挂到最近一次 `key:` 的数组上
    const listItem = /^\s*-\s+(.*)$/.exec(line)
    if (listItem !== null) {
      if (Array.isArray(listTarget)) listTarget.push(parseScalar(listItem[1]))
      continue
    }
    const match = /^\s*([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line)
    if (match === null) continue
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].node
    const [, key, raw] = match
    if (raw.trim() === '') {
      const child = {}
      parent[key] = child
      stack.push({ indent, node: child })
      listTarget = undefined
    } else {
      parent[key] = parseScalar(raw)
      listTarget = Array.isArray(parent[key]) ? parent[key] : undefined
    }
  }
  return config
}

/** DSH home：app 用独立 home（`DSH_HOME`）时优先它；否则退回 `~/.dsh`。 */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 某个 profile 的 `cordis.patch.yml` 绝对路径。 */
export function profileFile(profile = process.env.DSH_PROFILE ?? 'desktop') {
  return join(dshHome(), 'profiles', profile, 'cordis.patch.yml')
}

/**
 * 从本机凭据存储的 `refs:` 段读一个引用值（只给 `scripts/` 用，**永不回显**）。
 *
 * 为什么需要：开发脚本原本靠 dsh-judgment 源码 checkout 里的 `scripts/read-profile.mjs`；
 * 但只装了 **npm 包**的环境（app 的实际形态）没有那个文件。凭据文件格式是稳定的
 * （`refs: { NAME: value }`），读它即可，不复制 dsh-judgment 的私有实现。
 */
export function readCredentialRef(ref) {
  const file = join(dshHome(), '.credentials.yaml')
  const lines = readFileSync(file, 'utf8').split('\n')
  const start = lines.findIndex((line) => /^refs:\s*$/.test(line))
  if (start < 0) throw new Error(`${file} 里没有 refs 段`)
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (!/^\s+/.test(line)) break
    const match = /^\s+([A-Za-z0-9_.-]+):\s*(\S+)\s*$/.exec(line)
    if (match === null || match[1] !== ref) continue
    return match[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
  }
  throw new Error(`凭据存储 ${file} 里没有 ${ref}`)
}

/** 读 profile 里的 `agent-browser` 配置（缺项用默认值补齐）。 */
export function readAgentBrowserConfig(profile = process.env.DSH_PROFILE ?? 'desktop') {
  const file = profileFile(profile)
  let parsed
  try {
    parsed = parseAgentBrowserBlock(readFileSync(file, 'utf8'))
  } catch (error) {
    console.warn(`读不到 ${file}（${String(error?.message ?? error)}）：用插件默认配置`)
    return { ...DEFAULTS, source: 'defaults' }
  }
  if (parsed === undefined) {
    console.warn(`${file} 里没有 agent-browser 条目：用插件默认配置`)
    return { ...DEFAULTS, source: 'defaults' }
  }
  const config = parsed.config ?? {}
  return {
    enabled: config.enabled ?? DEFAULTS.enabled,
    browser: { ...DEFAULTS.browser, ...(config.browser ?? {}) },
    session: { ...DEFAULTS.session, ...(config.session ?? {}) },
    tools: { ...DEFAULTS.tools, ...(config.tools ?? {}) },
    limits: { ...DEFAULTS.limits, ...(config.limits ?? {}) },
    judgment: { ...DEFAULTS.judgment, ...(config.judgment ?? {}) },
    source: file,
  }
}
