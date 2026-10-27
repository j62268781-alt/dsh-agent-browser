# 变更日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)，
变更记录格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.1.0] - 2026-10-27

首个可用版本。

一句话：把浏览器自动化做成 DSH 里的**窄工具面 + 确定性门控**，而不是再包一个宽到
没边的 MCP 服务器——工具只在「浏览器功能」开着时才进模型上下文，关掉就是零成本。

数字来自本机实测（macOS / agent-browser 0.38.2，部分项 0.39.1 复验）：

| 指标 | 值 |
|---|---|
| 常驻工具 | 6 个（`browser_run` 是第 7 个，决策开着才注册） |
| 单测 | 201 项全绿（`pnpm test`） |
| 真机任务基准 | 39 个任务，`false-done = 0` |
| CLI 版本要求 | `agent-browser >= 0.38.2`，不设上限 |
| 每次判断的 state | 页面内抽取后从 4.3k tokens 压到 ~1.1k |
| 原生二进制 vs PATH 包装脚本 | `--version` 3.1ms vs 57.3ms |

### 新增

**工具面**

- 窄核心 6 件套：`browser_snapshot`（无障碍树 + `@eN` refs）、`browser_act`（**唯一变更入口**，
  一次一个动作）、`browser_read`（markdown / llms.txt 协商、或读元素 text/html/value/attr/
  title/url/count）、`browser_session`（open/close/tabs）、`browser_screenshot`、`browser_raw`。
  拆成"只读"和"唯一变更入口"是为了让每次页面改动都有单一可审计的路径。
- `browser_act` 支持 12 个动作（click / fill / type / press / select / scroll / hover / check /
  uncheck / upload / dblclick / focus），并可带 `expectUrl` / `expectName` 做**执行前**的新鲜度
  断言——同名列表/批量删除那种"点错隔壁"的场景靠它兜。
- `browser_raw` 逃生舱：白名单内的其它 CLI 子命令（`get` / `find` / `network` / `storage` …），
  禁 `mcp` / `chat` / `install` / `plugin` / `connect` / `auth` / `--cdp` / `--profile`，默认关。
- 固定命名会话（`browser.session` 留空时按 profile 派生），**不劫持**别的 agent 或人开着的窗口。
- 原生二进制自动解析：PATH 上的 `agent-browser` 其实是 Node 包装脚本（Homebrew / npx 都如此），
  每次调用白付一份 Node 启动；插件默认解析到同目录的 `agent-browser-<platform>-<arch>`，
  砍掉 11–15 倍启动开销，`brew upgrade` 后旧路径失效会自动重解析重试一次。
- 每步用 `batch` 把原本 3 个进程压成 1 个——CLI 调用不是瓶颈（决策循环里一步约 22ms，
  一次判断是 500ms 量级），但攒起来仍值得。

**`browser_run`：有界决策循环**

- 一句话 goal → 插件内部循环 → `trace` + handoff；支持 `inputs`（一次给全字段值）、
  `subgoals`（有序子目标）与 `allowIrreversible`。
- **确定性门控优先，判断只做排序**：域名白名单、不可逆拦截（`needs_confirmation`）、
  状态守卫（已勾选不再反点）、Enter 消费防重填、先填后点，全部由代码执行，不交给模型。
- **页面内抽取**（一次 `eval` 拿齐可见元素、状态、附近上下文 + 正文/标题/URL；必要时回退
  a11y 树）：判断层只收"可信的少数"，每次判断的 state 从 4.3k tokens 降到 ~1.1k。
- **Jev + 上游 LLM 低成本交回闭环**：Jev 擅长的确定性步骤在单次工具调用内跑完；遇到自定义
  组件或置信不足（`ambiguous` / `no_progress` / `blocked` / `page_error` / `input_required`）
  就**立即早停**，并在返回值里附带前 5 个可操作 `candidates`（含 `ref` 句柄）与 `pageText`
  摘要——上游主模型不用再调一次 `browser_snapshot`，直接用 `browser_act` 一步接管。
- 首选动作无效时，只有**次优候选概率 p ≥ 0.25** 才允许换路，否则早停交回（绝不盲点跳走）。
- 多字段批量填与合并的 `target_match` 确认；native select 两阶段、自定义 combobox、
  模态框/勾选/结账类收尾都有专门处理。
- 等待改成**事件驱动**而不是固定 sleep：点击跳转实测 850–1150ms，就绪门用有界等
  `document.readyState=complete` 替代固定 250ms。
- 点击前先把元素滚进视口——折叠线以下的 CDP click 会"成功但什么都不发生"。
- 敏感字段（文字/密钥）不猜：由 `inputs` 传入，回显自动脱敏为 `●●●`，绝不写进 trace；
  缺值时以 `input_required` 交回宿主。
- 结束语是 `needs_verification` 而不是"已完成"，最终校验留给宿主（39 任务基准 `false-done = 0`）。
- **降级必须显式**：没有 `ctx.judgment`、用途名未配置、密钥缺失、配额耗尽，都走类型化失败
  加明确文案，绝不静默退回主模型假装在决策。

**设置页与安装自检**

- 安装自检收敛成**两项**（agent-browser / Chrome），进页面自动跑一次；通过时按钮是灰色
  「已安装」，不通过才可点「检查安装」。
- CLI 可以**帮忙装**（Homebrew 优先、`npm i -g` 兜底，点了才跑）；Chrome 只给命令与链接——
  `brew install --cask google-chrome` 要管理员密码，后台进程挂着等密码是最糟的交互。
- Chrome 判定优先用 CLI 自己的 `agent-browser doctor --quick --json`（约 0.5s，认得环境变量、
  engine 与自定义路径），CLI 不可用时退回文件系统/PATH 探测，消息写「没找到」而不是「没有」。
- Remote 通路**零代码生成**：host 侧 `TypertRemoteService` + `@Remote` 暴露
  `probe` / `installCli` / `checkJudgment`，客户端半是手写的 contribution，靠 Gateway 的
  SRC fallback 现推 descriptor。`pnpm verify:remote` 用真的 host + gateway 交叉验证两端的
  `wire` 名与实参个数（少传一个实参会得到 `expected 1 argument(s), got 0`，是踩过的坑）。

**内置 skill**

- 插件自带一份与已装 CLI 版本对齐的核心 skill：`SKILL.md` 加 5 份 references
  （`commands.md` / `snapshot-refs.md` / `session-management.md` / `authentication.md` /
  `trust-boundaries.md`），启动时用 `ctx.skills.register()` 注册成运行时 skill，装插件即得。
- 只在末尾**追加**一段插件补充（工具名、`browser_run`、references 路径），SKILL.md 原文逐字不改，
  避免两份真相漂移。`ctx.skills` 是可选服务，宿主没装 `dsh-skill` 时跳过注册，其余照常工作。

### 修复

- **peer 依赖从精确版本改成区间**。曾经把 `@deepseek-ai/dsh-typert-protocol` 钉成精确版本，
  app 升版后整个插件被判 `incompatible-version`：后果不是"少个功能"，而是 bundle 的 rows 变成 0
  → 插件根本不被组合，设置页整块消失，看上去像"插件坏了"。`tests/package.test.mjs` 现在把这条
  纪律钉住（peer 只允许区间，devDependency 不得低于 peer 下限）。
- **所有配置字段改成 `.volatile()`**，修好「设置页点了没反应」——非 volatile 的配置在
  热组合时会被判为不可变，写入直接被丢弃且不报错。
- **「决策」开启前先问宿主 `ctx.judgment` 在不在**（四态），不再等到第一次调用才炸；
  dsh-judgment 缺失时 `browser_run` 直接不注册，并给出可执行的修法。
- 打开面板不再闪红字；首次自检出结果之前什么都不显示。
- `close` 返回不等于守护进程已退出——`browser_session close` 后补落地判定，`open` 加落地
  等待与自愈，e2e 连跑 3 次全绿。
- 陈旧 ref 的错误文案里 `Could not locate …` 也按 stale 处理（不再误报成未知错误）。

### 已知限制

- ref 大部分时候是元素身份绑定的，但**目标元素消失且页面上还有同名元素**时，CLI 会退回
  role+name 的序位匹配，**静默点到隔壁那个同名元素**。插件因此不设 `snapshot_id` 强制门控，
  而是每步重取 snapshot 消除决策窗口，并对同名列表建议显式给 `expectName`。详见
  [DESIGN.md](DESIGN.md) §1.1（含复现命令）。
- 同一个命名会话是**串行**的：并发调用会排队，不会互相抢页面。
- iframe 内的抽取受上游限制，能力边界见 DESIGN §1.1。
- 动作审计落盘与配额可视化还没做（DESIGN §8，M3）。

### 安装

```bash
dsh plugin --profile desktop add @j62268781-alt/dsh-agent-browser
```

包名带 scope 是因为无 scope 的 `dsh-agent-browser` 在 npm 上已被他人占用。
`agent-browser` 本身要单独装（`brew install agent-browser`，需 ≥ 0.38.2）。

[Unreleased]: https://github.com/j62268781-alt/dsh-agent-browser/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/j62268781-alt/dsh-agent-browser/releases/tag/v0.1.0
