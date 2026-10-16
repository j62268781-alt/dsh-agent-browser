/**
 * 环境探测与"帮忙装"：本机有没有 Chrome、agent-browser 该用什么命令装。
 *
 * 为什么单独一个文件：设置页的自检只报**两项**（CLI / Chrome），这两项都得在
 * 宿主侧问本机——浏览器侧既 spawn 不了进程也读不了文件系统。这里全是可单测的纯逻辑，
 * 只有 `runCommand` 真的起进程。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface CommandResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/** 跑一条外部命令（安装器用）。**超时即杀**，不留下一个挂着等密码的 brew。 */
export function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  options: { signal?: AbortSignal } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      resolve({ code, stdout, stderr, timedOut })
    }
    const abort = (): void => {
      child.kill('SIGTERM')
      finish(null)
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      finish(null)
    }, timeoutMs)

    if (options.signal?.aborted === true) {
      abort()
      return
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error: Error) => {
      stderr += `\n${error.message}`
      finish(null)
    })
    child.on('close', (code: number | null) => finish(code))
  })
}

/** PATH 上按名字找可执行文件（与 cli.ts 的同名逻辑一致：不做 shell 展开）。 */
export function whichOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue
    const candidate = `${dir}/${name}`
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * 安装 agent-browser 的计划：Homebrew 优先（macOS 上最不容易踩权限坑），
 * 否则 npm 全局装。两者都不在 → undefined，"帮忙装"这个按钮就不出现。
 */
export function installPlan(brewPath: string | undefined, npmPath: string | undefined): { command: string; args: string[]; label: string } | undefined {
  if (brewPath !== undefined) return { command: brewPath, args: ['install', 'agent-browser'], label: 'brew install agent-browser' }
  if (npmPath !== undefined) return { command: npmPath, args: ['install', '-g', 'agent-browser'], label: 'npm i -g agent-browser' }
  return undefined
}

/**
 * Chrome 的可执行文件候选。只在**问不了 CLI**（没装 CLI、或 doctor 跑不起来）时用，
 * 属于尽力而为：Chrome 装在非标准位置时会漏报，所以消息里要写"没找到"而不是"没有"。
 */
export function chromeCandidates(platform: string, home: string): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  }
  if (platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    const localAppData = process.env['LOCALAPPDATA'] ?? `${home}\\AppData\\Local`
    return [
      `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFiles} (x86)\\Google\\Chrome\\Application\\chrome.exe`,
      `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
    ]
  }
  return []
}

/** Chrome 的 PATH 名（Linux 常见是 google-chrome / chromium）。 */
export function chromePathNames(platform: string): string[] {
  if (platform === 'linux') return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
  return []
}

/**
 * CLI 的 doctor 里那条 `chrome.installed` 的 message 长这样：
 * `Google Chrome 155.0.8059.84 at /Applications/…/Google Chrome`。
 * 面板不显示路径（用户要求），所以这里把 ` at …` 砍掉，只留名字 + 版本。
 */
export function shortChromeLabel(message: string): string {
  const trimmed = message.trim()
  const at = trimmed.search(/\s+at\s+\//)
  return at < 0 ? trimmed : trimmed.slice(0, at)
}

/** 汇总 doctor 的结果：有没有 Chrome、以及一条能给人看的标签。 */
export function chromeFromDoctor(payload: unknown): { installed: boolean; label: string } | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const checks = (payload as { checks?: unknown }).checks
  if (!Array.isArray(checks)) return undefined
  for (const entry of checks) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as { id?: unknown; status?: unknown; message?: unknown }
    if (record.id !== 'chrome.installed') continue
    const label = shortChromeLabel(String(record.message ?? 'Google Chrome'))
    return { installed: record.status === 'pass', label }
  }
  return undefined
}
