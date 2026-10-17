/**
 * 真网脚本共用：起一个**真的** dsh-judgment Service（与插件运行期同一条 `ask` 通路）。
 *
 * 凭据来自本机凭据存储/环境变量（`dsh-judgment/scripts/read-profile.mjs`），
 * **只用于 scripts/ 下的开发脚本**；插件运行期一律走 `ctx.credentials.resolve` 现取。
 * 密钥永不回显。
 */

import { Context, Service } from '@deepseek-ai/cordis'
import JudgmentService from '../../dsh-judgment/lib/index.js'
import { readConnection, readCredential } from '../../dsh-judgment/scripts/read-profile.mjs'

export async function createLiveJudge(purpose = 'browser.action') {
  const connection = readConnection()
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
    describe: `${connection.baseUrl} · 模型 ${connection.model} · 凭据 ${credential.length} 字符（不回显）`,
  }
}
