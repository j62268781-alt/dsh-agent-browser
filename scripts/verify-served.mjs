/**
 * 问正在运行的 Harness：它有没有把本插件编进 boot 数据、并提供当前的客户端半。
 *
 * 这是"装上去到底生效没有"唯一可自动化的判据：`dsh plugin add` 只是改了 profile 的
 * package.json 与 bundles 列表，真正说明问题的是 app 的 boot payload 里出现了本插件的 combo bundle。
 *
 * 浏览器会话 cookie 用 app 自己的 grant secret 现签（`~/.dsh/.credentials.yaml`），
 * 与 dsh-judgment / skills-mcp 面板的 verify-served.mjs 同一机制。**本脚本只签 cookie，绝不打印密钥。**
 *
 * 用法：node scripts/verify-served.mjs
 * 退出码：0 = 已提供且内容齐全；1 = app 尚未 composer 该 bundle（去 Plugins 页开一下或重启 DSH）
 */
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'

const AUTHORITY = process.env.DSH_AUTHORITY ?? '127.0.0.1:19387'
const PACKAGE = 'dsh-agent-browser'

/** boot 数据里必须出现的客户端产物；缺它就是没被 composer（或提供的是旧的一份）。 */
const NEEDLES = ['.ab-summary', '.ab-checkMark', 'settings.section', '浏览器环境就绪', '检查安装', '安装中…', '内容边界标记', '打开配置文件', 'src-json']

function cookie() {
  let secret
  try {
    const text = readFileSync(`${process.env.HOME}/.dsh/.credentials.yaml`, 'utf8')
    secret = Buffer.from(text.match(/secret:\s*(\S+)/)[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  } catch {
    console.error('✗ 读不到 ~/.dsh/.credentials.yaml 里的 grant secret：无法向运行中的应用认证')
    process.exit(1)
  }
  const b64url = (buffer) => Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const name = `dsh-auth-${b64url(createHash('sha256').update(AUTHORITY).digest())}`
  const now = Date.now()
  const body = b64url(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 3600_000 }))
  return `${name}=v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`
}

const headers = { cookie: cookie() }

let html
try {
  const response = await fetch(`http://${AUTHORITY}/`, { headers })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  html = await response.text()
} catch (cause) {
  console.error(`✗ 连不上运行中的应用 http://${AUTHORITY}：${cause.message ?? cause}`)
  process.exit(1)
}

const urls = [...html.matchAll(/["'(](plugins\/\?\?[^"')]+)/g)]
  .map((match) => match[1].replace(/&amp;/g, '&'))
const combo = urls.find((url) => url.includes(`${PACKAGE}/client.js`))
if (combo === undefined) {
  console.error(`✗ boot 数据里没有 ${PACKAGE}：app 还没 composer 这个 bundle。`)
  console.error('  → 打开侧边栏 Plugins 页找到它并打开开关（或重启 DSH）后重跑本脚本。')
  process.exit(1)
}
console.log(`✓ boot 数据已包含 ${PACKAGE}（combo ${combo.length} 字符）`)

const body = await (await fetch(`http://${AUTHORITY}/${combo}`, { headers })).text()
// esbuild 输出是 ASCII，中文都是 \uXXXX；先解码再找，否则非 ASCII 关键字必然找不到。
const decoded = body.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))

let failures = 0
for (const needle of NEEDLES) {
  const ok = decoded.includes(needle)
  if (!ok) failures += 1
  console.log(`  ${ok ? '✓' : '✗'} ${needle}`)
}

if (failures > 0) {
  console.error(`✗ 服务中的客户端产物缺少 ${failures} 项：app 提供的是旧的一份（重新构建并让它重载）`)
  process.exit(1)
}
console.log('✓ 客户端半已生效')
