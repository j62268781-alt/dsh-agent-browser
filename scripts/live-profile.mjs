#!/usr/bin/env node
/**
 * **真机测试环境**：在仓库里准备一个可丢弃的 DSH `home`，用真实的 `dsh` CLI 跑一个
 * headless agent 回合——agent 会像用户一样调用本插件注册的工具（含 `browser_run`）。
 *
 * 和 `pnpm e2e` 的区别：
 *   - `pnpm e2e` / `pnpm try` 是**旁路**：脚本自己起 cordis + 插件服务，绕过 DSH 装载；
 *   - 这个脚本是**真机**：真的 `dsh` 进程、真的插件装载（兼容性闸门 / volatile 配置 /
 *     Remote / 工具注册全走一遍），真 Chrome（profile 里 `browser.headed` 决定有没有窗口）。
 *
 * 做了什么（全部在 `$DSH_HOME` 里，可删）：
 *   1. 用 `--from-default-profile headless` 生成一个 headless profile（一次性 agent 回合）；
 *   2. 把我们的插件与 dsh-judgment 以 `link:` 装进去（绝对符号链接，不复制代码）；
 *   3. 从 desktop profile 抄 `judgment/provider`、`agent-browser`、模型路由配置；
 *   4. 重开 headless 默认关掉的交互式凭据存储，并复制 `.credentials.yaml`（**不打印内容**）；
 *   5. 打印可以直接跑的 `dsh` 命令。
 *
 * 用法：
 *   node scripts/live-profile.mjs                    # 准备环境并打印命令
 *   node scripts/live-profile.mjs --run "任务文本"    # 准备完直接跑一个真实 agent 回合
 *   node scripts/live-profile.mjs --dir .live-dsh    # 自定义目录
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const JUDGMENT = resolve(REPO, '..', 'dsh-judgment')
const HOME_DEFAULT = join(REPO, '.live-dsh')
const PROFILE = 'live'
/** profile 里的依赖键与 bundles 条目都是**包名**：从 package.json 派生，改包名不用改这里。 */
const PKG_NAME = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).name

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const liveHome = resolve(arg('dir', HOME_DEFAULT))
const runTask = arg('run', undefined)
const desktopPatch = readFileSync(join(process.env.HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')

/** 从 desktop profile 里抠出一个 `- id: …` 条目（到下一个顶层条目为止）。 */
function block(id) {
  // JS 不支持 `(?ms)` 内联标志，也没有 `\Z`：flags 放第二个参数，结尾用 `(?![\s\S])`。
  const pattern = new RegExp(
    String.raw`^- id: ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n.*?(?=^- (?:id|insert):|(?![\s\S]))`,
    'ms',
  )
  const match = pattern.exec(desktopPatch)
  return match === null ? '' : match[0].trimEnd()
}

/* 1) 生成 headless profile */
if (existsSync(liveHome)) rmSync(liveHome, { recursive: true, force: true })
mkdirSync(liveHome, { recursive: true })
execFileSync('dsh', ['--profile', PROFILE, '--from-default-profile', 'headless', '--dump-config'], {
  env: { ...process.env, DSH_HOME: liveHome },
  stdio: 'ignore',
})
const profileDir = join(liveHome, 'profiles', PROFILE)

/* 2) 装插件（link: + 绝对符号链接） */
const pkgFile = join(profileDir, 'package.json')
const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
pkg.dependencies = { ...(pkg.dependencies ?? {}), [PKG_NAME]: `link:${REPO}`, 'dsh-judgment': `link:${JUDGMENT}` }
const bundles = pkg.dsh.profile.bundles
for (const name of ['dsh-judgment', PKG_NAME]) if (!bundles.includes(name)) bundles.push(name)
writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`)

const nodeModules = join(profileDir, 'node_modules')
mkdirSync(nodeModules, { recursive: true })
for (const [name, target] of [[PKG_NAME, REPO], ['dsh-judgment', JUDGMENT]]) {
  // scoped 包要多一层目录（node_modules/@scope/pkg）。
  const link = join(nodeModules, name)
  mkdirSync(dirname(link), { recursive: true })
  if (existsSync(link)) unlinkSync(link)
  symlinkSync(target, link)
}

/* 3) 配置：judgment 用途 + 插件配置 + 模型路由 */
const patchFile = join(profileDir, 'cordis.patch.yml')
const original = readFileSync(patchFile, 'utf8')
// 种子模板里是空列表 `[]`：追加条目后必须去掉，否则 YAML 非法。
const cleaned = original.split('\n').filter((line) => line.trim() !== '[]').join('\n').trimEnd()

const judgmentBlock = block('judgment/provider').replace(
  /purposes: \{\}/,
  'purposes:\n      browser.action:\n        connection: typesafe',
)
const sections = [
  block('agent-default-model'),
  block('llm-pi-ai'),
  judgmentBlock,
  block('agent-browser'),
  // headless 模板默认关掉交互式凭据存储（"一次性任务用启动期凭据"）；
  // dsh-judgment 只认 ctx.credentials.resolve，所以把它重新打开。
  '- id: credentials\n  disabled: false',
].filter((section) => section !== '')

writeFileSync(patchFile, `${cleaned}\n\n${sections.join('\n\n')}\n`)

/* 4) 凭据（不打印内容） */
const credentials = join(process.env.HOME, '.dsh', '.credentials.yaml')
if (existsSync(credentials)) {
  cpSync(credentials, join(liveHome, '.credentials.yaml'))
  console.log(`凭据：已复制到 ${join(liveHome, '.credentials.yaml')}（内容不打印）`)
} else {
  console.warn('凭据：~/.dsh/.credentials.yaml 不存在——judgment / 模型可能不可用')
}

console.log(`真机环境就绪：${liveHome}`)
console.log(`  profile：${profileDir}`)
console.log(`  插件：${PKG_NAME} ↔ ${REPO}`)
console.log(`  用途：browser.action → typesafe（与 desktop profile 一致）`)

const command = `DSH_HOME=${liveHome} dsh --profile ${PROFILE} "…任务文本…"`
console.log(`\n跑一个真实 agent 回合：\n  ${command}`)
console.log(`例如：\n  ${command.replace('…任务文本…', '用 browser_run 打开 https://jevusers.com/ 并报告最终 URL')}`)

if (runTask !== undefined) {
  console.log('\n—— 开始真实 agent 回合 ——\n')
  execFileSync('dsh', ['--profile', PROFILE, runTask], {
    env: { ...process.env, DSH_HOME: liveHome },
    stdio: 'inherit',
  })
}
