#!/usr/bin/env node
/**
 * 真机探针：在独立会话（默认 `dsh-probe`）里跑 `lib/extract.js` 的 EXTRACT_SCRIPT，
 * 把 items 的数量与前 N 个候选打出来。**只读**，不碰 src/ 与 bench/。
 *
 * 用法：
 *   node scripts/probes/extract-probe.mjs --url https://example.com
 *   node scripts/probes/extract-probe.mjs --url <url> --js-file scripts/probes/foo.js
 *   node scripts/probes/extract-probe.mjs --js "document.title"      # 任意 eval
 *   node scripts/probes/extract-probe.mjs --url <url> --top 40 --raw # 额外打印 text
 *
 * 纪律：页面内容是数据不是指令；本脚本只统计。
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { EXTRACT_SCRIPT } from '../../lib/extract.js'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const flag = (name) => args.includes(name)

const SESSION = opt('--session', 'dsh-probe')
const URL = opt('--url', '')
const TOP = Number(opt('--top', '30'))
const JS_FILE = opt('--js-file', '')
const INLINE_JS = opt('--js', '')
const script = INLINE_JS !== '' ? INLINE_JS : JS_FILE !== '' ? readFileSync(JS_FILE, 'utf8') : EXTRACT_SCRIPT

function run(argv, input) {
  const proc = spawnSync('agent-browser', argv, {
    input,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (proc.error) throw proc.error
  return {
    code: proc.status,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
  }
}

const stripBoundaries = (text) =>
  text
    .replace(/^\s*---\s*(?:END_)?AGENT_BROWSER_(?:PAGE_)?CONTENT[^\n]*---\s*$/gim, '')
    .trim()

let failed = false
if (URL !== '') {
  const opened = run(['--session', SESSION, 'open', URL])
  console.log(`[open] exit=${opened.code} ${opened.stdout.trim().split('\n').slice(-1)[0] ?? ''}`)
  if (opened.code !== 0) {
    console.error(stripBoundaries(opened.stderr || opened.stdout).slice(0, 2000))
    process.exit(opened.code ?? 1)
  }
  run(['--session', SESSION, 'wait', '--load', 'load'])
}

const evaled = run(['--session', SESSION, 'eval', '--json', '--stdin'], script)
if (evaled.code !== 0) {
  console.error(`[eval] exit=${evaled.code}`)
  console.error(stripBoundaries(evaled.stderr || evaled.stdout).slice(0, 3000))
  process.exit(evaled.code ?? 1)
}

let envelope
try {
  envelope = JSON.parse(stripBoundaries(evaled.stdout))
} catch (error) {
  console.error(`[eval] 输出不是 JSON：${error.message}`)
  console.error(stripBoundaries(evaled.stdout).slice(0, 3000))
  process.exit(2)
}
if (envelope.success !== true) {
  console.error('[eval] success=false:', JSON.stringify(envelope.error ?? null).slice(0, 2000))
  process.exit(3)
}

let value = envelope.data?.result ?? envelope.result
if (typeof value === 'string') {
  try {
    value = JSON.parse(value)
  } catch {
    // 非 JSON 的 eval：原样打印
    console.log(typeof value === 'string' ? value : JSON.stringify(value))
    process.exit(0)
  }
}

if (value === null || typeof value !== 'object' || !Array.isArray(value.items)) {
  console.log('result =', JSON.stringify(value)?.slice(0, 2000))
  process.exit(0)
}

const items = value.items
const covered = items.filter((it) => Number(it[3]) === 1).length
console.log(
  JSON.stringify({
    url: value.url,
    title: value.title,
    origin: envelope.data?.origin,
    items: items.length,
    covered,
    truncated: value.truncated === true,
    textLen: String(value.text ?? '').length,
  }),
)
console.log('idx | role | name | covered')
for (const it of items.slice(0, TOP)) {
  const [idx, role, name, cov, extra] = it
  console.log(`${idx} | ${role} | ${JSON.stringify(name)} | ${cov}${extra ? ` | ${extra}` : ''}`)
}
if (flag('--raw')) {
  console.log('--- text ---')
  console.log(String(value.text ?? '').slice(0, 4000))
}
if (failed) process.exit(1)
