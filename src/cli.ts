/**
 * `agent-browser` CLI 的薄封装：spawn + JSON 信封解析 + 版本锁。
 *
 * 纪律（DESIGN v2 §3）：
 * - **不碰 CDP、不引 Playwright**：引擎永远是 CLI，这里只负责拼参数、收输出、判错误。
 * - **只用有结构输出的命令**：`--json` 是全局开关，但不是每个子命令都真有结构化结果；
 *   解析失败**明确报错**，绝不猜（`parsed.data` 缺失 = `CliError('bad-output')`）。
 * - **版本锁**：v0.38.2 上实测过 refs 的身份绑定行为（DESIGN §1.1）；越界版本拒绝启动。
 */

import { spawn } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { EXTRACT_SCRIPT, parseExtracted, type ExtractedItem } from './extract.js'
import { dirname, join } from 'node:path'

/** CLI 发回来的统一信封：`{ success, data, error }`（0.38.2 实测）。 */
export interface CliEnvelope<T> {
  readonly success: boolean
  readonly data: T | null
  readonly error: string | null
}

/** `snapshot --json` 的 `data.refs` 条目。 */
export interface RefInfo {
  readonly name: string
  readonly role: string
  /**
   * 快照文本里被标了 `clickable` 的**非语义元素**（真机：hao123 顶部的城市切换是 `generic`）。
   * JSON 的 `refs` 不区分这个，只有文本树有——不读它，这类可点的容器就永远进不了候选。
   */
  readonly clickable?: boolean
}

/** 归一化后的快照（只保留我们真正用到的字段）。 */
/** `extract()` 的返回：脚本预抽的紧凑候选 + 正文 + 标题 + URL（一次进程拿齐）。 */
export interface ExtractedPage {
  readonly items: readonly ExtractedItem[]
  readonly text: string
  readonly title: string
  readonly url: string
  /** 元素数达到抽取上限（300）：页面比这更大，目标可能没被抽到。 */
  readonly truncated?: boolean
}

/** `observe()` 的返回：树 + 可见正文 + 标题（一次进程拿齐）。 */
export interface ObservedPage extends Snapshot {
  readonly text: string
  readonly title: string
}

/** `snapshot --json` 的 data 形状。 */
interface SnapshotData {
  origin?: string
  url?: string
  snapshot?: string
  refs?: Record<string, { name?: string; role?: string }>
  removedRefs?: string[]
}

/**
 * 快照 data → 归一化快照。
 *
 * 两个真机细节都在这里：① JSON 的 refs 里有些元素**名字是空的**（hao123 顶部的城市切换
 * generic 在文本树里有「茂名切换城市取消B 北京S…」，refs 里却是空串）——名字只存在于
 * 可读文本时从文本回填；② 文本里标了 `clickable` 的非语义元素也要能被候选枚举认出来。
 */
function normalizeSnapshot(data: SnapshotData): Snapshot {
  const origin = String(data.origin ?? data.url ?? '')
  const text = String(data.snapshot ?? '')
  if (text === '') throw new CliError('bad-output', 'snapshot --json 没有返回 data.snapshot')
  const refs: Record<string, RefInfo> = {}
  for (const [ref, value] of Object.entries(data.refs ?? {})) {
    refs[ref] = { name: String(value?.name ?? ''), role: String(value?.role ?? '') }
  }
  for (const line of text.split('\n')) {
    const match = /^-\s+([\w-]+)(?:\s+"((?:[^"\\]|\\.)*)")?.*\[ref=([\w-]+)\]/.exec(line.trim())
    if (match === null) continue
    const [, role, rawName, ref] = match
    const name = rawName === undefined ? '' : rawName.replace(/\\"/g, '"')
    const clickable = /\bclickable\b/.test(line)
    const current = refs[ref]
    if (current !== undefined) {
      const nextName = current.name === '' && name !== '' ? name : current.name
      if (nextName !== current.name || clickable) refs[ref] = { name: nextName, role: current.role, ...(clickable ? { clickable: true } : {}) }
    } else {
      refs[ref] = { name, role, ...(clickable ? { clickable: true } : {}) }
    }
  }
  return {
    origin,
    snapshot: text,
    refs,
    removedRefs: (data.removedRefs ?? []).map(String),
    digest: createHash('sha1').update(`${origin}\n${text}`).digest('hex').slice(0, 16),
  }
}

export interface Snapshot {
  /** CLI 的 `data.origin`（0.38.2 上 `data.url` 不存在）。 */
  readonly origin: string
  /** 无障碍树文本（带 `[ref=eN]`）。 */
  readonly snapshot: string
  readonly refs: Readonly<Record<string, RefInfo>>
  /** 本次快照相对上次消失的 ref（CLI 直接给，用于新鲜度判断的辅助信号）。 */
  readonly removedRefs: readonly string[]
  /** `origin + snapshot` 的指纹：执行前比对"页面是否变了"。 */
  readonly digest: string
  /**
   * 可见正文的指纹。抽取路径的 `snapshot` 只有"控件名+状态"，短正文（如 "Loading..."）
   * 根本进不去，于是"点了开始加载"被判成"页面没变"（bench fixture-lazy 暴露）。
   */
  readonly textDigest?: string
}

/** 支持的版本区间（含）。 */
export const SUPPORTED_MIN = '0.38.0'
export const SUPPORTED_MAX_EXCLUSIVE = '0.39.0'

export class CliError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CliError'
    this.code = code
  }
}

/** `close` 之后等守护进程真正退出的时间（实测 300ms 足够；见 `AgentBrowser.close`）。 */
const CLOSE_SETTLE_MS = 300

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface CliRunOptions {
  readonly stdin?: string
  readonly signal?: AbortSignal
  /** 覆盖默认超时（少数命令需要更长，例如 `install`）。 */
  readonly timeoutMs?: number
}

export interface AgentBrowserOptions {
  /** `agent-browser` 可执行文件；空 = 走 PATH，并自动跳过 JS 包装层（见 `resolveCommand`）。 */
  readonly command: string
  /** 每次调用都会带的全局参数（`--session` 等）。 */
  readonly globalArgs: readonly string[]
  readonly timeoutMs: number
}

/** 命令是怎么定下来的——诊断要能说清"到底跑了哪个二进制"。 */
export interface ResolvedCommand {
  readonly command: string
  readonly kind: 'configured' | 'native' | 'wrapper' | 'name'
  readonly detail: string
}

/** PATH 里按名字找可执行文件（不做 shell 展开，也不需要 shell）。 */
function which(name: string): string | undefined {
  if (name.includes('/')) return existsSync(name) ? name : undefined
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue
    const candidate = join(dir, name)
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // 这个目录没有：看下一个。
    }
  }
  return undefined
}

/**
 * musl libc 探测（Alpine 等）。**只查文件，不 exec `ldd`**：包装层用 `execSync`，
 * 我们不想为了判断一个文件名再起一个进程。
 */
function isMusl(platform: string): boolean {
  if (platform !== 'linux') return false
  return existsSync('/lib/ld-musl-x86_64.so.1') || existsSync('/lib/ld-musl-aarch64.so.1')
}

/**
 * 原生二进制的**文件名规则**——逐条移植 CLI 自带包装层 `bin/agent-browser.js` 的
 * `getBinaryName()`，不靠我们自己发明：
 *
 *   os:   darwin → darwin · linux → linux（musl → linux-musl）· win32 → win32
 *   arch: x64/x86_64 → x64 · arm64/aarch64 → arm64
 *   win32 + arm64：先看有没有 `agent-browser-win32-arm64.exe`，没有就退 x64（走系统模拟）
 *   后缀：win32 加 `.exe`
 *
 * **与版本无关**：这里没有任何版本号，规则跟着**已安装的那份 CLI** 走。
 */
export function nativeBinaryName(dir: string, platform: string, arch: string): string | undefined {
  const osKey = platform === 'darwin' ? 'darwin'
    : platform === 'linux' ? (isMusl(platform) ? 'linux-musl' : 'linux')
      : platform === 'win32' ? 'win32'
        : undefined
  if (osKey === undefined) return undefined
  const archKey = arch === 'x64' || arch === 'x86_64' ? 'x64'
    : arch === 'arm64' || arch === 'aarch64' ? 'arm64'
      : undefined
  if (archKey === undefined) return undefined

  if (osKey === 'win32' && archKey === 'arm64') {
    const native = 'agent-browser-win32-arm64.exe'
    return existsSync(join(dir, native)) ? native : 'agent-browser-win32-x64.exe'
  }
  return `agent-browser-${osKey}-${archKey}${platform === 'win32' ? '.exe' : ''}`
}

/** 同目录的原生二进制路径：`…/agent-browser/bin/agent-browser.js` → `…/bin/agent-browser-<os>-<arch>`。 */
export function nativeSiblingPath(scriptPath: string, platform: string, arch: string): string | undefined {
  const name = nativeBinaryName(dirname(scriptPath), platform, arch)
  return name === undefined ? undefined : join(dirname(scriptPath), name)
}

export function nativeSiblingOf(scriptPath: string, platform: string, arch: string): string | undefined {
  const candidate = nativeSiblingPath(scriptPath, platform, arch)
  return candidate !== undefined && existsSync(candidate) ? candidate : undefined
}

/**
 * 解析真正要 spawn 的二进制。
 *
 * 实测（本机 0.38.2，见 DESIGN §3.1）：PATH 上的 `agent-browser` 是一个 **Node 包装脚本**
 * （Homebrew 与 npx 都如此），它再 spawn 一份原生二进制——每次调用白付一份 Node 启动：
 *
 *   走包装层（`agent-browser`）      --version 57.3ms · get title 57.1ms · snapshot -i 57.9ms
 *   直接原生二进制                   --version  3.1ms · get title  3.7ms · snapshot -i  5.1ms · click @e2 16.8ms
 *
 * 所以默认就走到原生二进制。这是**纯收益**：同一个二进制、同一个版本，少一层进程。
 * 找不到就诚实退回包装层（宁可慢，不可猜）。
 */
export function resolveCommand(configured: string, platform = process.platform, arch = process.arch): ResolvedCommand {
  // 带路径的配置是**显式选择**：原样用（用户可能就是要指包装层或某个自带构建）。
  if (configured !== '' && configured.includes('/')) {
    return { command: configured, kind: 'configured', detail: `${configured}（配置里显式指定）` }
  }
  // 裸名字（含默认的 `agent-browser`）统一走 PATH 解析：只有这样才能发现"它其实是个 JS 包装层"。
  const name = configured === '' ? 'agent-browser' : configured
  const found = which(name)
  if (found === undefined) {
    return { command: name, kind: 'name', detail: `PATH 上没找到 ${name}：交给 spawn 报错，错误信息会说明` }
  }
  let real = found
  try {
    real = realpathSync(found)
  } catch {
    // 解析不了符号链接就用原路径。
  }
  if (/\.(?:js|cjs|mjs)$/.test(real)) {
    const native = nativeSiblingOf(real, platform, arch)
    if (native !== undefined) return { command: native, kind: 'native', detail: `${native}（跳过 ${real} 的 Node 包装层）` }
    return { command: real, kind: 'wrapper', detail: `${real}（JS 包装层；同目录没有原生二进制，将多付一份 Node 启动）` }
  }
  return { command: real, kind: 'native', detail: real }
}

/** 语义化版本比较：只支持 `X.Y.Z`（CLI 输出就是它）。 */
function parseVersion(text: string): readonly [number, number, number] | undefined {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/)
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compare(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

/** 版本是否落在支持区间 `[SUPPORTED_MIN, SUPPORTED_MAX_EXCLUSIVE)`。 */
export function isSupportedVersion(version: string): boolean {
  const parsed = parseVersion(version)
  if (parsed === undefined) return false
  return compare(parsed, parseVersion(SUPPORTED_MIN)!) >= 0 && compare(parsed, parseVersion(SUPPORTED_MAX_EXCLUSIVE)!) < 0
}

export class AgentBrowser {
  /** 实际 spawn 的二进制（默认会自动跳过 JS 包装层）。 */
  private resolved: ResolvedCommand
  /** 命令是**自动解析**来的（可以重新解析），还是配置里显式写死的。 */
  private readonly autoResolved: boolean

  constructor(private readonly options: AgentBrowserOptions) {
    this.resolved = resolveCommand(options.command)
    // 带 `/` 的配置是显式选择，不自动改；裸名字才允许重解析。
    this.autoResolved = !options.command.includes('/')
  }

  /** 实际 spawn 的二进制。 */
  get command(): string {
    return this.resolved.command
  }

  /** 命令是怎么定下来的，给日志与探针看。 */
  get commandDetail(): string {
    return this.resolved.detail
  }

  /** `native` = 直接跑原生二进制；`wrapper` = 还在付 Node 包装层的启动开销。 */
  get commandKind(): ResolvedCommand['kind'] {
    return this.resolved.kind
  }

  /** 会话参数（`--session` 等）——诊断信息里要能看出"这个 agent 用哪个会话"。 */
  get globalArgs(): readonly string[] {
    return this.options.globalArgs
  }

  /** 重新解析一次；命令真的变了才返回 true。 */
  private refresh(): boolean {
    if (!this.autoResolved) return false
    const next = resolveCommand(this.options.command)
    if (next.command === this.resolved.command) return false
    this.resolved = next
    return true
  }

  /**
   * 跑一条命令。**非零退出码一律抛错**：CLI 的失败是类型化事件，不能吞成空输出。
   * stderr 只作为诊断附注——0.38.2 上错误信息主要走 JSON 信封的 `error`。
   *
   * `brew upgrade` 会让上一次解析出的 Cellar 绝对路径消失（`spawn` 报 ENOENT）：
   * 自动重解析一次再试，而不是让用户看到一条"找不到文件"然后自己去重启 DSH。
   */
  async run(args: readonly string[], options: CliRunOptions = {}): Promise<string> {
    try {
      return await this.spawnOnce(args, options)
    } catch (error) {
      if (error instanceof CliError && error.code === 'spawn-failed' && this.refresh()) {
        return await this.spawnOnce(args, options)
      }
      throw error
    }
  }

  private async spawnOnce(args: readonly string[], options: CliRunOptions): Promise<string> {
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs
    const child = spawn(this.command, [...this.options.globalArgs, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const result = await new Promise<{ code: number | null; failed?: Error }>((resolve) => {
      const finish = (value: { code: number | null; failed?: Error }): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        resolve(value)
      }
      const killChild = (): void => {
        // wrapper 是原生二进制，对 SIGTERM 不敏感——必须 SIGKILL，并主动断开管道，
        // 否则 promise 虽然 resolve 了，子进程/管道仍然挂着（真机：60s 超时后拖到 928s）。
        try { child.kill('SIGKILL') } catch { /* 已退出 */ }
        child.stdout?.destroy()
        child.stderr?.destroy()
        child.stdin?.destroy()
      }
      const abort = (): void => {
        killChild()
        finish({ code: null, failed: new CliError('aborted', '浏览器命令被取消') })
      }
      const timer = setTimeout(() => {
        killChild()
        finish({
          code: null,
          failed: new CliError('timeout', `浏览器命令超过 ${timeoutMs}ms 未返回：agent-browser ${[...this.options.globalArgs, ...args].join(' ').slice(0, 160)}`),
        })
      }, timeoutMs)

      if (options.signal?.aborted === true) {
        abort()
        return
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      child.on('error', (error: Error) => {
        finish({ code: null, failed: new CliError('spawn-failed', `无法启动 ${this.command}：${error.message}`) })
      })
      child.on('close', (code: number | null) => finish({ code }))
      child.stdin.end(options.stdin ?? '')
    })

    if (result.failed !== undefined) throw result.failed
    if (result.code !== 0) {
      const detail = [stdout.trim(), stderr.trim()].filter((part) => part !== '').join('\n')
      throw new CliError('cli-failed', `agent-browser ${args[0] ?? ''} 退出码 ${result.code}${detail === '' ? '' : `：${detail.slice(0, 800)}`}`)
    }
    return stdout
  }

  /**
   * 跑一条命令并解 JSON 信封。`success: false` → `CliError('cli-error')`，
   * 正文带上 CLI 自己的 `error` 文案（"Unknown ref: e2" 这类要原样保留给模型）。
   */
  async json<T>(args: readonly string[], options: CliRunOptions = {}): Promise<T> {
    const stdout = await this.run([...args, '--json'], options)
    let envelope: CliEnvelope<T>
    try {
      envelope = JSON.parse(stdout) as CliEnvelope<T>
    } catch {
      throw new CliError('bad-output', `agent-browser ${args[0] ?? ''} 的输出不是 JSON：${stdout.slice(0, 300)}`)
    }
    if (envelope.success !== true || envelope.data === null) {
      throw new CliError('cli-error', envelope.error ?? `agent-browser ${args[0] ?? ''} 返回 success=false 但没有 error 文案`)
    }
    return envelope.data
  }

  /** CLI 版本（`agent-browser 0.38.2` → `0.38.2`）。 */
  async version(options: CliRunOptions = {}): Promise<string> {
    const stdout = await this.run(['--version'], options)
    const match = stdout.match(/(\d+\.\d+\.\d+)/)
    if (match === null) throw new CliError('bad-output', `无法解析 agent-browser --version 的输出：${stdout.trim()}`)
    return match[1]!
  }

  /**
   * 版本锁。**越界即拒**：DESIGN §1.1 的实测结论只对 0.38.x 成立，
   * 换了版本就该重新验证，而不是继续假设 refs 还是身份绑定的。
   */
  async assertSupported(options: CliRunOptions = {}): Promise<string> {
    const raw = await this.version(options)
    if (!isSupportedVersion(raw)) {
      throw new CliError(
        'unsupported-version',
        `agent-browser ${raw} 不在支持区间 [${SUPPORTED_MIN}, ${SUPPORTED_MAX_EXCLUSIVE})：` +
        '本插件的 ref 陈旧性结论是在 0.38.2 上实测的，升级后请重跑 DESIGN §1.1 的实验再放宽版本锁',
      )
    }
    return raw
  }

  /** 取一次无障碍树快照。 */
  async snapshot(
    options: { interactiveOnly?: boolean; depth?: number; selector?: string; urls?: boolean } = {},
    run: CliRunOptions = {},
  ): Promise<Snapshot> {
    const args = ['snapshot']
    if (options.interactiveOnly === true) args.push('-i')
    if (options.urls === true) args.push('-u')
    if (options.depth !== undefined) args.push('-d', String(options.depth))
    if (options.selector !== undefined && options.selector !== '') args.push('-s', options.selector)

    const data = await this.json<{
      origin?: string
      url?: string
      snapshot?: string
      refs?: Record<string, { name?: string; role?: string }>
      removedRefs?: string[]
    }>(args, run)

    return normalizeSnapshot(data)
  }

  /**
   * **一次进程**拿齐"决策需要的一切"：无障碍树 + 可见正文 + 标题。
   *
   * 为什么要合并：这个 CLI **每次调用都要新起一个进程**（实测 `--version` 就要 64ms，
   * 而真正的浏览器操作只占几毫秒）。分三次调用 = 3×63ms；用 `batch` 合并后 =
   * 1×63ms（实测 176ms → 62ms）。jev-ultrafast 用 CDP 长连接拿到的是同一个效果，
   * 我们在 CLI 这一层用 `batch` 等价实现。
   */
  async observe(
    options: { interactiveOnly?: boolean; depth?: number; selector?: string } = {},
    run: CliRunOptions = {},
  ): Promise<ObservedPage> {
    const snapshotCommand = ['snapshot']
    if (options.interactiveOnly !== false) snapshotCommand.push('-i')
    if (options.depth !== undefined) snapshotCommand.push('-d', String(options.depth))
    if (options.selector !== undefined && options.selector !== '') snapshotCommand.push('-s', options.selector)
    const [snapshotData, readData, titleData] = (await this.batch([snapshotCommand, ['read'], ['get', 'title']], run)) as [
      SnapshotData,
      { content?: string } | null,
      { title?: string } | null,
    ]
    const page = normalizeSnapshot(snapshotData)
    return {
      ...page,
      text: String(readData?.content ?? ''),
      title: String(titleData?.title ?? ''),
    }
  }

  /**
   * **一次进程**拿齐：页面内抽取的候选（含动作句柄）+ 可见正文 + 标题 + URL。
   *
   * 与 `observe()` 的区别：那份是整棵无障碍树（大），这份是脚本预抽的紧凑候选（小）。
   * 给判断层用后者：实测 1,021 字符 ≈ 256 tokens（整树约 4.3k tokens）。
   */
  async extract(run: CliRunOptions & { includeMedia?: boolean } = {}): Promise<ExtractedPage> {
    // **一次 `eval`**：脚本自己返回候选 + 正文 + 标题 + URL（单进程，7ms 量级）。
    // 不能塞进 batch：batch 按空白切分命令，而 JS 关键字之间必须有空白。
    //
    // `includeMedia`：只有目标需要 hover / drag / 图片时才额外抽 figure/img[alt]——
    // 默认不抽，避免 dense 页的图片把链接挤出 300 上限。
    const script = run.includeMedia === true
      ? EXTRACT_SCRIPT.replace("const selector = '", "const selector = 'figure,img[alt],[draggable=\"true\"],")
      : EXTRACT_SCRIPT
    const raw = await this.run(['eval', script], run)
    return parseExtracted(raw)
  }

  /** `batch [--bail] <cmd...>`：一次进程执行多条命令，返回逐条结果（失败即抛）。 */
  async batch(commands: readonly string[][], run: CliRunOptions = {}): Promise<unknown[]> {
    if (commands.length === 0) return []
    // 注意：`--json` 是 **batch 自己的**旗标（放在子命令之前），不是子命令的参数。
    const argv = ['batch', '--json', ...commands.map((command) => command.join(' '))]
    const stdout = await this.run(argv, run)
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout)
    } catch {
      throw new CliError('bad-output', `batch 的输出不是 JSON：${stdout.slice(0, 300)}`)
    }
    if (!Array.isArray(parsed)) throw new CliError('bad-output', 'batch 的输出不是数组')
    const results: unknown[] = []
    for (const item of parsed as Array<{ command?: string[]; error?: unknown; result?: unknown; success?: boolean }>) {
      if (item?.success !== true) {
        const name = Array.isArray(item?.command) ? item.command.join(' ') : 'batch 命令'
        throw new CliError('cli-error', `批处理里的「${name}」失败：${String(item?.error ?? '未知错误')}`)
      }
      results.push(item.result)
    }
    return results
  }

  /** 一个变更类动作 → CLI 子命令。**一次一个**，永远不串。 */
  async act(
    action: string,
    target: string,
    payload: { value?: string; values?: readonly string[]; direction?: string; amount?: number } = {},
    run: CliRunOptions = {},
  ): Promise<void> {
    const args = actionArgs(action, target, payload)
    await this.json(args, run)
  }

  /** `read [url]`：URL 协商 markdown / llms.txt；不给 URL 读当前页。 */
  async read(url: string | undefined, run: CliRunOptions = {}): Promise<string> {
    const args = url === undefined || url === '' ? ['read'] : ['read', url]
    return this.run(args, run)
  }

  /** `get <what> [selector]`。CLI 的 `--json` 在 data 里附了 `lifecycle`，这里只取有用的那部分。 */
  async get(what: string, selector: string | undefined, attrName: string | undefined, run: CliRunOptions = {}): Promise<string> {
    const args = ['get', what]
    if (selector !== undefined && selector !== '') args.push(selector)
    if (what === 'attr') {
      if (attrName === undefined || attrName === '') throw new CliError('bad-request', 'get attr 需要 attr 参数')
      args.push(attrName)
    }
    const data = await this.json<unknown>(args, run)
    if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') return String(data)
    if (data !== null && typeof data === 'object') {
      const record = data as Record<string, unknown>
      for (const key of [what, 'text', 'value', 'html', 'title', 'url', 'count', 'box', 'styles', 'attr']) {
        const value = record[key]
        if (value !== undefined && value !== null && typeof value !== 'object') return String(value)
        if (value !== null && typeof value === 'object') return JSON.stringify(value, null, 2)
      }
    }
    return JSON.stringify(data ?? null)
  }

  /**
   * **事件驱动地等待"点击后页面真的动了"**（不猜固定时长）。
   *
   * 实测（真机）：gitHub 标签页 1027ms、herokuapp 导航 858ms、Wikipedia 链接 1153ms
   * 才发生跳转 —— 之前固定等 40ms/250ms 会把"正在跳转"误判成"点击没效果"，
   * 于是换候选/判 no_progress（github-pulls 就是这么挂的）。
   *
   * 这里用**一次** CLI `wait --fn`（页面内部轮询），由浏览器自己告诉你"变了"，
   * 三种信号任一满足即返回：URL 变化 / 正文变化 / 指定选择器出现。
   */
  async waitForPageShift(
    previous: { url: string; textSample: string; selector?: string },
    run: CliRunOptions & { timeoutMs?: number } = {},
  ): Promise<boolean> {
    const timeout = run.timeoutMs ?? 4000
    const conditions = [`location.href !== ${JSON.stringify(previous.url)}`]
    if (previous.textSample !== '') {
      conditions.push(`!document.body.innerText.includes(${JSON.stringify(previous.textSample)})`)
    }
    if (previous.selector !== undefined && previous.selector !== '') {
      conditions.push(`document.querySelector(${JSON.stringify(previous.selector)}) !== null`)
    }
    const expression = conditions.map((condition) => `(${condition})`).join(' || ')
    const script = `new Promise((resolve) => { const deadline = Date.now() + ${timeout}; const tick = () => { try { if (${expression}) return resolve(true) } catch (e) {} if (Date.now() > deadline) return resolve(false); setTimeout(tick, 50) }; tick() })`
    try {
      const raw = await this.run(['eval', '-b', Buffer.from(script, 'utf8').toString('base64')], { ...run, timeoutMs: timeout + 3000 })
      const inner = raw.includes('true')
      return inner
    } catch {
      return false
    }
  }

  /**
   * **HTML5 拖拽**（dragstart/dragover/drop 合成事件 + DataTransfer）。
   *
   * 为什么不用 `act('drag')`：CLI 的 drag 走鼠标事件，HTML5 DnD 页面（真机 the-internet/
   * drag_and_drop）只监听 dragstart/drop，鼠标拖拽不会触发 → 页面纹丝不动。
   */
  async jsDrag(sourceRef: string, targetRef: string, run: CliRunOptions = {}): Promise<void> {
    const source = JSON.stringify(sourceRef)
    const target = JSON.stringify(targetRef)
    const script =
      `(() => { const src = document.querySelector(${source}); const dst = document.querySelector(${target});` +
      ' if (!src || !dst) return false; const dt = new DataTransfer();' +
      " const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));" +
      " fire(src, 'dragstart'); fire(dst, 'dragenter'); fire(dst, 'dragover'); fire(dst, 'drop'); fire(src, 'dragend'); return true })()"
    await this.run(['eval', '-b', Buffer.from(script, 'utf8').toString('base64')], run)
  }

  /**
   * 直接调用元素的 `el.click()`（合成事件）。
   *
   * 只对 `<a>` / `<button>` 用：它们不依赖坐标，折叠线下的元素也能生效
   * （CDP 鼠标点击要求元素在视口内，否则事件落在页面外、静默无效）。
   * 依赖 pointerdown/hover 的自定义组件仍要走 `act('click')`。
   */
  async jsClick(ref: string, run: CliRunOptions = {}): Promise<void> {
    const selector = JSON.stringify(ref)
    const script = `document.querySelector(${selector})?.click()`
    const encoded = Buffer.from(script, 'utf8').toString('base64')
    await this.run(['eval', '-b', encoded], run)
  }

  async open(url: string, run: CliRunOptions = {}): Promise<void> {
    await this.json(['open', url], run)
    // ⚠️ `open` 成功返回 **不等于导航已经提交**：真机（0.38.2）上紧接着取快照，
    // 页面还是 `about:blank`，于是决策循环只看到滚动/等待、白跑几步才超时。
    if (await this.waitUntilNavigated(run)) return

    // 兜底：极少数情况下 open 仍停在 about:blank（上一个会话的守护进程正在退出）。
    // 关掉、等它真的退出、再打开一次；仍然不行就**明确报错**，不静默留在空白页。
    await this.json(['close'], run).catch(() => undefined)
    await sleep(CLOSE_SETTLE_MS)
    await this.json(['open', url], run)
    if (await this.waitUntilNavigated(run)) return
    throw new CliError('open-stalled', `open 之后页面仍停在 about:blank（${url}）：浏览器会话没有真正导航`)
  }

  /** 轮询 `get url` 直到页面不再是 about:blank（导航提交 / 重定向都算落地）。 */
  private async waitUntilNavigated(run: CliRunOptions): Promise<boolean> {
    const budget = Math.min(run.timeoutMs ?? this.options.timeoutMs, 5_000)
    const deadline = Date.now() + budget
    for (;;) {
      const current = await this.get('url', undefined, undefined, run).catch(() => '')
      if (current !== '' && !/^about:blank$/i.test(current)) return true
      if (Date.now() >= deadline) return false
      await sleep(100)
    }
  }

  async close(run: CliRunOptions = {}): Promise<void> {
    await this.json(['close'], run)
    // **`close` 返回 ≠ 守护进程已退出**（实测 0.38.2）：紧接着 open 会挂到正在退出的 daemon 上，
    // 导航变成 no-op（页面停在 about:blank，要在几百毫秒后再 open 才正常）。
    // 等它真的退出，别把这个竞态留给调用方。实测：不等 6 次里 4 次失败，等 300ms 后 6/6 成功。
    await sleep(CLOSE_SETTLE_MS)
  }

  async screenshot(path: string | undefined, fullPage: boolean, run: CliRunOptions = {}): Promise<string> {
    const args = ['screenshot']
    if (fullPage) args.push('--full')
    if (path !== undefined && path !== '') args.push(path)
    const data = await this.json<{ path?: string } | string>(args, run)
    return typeof data === 'string' ? data : String(data.path ?? JSON.stringify(data))
  }

  async tabs(run: CliRunOptions = {}): Promise<string> {
    const data = await this.json<unknown>(['tab', 'list'], run)
    return typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  }
}

/** 动作 → CLI 参数。未知动作在这里就被拒（不是等到 CLI 报错）。 */
export function actionArgs(
  action: string,
  target: string,
  payload: { value?: string; values?: readonly string[]; direction?: string; amount?: number } = {},
): string[] {
  const values = payload.values ?? (payload.value === undefined ? [] : [payload.value])
  switch (action) {
    case 'click': return ['click', target]
    case 'dblclick': return ['dblclick', target]
    case 'hover': return ['hover', target]
    case 'focus': return ['focus', target]
    case 'check': return ['check', target]
    case 'uncheck': return ['uncheck', target]
    case 'fill': return withValue(['fill', target], payload.value, action)
    case 'type': return withValue(['type', target], payload.value, action)
    case 'select': return ['select', target, ...requireValues(values, action)]
    case 'upload': return ['upload', target, ...requireValues(values, action)]
    case 'press': return ['press', requireString(payload.value, 'press 需要 value（键名）')]
    case 'scroll': {
      const direction = payload.direction ?? 'down'
      const args = ['scroll', direction]
      if (payload.amount !== undefined) args.push(String(payload.amount))
      return args
    }
    case 'scrollintoview': return ['scrollintoview', target]
    // 拖拽：target 是源，value 是目标（CLI：drag <src> <dst>）。
    case 'drag': return ['drag', target, requireString(payload.value, 'drag 需要 value（目标 ref 或选择器）')]
    // `wait` 的参数是"选择器或毫秒数"：优先 value，其次 target（真机踩过：把 ms 硬塞进 ref 很难看）。
    case 'wait': return ['wait', requireString(payload.value ?? (target === '' ? undefined : target), 'wait 需要 value（毫秒数，如 800，或选择器）')]
    default: throw new CliError('bad-request', `不支持的动作 "${action}"`)
  }
}

function requireString(value: string | undefined, message: string): string {
  if (value === undefined || value === '') throw new CliError('bad-request', message)
  return value
}

function requireValues(values: readonly string[], action: string): string[] {
  if (values.length === 0) throw new CliError('bad-request', `${action} 需要至少一个 value`)
  return [...values]
}

function withValue(args: string[], value: string | undefined, action: string): string[] {
  return [...args, requireString(value, `${action} 需要 value（要填入的文本）`)]
}
