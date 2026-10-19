/**
 * 真网脚本共用：起一个**真的** dsh-judgment Service（与插件运行期同一条 `ask` 通路）。
 *
 * 凭据来自本机凭据存储/环境变量（`dsh-judgment/scripts/read-profile.mjs`），
 * **只用于 scripts/ 下的开发脚本**；插件运行期一律走 `ctx.credentials.resolve` 现取。
 * 密钥永不回显。
 *
 * **可以指定连接名**（`--connection <name>`）：Settings → 决策 里可以配多条连接，
 * bench 用哪条由调用方选——这样能在不动插件默认连接的前提下对比 judge
 * （比如预览模型 vs TypeSafe 的 jev-latest）。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import JudgmentService from '../../dsh-judgment/lib/index.js'
import { readConnection, readCredential } from '../../dsh-judgment/scripts/read-profile.mjs'

/**
 * 从 profile 的 `cordis.patch.yml` 里读出**所有** judgment 连接。
 *
 * 只解析 `connections:` 这一段的最小 YAML 子集（名字 6 空格、字段 8 空格），
 * 不引入 YAML 依赖——它是开发脚本，不是产品代码。
 */
export function readConnections(profile = process.env.DSH_PROFILE ?? 'desktop') {
  const patchFile = join(homedir(), '.dsh', 'profiles', profile, 'cordis.patch.yml')
  const patch = readFileSync(patchFile, 'utf8')
  const lines = patch.split('\n')
  const start = lines.findIndex((line) => /^- id: judgment\/provider/.test(line))
  if (start < 0) throw new Error(`${patchFile} 里没有 judgment/provider 这一行`)

  const connections = {}
  let inConnections = false
  let current
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^- id: /.test(line)) break
    if (/^\s{4}connections:\s*$/.test(line)) {
      inConnections = true
      continue
    }
    if (!inConnections) continue
    const name = /^\s{6}([A-Za-z0-9_.-]+):\s*$/.exec(line)
    if (name !== null) {
      current = { name: name[1] }
      connections[name[1]] = current
      continue
    }
    const field = /^\s{8}([A-Za-z][A-Za-z0-9_]*):\s*(\S+)\s*$/.exec(line)
    if (field !== null && current !== undefined) current[field[1]] = field[2]
  }
  if (Object.keys(connections).length === 0) throw new Error(`${patchFile} 里没有可用的 judgment 连接`)
  return connections
}

/**
 * @param {string} purpose
 * @param {string} [connectionName] 不传就用 profile 里的第一条（与 `readConnection` 行为一致）
 */
export async function createLiveJudge(purpose = 'browser.action', connectionName) {
  const connections = readConnections()
  const names = Object.keys(connections)
  const chosenName = connectionName ?? names[0]
  const raw = connections[chosenName]
  if (raw === undefined) throw new Error(`没有名为 "${chosenName}" 的连接；可用：${names.join(', ')}`)
  const connection = {
    protocol: raw.protocol ?? 'system-one',
    baseUrl: raw.baseUrl,
    model: raw.model,
    credentialRef: raw.credentialRef,
    timeoutMs: Number(raw.timeoutMs ?? 10_000),
  }
  if (connection.baseUrl === undefined || connection.model === undefined) {
    throw new Error(`连接 "${chosenName}" 缺少 baseUrl / model`)
  }
  const credential = readCredential(connection.credentialRef)

  class Credentials extends Service {
    constructor(ctx) {
      super(ctx, 'credentials')
      this.key = credential
    }

    async describe() {
      return { configured: true, writable: true, source: 'stored' }
    }

    async resolve() {
      return { value: this.key, source: 'stored' }
    }
  }

  const ctx = new Context()
  await ctx.plugin(Credentials)
  await ctx.plugin(JudgmentService, {
    connections: {
      live: {
        protocol: connection.protocol,
        baseUrl: connection.baseUrl,
        model: connection.model,
        credentialRef: connection.credentialRef,
        timeoutMs: connection.timeoutMs,
      },
    },
    purposes: { [purpose]: { connection: 'live' } },
    defaultConnection: 'live',
    ledger: { enabled: false, path: '' },
  })

  const judge = ctx.get('judgment')
  return {
    judge,
    connection: chosenName,
    describe: `${chosenName}：${connection.baseUrl} · 模型 ${connection.model} · 凭据 ${credential.length} 字符（不回显）`,
  }
}

export { readConnection }
