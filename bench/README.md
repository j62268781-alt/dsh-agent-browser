# bench/ — 任务基准（带 ground truth）

量"**有没有真的做对**"，而不只是时间和 token。

```bash
pnpm bench:tasks                    # 默认 tier=offline,base
pnpm bench:tasks:offline            # 只跑本地 fixture（离线、可重复、不依赖网络）
node bench/run.mjs --tier base --only ti-dropdown,wiki-link
node bench/run.mjs --tier hard --verbose

# 选 judge 连接（Settings → 决策 里可以配多条；不传就用第一条）
node bench/run.mjs --connection typesafe

# 复用浏览器（默认 --session default：接你已经开着的那扇窗口，不冷启动）
node bench/run.mjs --session dsh-ab-bench     # 另起/复用一个具名会话
node bench/run.mjs --cdp 9222                 # 接一个指定 CDP 端口
node bench/run.mjs --close                    # 跑完关掉（默认不关，下次直接复用）
node bench/run.mjs --no-isolate               # 关掉每任务 storage 清理（对照实验用）
node bench/run.mjs --task-timeout 120000      # 单任务看门狗（默认 180s）

# 把结果打成可读的账（总览 / 按类别 / 失败清单）
node bench/report.mjs bench/results/baseline-3.json
```

结果写到 `bench/results/run-*.json`（含每个 step 的状态、断言真值、调用数、tokens、耗时）；
有 false-done 时进程退出码为 1。

## 任务从哪来

全部是**移植**，不是自造（MIT，出处见 `tasks.mjs` 头部注释）：

| tier | 来源 | 特点 |
|---|---|---|
| `offline` | `browser-use/jev-ultrafast` 的酒店 fixture；`jkudish/jev-browser` 的 login/select fixture；自建 `lazy.html`（加载页）/ `dense.html`（251 元素稠密页） | 本地 HTML，**不依赖网络**，适合回归 |
| `base` | `Ying-Kai-Liao/jev-browser` 的 `bench/tasks.mjs`（25 条） | 真实站点，每条 step 带页面内 JS 断言 |
| `hard` | 同上（iframe / shadow DOM / react-select / 新标签页 / 滚动 / 拖拽 / 负例） | 已知难点，用来暴露能力边界 |
| `guard` | 同上 | 不可逆动作暂停：登录/提交不该停、Finish 必须停 |

任务措辞与断言原样保留（改了就没法和他们的结果对照）；`context-menu` 与 `upload`
因本插件不暴露事件/文件上传而标了 `skip`。

## 评分口径（`score.mjs`，有单测）

本插件的循环**从不自称 done**：做完时返回 `needs_verification`（交回宿主验证），
不确定时返回 `likely_done`。两者都算"声称完成"，分开统计。

| 断言 | 状态 | 判定 |
|---|---|---|
| 真 | `needs_verification` / `likely_done` | **correct** |
| 真 | 其他（`no_progress`/`budget`/`ambiguous`…） | **missed**（假阴性：其实做到了但没敢说） |
| 假 | `needs_verification` / `likely_done` | **false done**（最危险，必须为 0） |
| 假 | 其他 | 正确地没完成（负例任务靠这个） |

`expect: "fail"` 的任务不允许声称完成；`expectStatus` 覆盖某一步的期望状态
（目前只有 `guard-checkout` 用 `needs_confirmation`）。

## 导航诊断与任务态隔离（2026-10-21，OPTIMIZATION-PLAN §0.7 0A/0B）

复用的标签会把上一条任务的状态带进下一条；TodoMVC 用 `localStorage` 持久化列表，
重复运行会互相污染（todomvc-fine 出现过 false-done）。现在每个任务起始会做两件事，
全部由 `bench/nav.mjs` 实现、**只做诊断**（不送模型、不参与 `score.mjs` 的
correct / false-done 判定）：

1. **0B 导航证据**：`open` 前后记 `url_before_open` / `url_after_open`；`waitForReady`
   之后**再次**读 URL（`url_after_ready`），再做有界稳定性轮询（默认最多 3 次 ×120ms，
   不是固定长 sleep）得到 `url_settled` / `url_polls` / `url_changed_during_ready` /
   `url_changed_after_ready`。`diagnosis` 区分 `host_mismatch` / `url_unstable` /
   `late_navigation` / `same_host_other_path` / `ok`。判定口径不变：**只核对 host**
   （`/secure → /login` 这类重定向是任务场景本身），path/query/hash 差异只记诊断。
2. **0A storage 隔离**：清理**该 benchmark 来源**的 `localStorage`/`sessionStorage` 并
   `reload`。安全门：目标必须是 http(s) 且 origin 在任务集 allowlist 里、当前页必须
   已经在该 origin 上；`file://` 一律拒绝（Chrome 的 file origin 可能与其他本地页面
   共享 storage）。证据在 `record.nav.storage`：before/after key 列表、`storage_cleared`、
   `reloaded`、`initial_dom.digest`。`--no-isolate` 可关掉（对照实验用）。

每个 step 还记录 `nav.url_before_runTask / url_after_runTask / url_before_assert /
url_after_assert`，并把 `runTask` 的 `result.steps` 裁剪成
`resultSteps: [{ step, origin, action, executed, reason, digest }]`。

结果 JSON 顶层多了 `navSummary`（各类导航问题计数）与 `initialStability`：
repeat>1 时对同一 task 的 `initial_dom.digest` 做比对，直接给出"storage 隔离可重复"
的证据（打印为 `初始态可重复：N/M 个任务`）。

## 已知局限（别把结论读大）

- **真实站点会漂移**：`base`/`hard` 依赖 herokuapp / wikipedia / github 的当前 DOM；
  站点改版会让任务失败，而不是插件退化。可重复的是 `offline`。
- **顺序执行**：一个 agent-browser 会话跑一条任务，先 `close()` 再 `open()`；
  和 ykl 的 3 并发不同，所以总耗时不可直接对比。
- **登录类任务用公开测试站点的公开账号**（tomsmith / standard_user），不含真实凭据。
- 断言是我们唯一承认的 ground truth；断言写弱了会低估错误（见 `fixture-hotel`
  最初用 `innerText.includes('Casa Flora')`，而卡片列表里本来就有这行字——已收紧成 hash）。

## P0 回归（2026-10-19）

`bench/fixtures/lazy.html` 与 `dense.html` 是为首轮失败模式定制的回归页：

- `fixture-dense`：目标链接在第 251 个元素、且首屏之外 → 验证"抽取 300 + 离屏保留 + 候选预算"；
- `fixture-lazy`：点 Start 后 3 秒才出结果 → 验证"自适应 wait + 加载门"。
  **仍失败**：极简页上判断层不认结果（goal_done 0.35），会把 Start 再点一次；这是已知缺口，
  保留为 failing test，别为了让数字好看而删。

## P1 后仍失败的（v0.1 基线）

- `hn-comments`：goal 词 "comments" 同时命中导航链接和 story 的评论链接，判断层选导航；
  已加 `near` 上下文 + "具体条目 vs 导航"提示词 + 确认时的 target_match 复核，仍误判 → 记在模型能力账上。
- `ti-checkboxes`：同一代码多次运行结果不一致（有时 4 次判断通过，有时 false-done）→ 稳定性问题。
- `webform`：多字段 + 提交，判断层中途 ambiguous → 与"有序子目标"同类，按 ykl 的结论应拆成多步。
