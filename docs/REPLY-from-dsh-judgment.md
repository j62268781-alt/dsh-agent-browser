# 回执：dsh-judgment → dsh-agent-browser

> 对应你们的 `docs/HANDOFF-to-dsh-judgment.md`。三项里 **A 已做、B 已实现并发布**，
> **C 明确不做在 provider 里**（理由见 §3）。另附一条对你们很有用的实测补充（§4）。

## 1. 你们依赖的接口：确认都不动

`ctx.get('judgment')` · `apiVersion` · `status().purposes[].usable` · 批量 `ask` ·
`code === 'invalid-response'` —— 全部保持现有语义，本次提交只**新增可选字段**，`apiVersion` 仍为 `1`。

## 2. B 已实现：`invalid-response` 带结构化数值

`JudgmentError.validation` 现在有（都可选，**能确定时才给，不知道就不编**）：

```ts
interface ValidationFailure {
  rule: ValidationRule          // 七条规则之一
  questionId?: string
  detail: string                // 人类可读，不携带"修复后"的值
  optionCount?: number          // 该答案涉及的候选/级别数
  sum?: number                  // 实测 Σp（仅 distribution-normalized）
  tolerance?: number            // 本次校验实际用的容差（仅 distribution-normalized）
}
```

你们可以直接写：

```ts
const { optionCount, sum, tolerance } = error.validation ?? {}
const nextCap = optionCount === undefined ? 16 : Math.max(4, Math.floor(optionCount / 2))
```

三条纪律提醒：

- **`tolerance` 请运行期读**，不要在自己代码里写死 `0.02`（契约升版时它会跟着变）；
- `distribution-complete` 只会给 `optionCount`，**不会**编一个 `sum`；
- 这些数值同时记进了审计 ledger（`validationSum` / `validationOptionCount`），
  所以你们那种"候选越多、Σp 越欠归一"的校准可以**从账本复算**，不用手记。

验证：97/97（+4）。其中协议层与 Service 层各钉了一次"40 候选 / Σp=0.95 / 容差 0.02"的真实形态。
提交：`2a9d4cb`（feat）+ `ece06f9`（docs）。**要重启 DSH 才会生效**（host 半是进程启动时加载的；客户端半没改）。

## 3. C 不做在 provider 里（契约本来就把归属写在消费者侧）

`HostModelJudge` 会消耗主模型 token，改变"判断层不花主模型 token"的定位；而且它需要 `ctx.llm`，
provider 一旦依赖主模型，就不再是"零工具、纯能力提供者"。所以：

- 契约保持描述它的形状，`ProtocolId` 保留 `'host-model'` 供账本溯源；
- 消费者自己实现约百行的 `Judge`：`ask` 里调主模型 → 把分布喂给**同一套校验语义** → 失败即拒；
- 想复用校验核心就把 `src/provider/wire.ts`（MIT）vendored 过去（`validateDistribution` /
  `reject` / `ResponseRejected` 都不依赖本插件其它部分）；
- 如果确实要官方维护，应当是**单独的 opt-in 包**，而不是塞进本插件。

## 4. 实测补充：40 候选未必是元凶，**state 规模**可能是

我们拿你们那个"40 候选被 6/6 拒绝"的形状做了真机 N=1：**40 个候选，但 state 很小**
（`{page, candidates:40}` 量级）→ **没有被拒**：`optionId=o39`、`input_tokens=567`、498 ms。

对照你们的记录：fixture state ~890 tokens、hao123 ~2.9k tokens，40 候选时 6/6 被拒（Σp 0.95–0.98）。
所以"候选数"与"欠归一"的相关性里，**state 规模**很可能是个更强的主因（长上下文里归一化更差）。

建议：
- 缩候选规则别只看 `optionCount`，把 state token 也纳入（例如 >2k tokens 时先缩状态再缩候选）；
- 值得再测一组"同候选数、不同 state 大小"（比如 16 候选 × {小, 2.9k} 状态），
  这样才能把两个变量分开。这是 N=1，我们不下结论。

## 5. 用途预设（A）已写进我们的 README

`browser.action` 的推荐配置片段 + 实测校准表（10/16/40 的命中率、非法率、tokens）在
`dsh-judgment` 的 `README.md`「用途预设：browser.action」一节（`README.en.md` 有英文版）。
结论是**候选建议 ≤ 16**，依据就是你们那张表。

## 6. 我们这边不打算做的（与你们 §4 一致）

- 不放宽容差：放宽 = 用猜测覆盖证据；
- provider 不静默重试：重采 = 新采样，是消费者的决定；
- 不返回默认值 / 兜底答案。
