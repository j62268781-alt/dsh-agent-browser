/**
 * 内置 skill：把随包发布的 `skills/agent-browser/`（SKILL.md + references/）注册成**运行时 skill**。
 *
 * 为什么内置而不是让用户自己装：这份 skill 是**与安装的 CLI 版本对齐**的核心命令集
 * （官方 `agent-browser skills get core --full` 是全量参考，直接塞进目录太重）。
 * 装插件即得。
 *
 * 三条纪律：
 * - **`ctx.skills` 是可选服务**：不在就跳过并记日志，绝不让整个插件起不来。
 * - **不改原文**：SKILL.md 逐字使用（它是同步 CLI 版本的产物），插件相关的补充
 *   放在注册时**追加**的一段里，避免两份真相各自漂移。
 * - `resourceBase` 指向 references 目录，模型可以按需读那 5 份深入参考。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `lib/skill.js` → `<包根>/skills/agent-browser`。 */
export const SKILL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'agent-browser')

export interface BundledSkill {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly content: string
  readonly resourceBase: { readonly kind: 'directory'; readonly path: string }
}

/**
 * 解析 SKILL.md 的 frontmatter。只支持**单行** `key: value`——我们自己的 SKILL.md
 * 就是这么写的；遇到不认识的形状不猜，直接报错（宁可显式失败）。
 */
export function parseSkillFile(text: string): { readonly fields: Record<string, string>; readonly body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (match === null) throw new Error('SKILL.md 缺少 frontmatter')
  const fields: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator < 0) throw new Error(`SKILL.md frontmatter 不是 key: value 形状：${line}`)
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  return { fields, body: text.slice(match[0].length) }
}

/** 读随包发布的 SKILL.md。文件缺失 = 打包出错，明确抛错。 */
export function loadBundledSkill(): BundledSkill {
  const file = join(SKILL_ROOT, 'SKILL.md')
  if (!existsSync(file)) throw new Error(`内置 skill 缺失：${file}（打包时把 skills/ 带上）`)
  const { fields, body } = parseSkillFile(readFileSync(file, 'utf8'))
  const name = fields.name
  const description = fields.description
  if (name === undefined || name === '' || description === undefined || description === '') {
    throw new Error('内置 SKILL.md 的 frontmatter 必须有 name 与 description')
  }
  return {
    name,
    description,
    ...(fields.whenToUse === undefined || fields.whenToUse === '' ? {} : { whenToUse: fields.whenToUse }),
    content: body,
    resourceBase: { kind: 'directory', path: SKILL_ROOT },
  }
}

/** 注册时追加的插件补充：skill 原文不动，插件的存在与工具名在这里说。 */
export function pluginNote(options: { readonly tools: boolean; readonly decision: boolean }): string {
  const lines = [
    '',
    '---',
    '',
    '## DSH 插件补充（由 dsh-agent-browser 注入，不属于 CLI 原文）',
    '',
    options.tools
      ? '本插件已把常用操作封成**工具**（有 schema、版本校验、命名会话隔离），优先用工具；工具覆盖不到的子命令再用 bash 调 CLI：'
      : '本插件的工具面当前**关闭**，请用 bash 直接调 CLI：',
  ]
  if (options.tools) {
    lines.push(
      '',
      '- `browser_snapshot` 取无障碍树 + `@eN`（可同时带 `includeText`/`includeTitle` 一次 `batch` 拿齐，省两次进程启动）',
      '- `browser_act` 执行**一个**动作（支持 `expectUrl`/`expectName` 新鲜度断言）',
      '- `browser_read` 只读抓取页面文本/元素属性；`browser_session` 管 open/close/tabs；`browser_screenshot` 截图',
      '- **单会话串行约束**：插件工具共享单一命名会话（默认 `dsh`），**严禁多个并行 subagent/teammate 同时调用 `browser_*` 工具**（会互抢活动标签页并覆盖句柄）；多 Agent 请串行委派，或用 bash CLI 各自指定独立 `--session <name>`',
      options.decision
        ? '- `browser_run(goal, inputs?, subgoals?)`：用一句话目标驱动有界循环（原生支持同源 iframe / open shadow DOM / 自定义 combobox；跨域 iframe、closed shadow DOM、上传下载、右键菜单、画布、多标签用原子工具），结束时状态是 `needs_verification` 交回你做最终校验；' +
          '已经知道要填什么时用 `inputs` 一次给全（插件同一次调用里填完，不逐字往返）；' +
          '已知顺序的多步流程用 `subgoals` 一次给全（顺序由你给、每个子目标只有 `needs_verification` 才推进，遇到 ambiguous/likely_done/needs_confirmation 停下交回）'
        : '- 「决策」当前关闭，所以没有 `browser_run`',
    )
  }
  lines.push('', '深入参考（绝对路径，按需读，勿一次全读）：', '')
  const refs: readonly [string, string][] = [
    ['commands.md', '全量命令与参数'],
    ['snapshot-refs.md', '@eN 生命周期与 --delta'],
    ['session-management.md', '多会话并行、--cdp、--pin-tab'],
    ['authentication.md', '登录态、OAuth、2FA、auth vault'],
    ['trust-boundaries.md', '安全边界与 --allowed-domains'],
  ]
  for (const [file, desc] of refs) {
    lines.push(`- \`${join(SKILL_ROOT, 'references', file)}\`（${desc}）`)
  }
  return `${lines.join('\n')}\n`
}
