/**
 * `src/task/types.ts`：决策循环的公共类型、阈值常量与状态契约。
 */

import type { Judge } from 'dsh-judgment/contract'
import type { AgentBrowser, Snapshot } from '../cli.js'

/** 本插件编译时对齐的契约版本。不匹配就降级（dsh-judgment 契约 §13.3）。 */
export const EXPECTED_API_VERSION = 1

/** 点击候选上限（实测可答上限）。 */
export const MAX_CLICK_CANDIDATES = 40

/** 一次判断最多送多少个候选。 */
export const JUDGE_OPTION_CAP =
  Number(process.env.JEV_OPTION_CAP ?? '') > 1 ? Number(process.env.JEV_OPTION_CAP) : 10

/** 状态里快照文本的上限（字符）。 */
export const SNAPSHOT_STATE_CAP = 6_000

/** `goal_done` 之后的独立确认阈值。 */
export const GOAL_CONFIRM_THRESHOLD = 0.8
/** 登录墙判定阈值（ykl 用 0.7）。 */
export const LOGIN_THRESHOLD = 0.75
/** 「点的控件是不是目标对象」的阈值：低于它就否决确认（同名导航链接）。 */
export const TARGET_MATCH_THRESHOLD = 0.6

/** 确认问题里正文的截断长度。 */
export const CONFIRM_TEXT_CAP = 2_000

/** 同一个字段"填了又被站点清空"时最多重填几次（有界，避免与站点脚本拉锯）。 */
export const MAX_REFILLS = 2

/** 一次二阶段 select 最多送多少个选项。 */
export const SELECT_OPTION_CAP = 20

/** diff 列表每类最多保留几条。 */
export const DIFF_ITEM_CAP = 4

/** 页面可见正文的最短有效长度。 */
export const MIN_PAGE_TEXT = 40

/** 页面报错的判定阈值。 */
export const PAGE_ERROR_THRESHOLD = 0.8
/** goal_done 的"中间带"下界。 */
export const LIKELY_DONE_FLOOR = 0.6
/** 中间带里独立确认到这个概率才算 likely_done。 */
export const LIKELY_CONFIRM_FLOOR = 0.6
/** 一次 task 里最多等几轮（每轮最多 6s）。 */
export const WAIT_BUDGET = 3
export const AMBIGUOUS_CONFIDENCE = 0.45
export const AMBIGUOUS_GAP = 0.15
/** 不可逆动作的判定阈值。 */
export const IRREVERSIBLE_THRESHOLD = 0.7

/**
 * 次优候选换路的**最低概率底线**：
 * 首选动作无效时，如果分布里的次优候选连 0.25 都不到（例如 todomvc-fine 里 p=0.06 的外链），
 * 说明 Jev 已经不知道该点谁——此时绝不乱点破坏现场，直接停下交回上游 LLM 决策。
 */
export const ALTERNATE_MIN_PROBABILITY = 0.25

export const MIN_JUDGE_OPTIONS = 4
/** 一次决策最多重采几次。 */
export const MAX_RESAMPLES = 3

/** 永远存在的控制项（保证 choice 选项数 ≥ 2）。 */
export const CONTROL_CANDIDATES: readonly TaskCandidate[] = [
  { id: 'control:scroll_down', description: '向下滚动一屏（看更多内容）', kind: 'control' },
  { id: 'control:scroll_up', description: '向上滚动一屏', kind: 'control' },
  { id: 'control:back', description: '返回上一页（这条路走错了）', kind: 'control' },
  { id: 'control:wait', description: '页面还在加载：等一会儿再观察一次', kind: 'control' },
  { id: 'control:press_enter', description: '按 Enter 键（提交刚填的输入框 / 确认搜索或新建）', kind: 'control' },
]

export const CLICKABLE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'switch', 'option', 'combobox', 'textbox', 'searchbox',
])

export const TEXT_ENTRY_ROLES = new Set(['textbox', 'searchbox', 'input', 'textarea'])

/** goal 里的"开启/关闭"动词：状态守卫用（已处于目标状态就不必再点）。注意用整词边界避免 `checkbox`/`unchecked` 误命中 `check`，`complete` 需带 `mark` 避免误命中 "Show only the completed todos"。 */
export const ENABLE_VERBS =
  /(\benable(?:d)?\b|\bcheck(?:ed|ing)?\b|\btick(?:ed)?\b|\bturn on\b|\bactivate(?:d)?\b|\bmark\b[^.]{0,50}\bcomplete(?:d)?\b|打开|开启|(?<!取消)勾选|选中|启用)/i
export const DISABLE_VERBS =
  /(\bdisable(?:d)?\b|\buncheck(?:ed|ing)?\b|\buntick(?:ed)?\b|\bturn off\b|\bdeactivate(?:d)?\b|取消勾选|关闭|禁用)/i

/** 目标是"搜索/查找"：这类目标填完搜索框之后，Enter 就是提交搜索的确定性语义。 */
export const SEARCH_GOALS = /\b(search|find|query|look ?up)\b|搜索|查询|查找|检索/i

/** 目标是不是明确的导航目标（"打开/进入/跳到某页面"）。 */
export const NAVIGATION_GOALS = /\b(open|go to|goto|navigate|visit|follow|jump to)\b|打开|访问|进入|跳转|前往|点开/i

/** 目标里出现这些词 = 填完值之后还要再做一步（提交/搜索/登录/添加…），不能按"值已生效"收尾。 */
export const FOLLOW_UP_VERBS =
  /\b(submit|log ?in|sign ?in|sign ?up|search|find|open|click|press|continue|checkout|order|buy|add|create|save|apply|send|confirm|delete|remove|go to|navigate)\b|提交|登录|注册|搜索|查询|查找|打开|点击|按下|继续|结账|下单|购买|添加|新建|保存|应用|发送|确认|删除|移除|跳转/i

/** 「点一下就等于提交/搜索/继续/完成/清空」的控件动词。 */
export const SUBMIT_CONTROL_VERBS =
  /(submit|search|find|apply|log ?in|sign ?in|continue|next|save|confirm|send|finish|checkout|order|pay|clear|提交|搜索|查找|登录|确认|发送|保存|继续|下一步|结算|下单|支付|完成|清空|清除)/i

/** 看起来是密钥/凭据的字段名：只把 key 交给判断层，值绝不出门。 */
export const SECRET_KEY = /(password|passwd|passcode|pw|secret|token|otp|card|cvv|cvc|ssn|api[_-]?key|pin|密码|口令|验证码|身份证)/i

/** 页面处于异步加载中的文本标记（含 ti-dynamic-controls 的 "Wait for it..."）。 */
export const LOADING_TEXT_MARK =
  /(loading\.{2,}|loading…|wait for it\.{2,}|加载中|请稍候|处理中|please wait|searching\.{2,}|fetching|submitting)/i

export type TaskStatus =
  | 'needs_verification'
  | 'blocked'
  | 'no_progress'
  | 'budget'
  | 'input_required'
  | 'judge_error'
  | 'action_error'
  | 'needs_confirmation'
  | 'page_error'
  | 'likely_done'
  | 'ambiguous'
  | 'needs_login'

export interface TaskCandidate {
  readonly id: string
  readonly description: string
  readonly kind: 'click' | 'control' | 'input'
  readonly ref?: string
  readonly role?: string
  readonly name?: string
  readonly state?: string
  readonly options?: readonly { readonly label: string; readonly value: string }[]
  readonly near?: string
  readonly tag?: string
  readonly targetRef?: string
  /** 语义区域：`true` = 主内容区，`false` = 全局导航/页头/页脚。 */
  readonly inMain?: boolean
}

export interface TaskStep {
  readonly step: number
  readonly phase?: number
  readonly origin: string
  readonly digest: string
  readonly action: string
  readonly executed: boolean
  readonly reason: string
  readonly goalDone?: number
  readonly stuck?: number
  readonly confidence?: number
  readonly stateChanged?: boolean
  readonly alternateOf?: string
  readonly confirm?: number
}

export interface TaskTimings {
  readonly snapshotMs: number
  readonly readMs: number
  readonly titleMs: number
  readonly askMs: number
  readonly actMs: number
  readonly totalMs: number
}

export interface TaskResult {
  readonly status: TaskStatus
  readonly reason: string
  readonly steps: readonly TaskStep[]
  readonly trace: readonly string[]
  readonly url: string
  readonly usage: {
    readonly calls: number
    readonly inputTokens: number
    readonly outputTokens: number
    readonly estCostUsd: number
  }
  readonly timings: TaskTimings
  /**
   * 交回上游 LLM 时的现场候选（带 `ref` 句柄，主模型可直接用 `browser_act` 执行，无需再取一次 snapshot）。
   */
  readonly candidates?: readonly { readonly id: string; readonly description: string; readonly ref?: string }[]
  /** 交回上游 LLM 时的页面可见正文摘要。 */
  readonly pageText?: string
  readonly next?: string
}

export class JudgeUnavailableError extends Error {
  readonly code = 'judge-unavailable'

  constructor(message: string) {
    super(message)
    this.name = 'JudgeUnavailableError'
  }
}

export interface TaskDeps {
  readonly browser: AgentBrowser
  readonly judge: Judge | undefined
  readonly purpose: string
  readonly maxSteps: number
  readonly goalThreshold: number
  readonly stuckThreshold: number
  readonly signal: AbortSignal
  readonly inputs?: Readonly<Record<string, string>>
  readonly allowIrreversible?: boolean
}

export interface TaskSubgoal {
  readonly goal: string
  readonly inputs?: Readonly<Record<string, string>>
}

export type LastChange = Record<string, boolean | string[]>

export interface ValidationNumbers {
  readonly optionCount?: number
  readonly sum?: number
  readonly tolerance?: number
}

export type { Snapshot }

/** 结束状态 → 交回宿主的下一步提示。 */
export const NEXT_HINTS: Readonly<Record<TaskStatus, string>> = {
  needs_verification: '这不是"已完成"：用 browser_read / browser_snapshot 独立确认最终结果，再用 expectUrl / expectName 断言关键身份。',
  blocked: '页面卡住了：直接看返回的 candidates（含 ref）与 pageText，用 browser_act 接管下一步。',
  no_progress: '动作重复或次优候选置信不足：直接看返回的 candidates（含 ref）与 pageText，用 browser_act 接管这一步。',
  budget: '达到步数上限：直接看返回的 candidates（含 ref）与 pageText，用 browser_act 继续。',
  input_required: '需要你提供要输入的内容：用 browser_act fill 填进去，或带 inputs 重新调用 browser_run。',
  judge_error: '判断层出错：检查「设置 → 决策」里的连接与凭据，或直接用 browser_act 接管。',
  action_error: '动作执行失败：看 trace 里的错误信息；必要时用 browser_snapshot 重新观察页面。',
  needs_confirmation: '下一步可能不可逆（下单/支付/发送/删除）：确认用户确实要这么做，再带 allowIrreversible 重新调用。',
  needs_login: '页面要求先登录/注册：让用户登录（或用 browser_act 填凭据）后，再重新调用 browser_run；不要自己猜账号。',
  page_error: '页面显示了错误：读返回的 pageText 确认原因（例如密码错误、表单校验失败），修正后再继续。',
  likely_done: '看起来已经完成但不十分确定：先用 browser_read / browser_snapshot 验证，再决定要不要继续。',
  ambiguous: '判断层在几个候选之间分不清：看 candidates（含 ref），用 browser_act 直接指定其中一个，无需重取快照。',
}
