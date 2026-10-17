# 给 dsh-judgment 的联合改动说明（来自 dsh-agent-browser）

> 用途：本文件是**跨会话交接**。agent-browser 这个会话无法直接给另一个会话发消息
> （`send_message` 只认 teammate target，session id 不是 target），所以把需要对齐的
> 接口与实测数据写在这里，由 dsh-judgment 的会话读取后回复/改动。

## 1. 我们现在依赖的接口（**都已支持，不需要改**）

| 依赖 | 用法 | 现状 |
|---|---|---|
| `ctx.get('judgment')` | 可选服务；不存在时 `browser_run` 调用时抛 `judge-unavailable` | ✅ |
| `judge.apiVersion` | 与 `EXPECTED_API_VERSION` 比对，不匹配显式降级 | ✅ |
| `judge.status().purposes[]` | 开启「决策」前判定 `browser.action` 的 `usable`（零 I/O） | ✅ |
| `judge.ask(state, questions, { purpose })` | 一次批量 3 个问题（goal_done / stuck / choice） | ✅ |
| `JudgmentError.code === 'invalid-response'` | 消费者把它当"新采样"处理：缩候选（24→16→8）重试 | ✅ |

## 2. 实测数据（供判断层校准）

- 本机连接：`typesafe / decision-model-preview`，用途 `browser.action`。
- **状态**：页面内抽取后的紧凑候选（`[idx, role, name, covered, state]`），~890 tokens（fixture）/
  ~2.9k tokens（hao123）。
- **选项数与质量**（每目标 6 次采样）：

  | 选项上限 | 命中率 | 不合法率 | tokens/次 |
  |---|---|---:|---:|
  | 10 | 5/5 | 0/6 | 2,879 |
  | 16 | 4/5 | 0/6 | 3,026 |
  | 40 | 3/5 | **6/6（一个目标全被拒）** | 3,689 |

- 典型拒绝原因（原文）：`答案 "action" 的概率和 0.95 偏离 1 超过容差 0.02`
  —— 系统性欠归一（0.95–0.98），与选项数正相关。
- 延迟：单次 `ask` ~210–350 ms（你们的文档里 TypeSafe 中位 178 ms）。

## 3. 可选的三项改动（按价值排序，都不阻塞我们）

### A. 用途预设/文档（小，收益确定）
给 `browser.action` 一个**推荐的用途名与配置片段**（例如 README 里的示例 + 一个
`purposes: { browser.action: { connection: <id> } }` 的模板），避免每个消费方手改 YAML。
我们这边已经在 `checkJudgment()` 里提示"去「设置 → 决策」配连接"，如果官方有推荐名，
提示文案可以直接对齐。

### B. `invalid-response` 的结构化细节（小，收益确定）
现在只能从 `error.message` 里正则/展示"概率和 0.95"。如果错误对象带结构化字段：

```ts
interface InvalidResponseDetail {
  question: string          // 'action'
  optionCount: number       // 40
  sum: number               // 0.95
  tolerance: number         // 0.02
}
// JudgmentError.detail?: InvalidResponseDetail
```

消费者就能**确定性地**决定"缩到多少选项重采"，而不是靠固定阶梯。对我们就是把
24→16→8 的猜测换成 `nextCap = max(4, floor(optionCount / 2))` 之类的规则。

### C. `HostModelJudge`（大，可选）
契约注释里已经描述了它（"消费者内置、零依赖，把候选交给宿主 LLM"），但仓库里没有实现。
如果 dsh-judgment 发布这个 adapter，我们可以在**没有 Jev 连接**时显式降级（用户可选，
消耗主模型 tokens）。注意：这会改变本插件"判断层不花主模型 token"的卖点，所以必须是 opt-in。

## 4. 明确**不需要**的改动

- 放宽分布校验（容差）—— 那等于"修复答案"，违反契约 §9.5；
- provider 内部静默重试 —— 契约 §10.2 明确"重试 = 新采样，是消费者的决定"；
- 默认值/兜底答案 —— §13.2 铁律。

## 5. 我方下一步（不依赖 dsh-judgment）

1. `browser_run(goal, inputs: {...})`：调用方一次给字段值，消掉每字段一轮 `runTask`；
2. 状态守卫：goal 动词 + 候选状态（已勾选/当前值）→ 已满足的候选不进判断层，避免反复切换。
