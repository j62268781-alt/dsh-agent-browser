# dsh-agent-browser · 技术方案 v2

> 状态：**定稿（可实现）**。形态已定：**DSH 插件**（host 半 + client 半设置页 + 转发 CLI skills）。
> 本文记录方式：结论 + **证据（文件/命令/行号）** + 明确标注的未验证项。不写"应该没问题"。
>
> **v1 → v2 改了三件事**（都在 §1，有实测证据）：
> 1. v1 的立身之本「refs 陈旧门控」**实测不成立**，撤下；
> 2. 「不用 MCP」的论证从「token 开销」换成「形态取舍」；
> 3. 定位从"薄封装工具面"改成"**一个 delegate 工具 + 插件内部有界循环**"。
>
> **v2.1 补充（都已实现并验证）**：内置 skill（§3.2）、安装自检 summary（§4.4）、
> 二进制定位改成**版本无关**（§3.1 第 2 条）。

---

## 0. 结论先行

| 项 | 定稿 |
|---|---|
| 形态 | DSH 插件（不是 skills 仓库、不是 MCP 配置） |
| 引擎 | **仍是 `agent-browser` CLI**（Rust + CDP），不碰 CDP、不引 Playwright |
| 工具面 | 窄核心（4 个常驻）+ 逃生舱 1 个；**决策开**才多注册 1 个 `browser_run` |
| 陈旧风险 | 由 CLI 的 **ref 身份绑定** 兜住（§1.1 实测）；我们**额外**提供**可选**的新鲜度断言，不做强制门控 |
| 决策 | **`ctx.judgment`（可选依赖，用途名 `browser.action`）**；缺失/未配置 → **显式报错**，不静默降级 |
| 设置页 | `settings.section` 一页：2 行开关 + 进阶项 + 「打开配置文件」；视觉照**通用设置面板**（标题 + 子标题） |
| 技能 | **内置** `skills/agent-browser/`（SKILL.md + references），用 `ctx.skills.register()` 注册 | 装插件即得 |
| MCP | 不配。理由见 §1.2 |

---

## 1. v1 哪三条是错的（附实测）

### 1.1 ❌「旧 ref 会默默点到别的元素」——**实测不成立**（本机 v0.38.2）

DESIGN v1 §2① 把"refs 可跨快照复用 → 旧 ref 指向另一个元素 → 唯一不可逆损害"当作**立身之本**。
本项目实测（headless、本地页、跑完 `agent-browser close --all`）：

| # | 操作 | 实测输出 |
|---|---|---|
| 1 | `snapshot`：Alpha `@e2` / Bravo `@e3` | 按树序分配 |
| 2 | 删掉 Alpha 后 `click @e2` | `✗ Unknown ref: e2`（**拒绝**） |
| 3 | 整页 `innerHTML` 替换后 `click @e3` | `✗ Could not locate element with role=button name=Bravo` |
| 4 | 三行**同名** `Delete` 把 Row3 置顶后 `click @e7` | `✓ Done`，log = `deleted row1` —— **仍指向原元素，不是位置** |
| 5 | 同名重复：删掉第一个 `Delete` 后 `click @e2` | `✗ Unknown ref: e2` —— **没有落到幸存的同名按钮** |
| 6 | `open` 另一页后 `click @e7` | `✗ Unknown ref: e7` |
| 7 | ref 编号 | **单调递增、永不复用**（e1–e3 → e4,e5 → e7–e9 → e10–e12） |

**结论**：refs 是**元素身份绑定**的；失效得到**类型化错误**，不存在"默默点到别的元素"这一类。
CLI 文档那句 `Refs can be reused across snapshots` 的语义是「同一元素在新快照里仍是同一个 ref」，**不是**「旧编号会被重新分配给别的元素」。

> 因此：`snapshot_id` **强制门控不是立身之本**，撤。
> 仍然剩下的唯一陈旧风险是**决策级**的：*模型 10 秒前看到的树，与此刻要执行的动作之间页面变了*（元素同一个，语义变了）。
> 对策见 §5：**每步重取 snapshot**（参考项目三家一致做法），并给 `browser_act` 一个**可选**新鲜度断言（断言不匹配 → `stale_page`，执行前拒绝）。

复现命令（无需 DSH 开启任何东西）：

```bash
# 建一个含 Alpha/Bravo 两按钮的本地页 → open → snapshot → 删 Alpha → click 旧 ref
agent-browser eval "document.getElementById('btnA').remove()" && agent-browser click "@e2"   # → ✗ Unknown ref
agent-browser close --all
```

**版本边界**：以上结论只对 `agent-browser 0.38.2` 成立（`/opt/homebrew/bin/agent-browser`）。所以插件对 CLI **版本加锁** `>=0.38 <0.39`，并在启动时校验版本，越界就明确报错而不是猜。

### 1.2 ❌「MCP 很吃 token」——方向对，但不是参考项目的结论

事实：
- `agent-browser mcp [--tools <profiles>]` 确实存在（默认 core，`--tools all` 是那面墙），会以 `mcp__<server>__<tool>` 全局进 prompt。
- 但**三个参考项目没有一个**是"因为 token 所以拒绝 MCP"：[jkudish/jev-browser](https://github.com/jkudish/jev-browser) 反而**以 MCP 为主接口**（首个 commit 就是 MCP），窄工具面的公开理由是"代码拥有循环 / 范围"（CONTRIBUTING.md:3）。

所以 v2 的论证换成**形态**：
MCP 的形态是"把 N 个原子动作交给模型，然后等服务端返回"——它**结构上做不到**我们要的：插件内部有界循环、每步新鲜度门控、动作审计、设置页。而参考项目已验证的两个窄形态是：**1 个 delegate 工具**（jkudish：`jev_navigate`）或 **0 工具 + skill**（[wy-coliney/jev-browser-use](https://github.com/wy-coliney/jev-browser-use)）。我们两样都给：转发 CLI skills + 1 个 `browser_run`。

### 1.3 ✅「插件内部做自己的决策」——方向正确，且契约已预留位置

[dsh-judgment](../../dsh-judgment/README.md) 的立场是原话：**「它判断，消费者决定」**，且 **loop 必须留在消费者**（README:7-8、:196-197）。
它的契约里已经写好了同一接口的**第二种实现**：`HostModelJudge`（"消费者内置，零依赖，把代码枚举好的候选交给宿主 LLM"，[contract/index.ts:629-633](../../dsh-judgment/src/contract/index.ts#L629-L633)），配置示例里也**已经预留用途名 `browser.action`**（[README.md:92](../../dsh-judgment/README.md#L92)）。

**所以本插件的角色 = 消费者 / loop**；`ctx.judgment` = judge。这条与 v1 §2③ 一致，v2 把它从"可选"提为**主路径**。

---

## 2. 参考项目「怎么接入决策」（全部读过源码）

| | [wy-coliney/jev-browser-use](https://github.com/wy-coliney/jev-browser-use) | [jkudish/jev-browser](https://github.com/jkudish/jev-browser) | [forvela/jev-agent-browser](https://github.com/forvela/jev-agent-browser) |
|---|---|---|---|
| 形态 | Codex **Skill**（无 package.json） | npm + CLI + MCP + library | npm CLI（`jev`） |
| 驱动浏览器 | 宿主 CUA 的 tab API（不 spawn 任何东西） | **Playwright**（不是 agent-browser） | **spawn `agent-browser` CLI** ← 唯一同路 |
| 决策在哪 | 循环在宿主 `cua_repl` 内，`fetch` 直连 Jev | 代码拥有循环（`navigate.ts`） | 代码拥有循环（`src/loop.js`） |
| 决策协议 | 1 个 `choice`（a0…aN + DONE/BLOCKED/WAIT） | `action` choice + `goal_done`/`stuck` noul（**fan-out 三问**） | `operation` choice + `*_target` choice(over refs) + `goal_reached`/`stuck` noul |
| 工具面 | **0 个新工具** | **恰好 1 个** `jev_navigate(task, start_url)` | CLI，0 个 MCP 工具 |
| 陈旧处理 | 决策后**重读 AX 逐字节比对**，变了就丢弃重决（`bridge.mjs:203-206`） | 每步重打 `data-jev-id` + 动作 4s 超时 + 记 `action_error` | **每步重新 snapshot 再决策**（旧 ref 无机会存在） |
| 交回宿主 | 文字输入 / 敏感动作 / 最终校验；`DONE → needs_verification` | `done/goal_achieved/stuck/...` | `input-required` + handoff/continuation/resume |
| 设置面板 | 无 | 无 | 无（[Ying-Kai-Liao/jev-browser](https://github.com/Ying-Kai-Liao/jev-browser) 只有声明式 `userConfig` 的 `{title, description}`） |

**三家共同点（直接决定我们的形态）**：

1. **决策全在插件/技能内部**，宿主只给 goal、候选枚举、授权、最终校验（jev-browser-use `SKILL.md:18`）。**没有一个**去调"宿主提供的判断服务"。
2. **文字输入不进决策面**（wy-coliney 的 `safeKeys` 白名单；jkudish 的 typing 用另一个模型且"Jev never generates text"；forvela 的 `input-required` 交回宿主）。
3. **停止门在动作之前判定**，且 `goal_done` / `stuck` 与动作选择是**互不可见的 fan-out 问题**——所以"目标达成"是对动作的真实交叉校验，不是动作的自我合理化（jkudish `questions.ts:10-12`）。

**能直接借的**：① `browser_run` 的 delegate-and-trace 形状（jkudish）；② 每步重取快照 + 执行前新鲜度比对（forvela / wy-coliney）；③ 文字输入交回宿主；④ 失败分类与 handoff（`needs_verification` 而不是"已完成"）；⑤ `usage`/耗时进结果；⑥ 网站内容是不可信数据，绝不作为指令。

---

## 3. 形态

| 层 | 用什么 | 说明 |
|---|---|---|
| 引擎 | **仍是 CLI** | 薄封装：`spawn` + `--json` 解析 + 版本锁；不碰 CDP |
| 主面 | `defineTool` + `ctx.tools.register`（`@deepseek-ai/dsh-tools`） | 与 dsh-judgment 相反：那个**零工具**，这个**工具为主** |
| 开关 | 配置 gate 注册：`enabled` 为假时**不注册**任何工具 | 注册/dispose 会改变 schema 前缀 → 关掉即 **prompt 零成本**（`dsh-tools` README:173） |
| 门控 | **CLI 自己的 `--allowed-domains`**（fail-closed：设了它就关掉 CDP / profile / 状态回放）+ `browser_raw` 的**子命令/参数拒绝表** | `ctx.tools.guard()`（单调 deny）留到 M3，把白名单从"这个工具内部"提到"整条工具流水线" |
| 可选 Service | `ctx.browser`（给其它插件用） | 首版可后置 |
| 技能 | **内置** `skills/agent-browser/`（SKILL.md + 5 份 references），`ctx.skills.register()` 注册成运行时 skill | 装插件即得；官方全量 skills 需要时仍可用 `agent-browser skills get <name>` 拉 |

### 工具清单（窄核心 + 逃生舱）

| 工具 | 作用 | 备注 |
|---|---|---|
| `browser_read` | 读：`read <url>` / text / html / value / attr / find | 只读，不需要新鲜度断言 |
| `browser_snapshot` | 精简 a11y 树 + refs；返回 `url` + `digest` | `interactiveOnly` / `depth` / `selector` |
| `browser_act` | **唯一变更入口**：click/fill/type/press/select/scroll/hover/upload，一次一个 | 可选 `expectUrl` / `expectName`：不匹配 → `stale_page`，**执行前**拒绝 |
| `browser_session` | open / close / list / status / tabs | 命名会话，见 §5.5 |
| `browser_screenshot` | 截图（视觉兜底 / 给人看） | path、fullPage |
| `browser_raw` | 逃生舱：白名单内的其它子命令 | `args[]`；受 profile 白名单 + `guard` 约束；默认关 |
| `browser_run` | **决策开才注册**：一次 `goal` → 插件内部有界循环 → trace + handoff | 见 §5 |

**不做 40 个工具**：MCP 的 `--tools all` 是那面墙；DSH 工具面是进 prompt 的，越窄越好。

### 3.1 「spawn 一个 CLI」到底贵不贵（实测回答）

有人会问：模型本来就能用 bash 直接跑 `agent-browser`，插件再 spawn 一次不是多一层开销？
本机实测（0.38.2，node spawn，30 次均值）：

| 被测 | 均值 | 说明 |
|---|---|---|
| `node spawn /bin/echo` | **1.2ms** | spawn 本身的下限 |
| `node spawn bash -c "echo"` | **1.4ms** | **bash 路线更贵**：多一层 shell |
| `node spawn agent-browser --version` | 57.3ms | 走 PATH 上的 **Node 包装脚本** |
| `node spawn bash -c "agent-browser …"` | 59.5ms | bash 路线：同样 +1 层，不会更省 |
| `node spawn <原生二进制> --version` | **3.1ms** | 同一版本、同一个二进制，少一层 Node |

同一组命令按子命令看：原生二进制 `get title` 3.7ms / `snapshot -i` 5.1ms / `click @e2` 16.8ms；
走包装层一律 ~57ms。`batch`（一条进程跑多条命令）实测 3 条命令 58.7ms ≈ 1 条的价格。

**结论三条**：

1. **bash 不是零开销**：它是"shell + CLI"两次 spawn（+0.2~0.8ms），插件是"直接 CLI"一次 spawn。
   插件这条路**比 bash 更省**，不是更贵。
2. **真正的开销在 CLI 进程本身，而且可以砍掉 11–15 倍**：PATH 上的 `agent-browser` 是 Node 包装脚本
   （Homebrew / npx 都如此），它再 spawn 原生二进制。所以 `AgentBrowser` 默认**解析符号链接、
   按 CLI 包装层自己的命名规则**找到同目录的 `agent-browser-<os>-<arch>` 直接 spawn
   （`resolveCommand` / `nativeBinaryName`，配置里的 `browser.executablePath` 仍可覆盖）。
   **规则里没有任何版本号**——它跟着"装的那份 CLI"走；带版本号的是 Homebrew 的 Cellar 路径，
   所以 `brew upgrade` 后 `spawn` 报 ENOENT 时**自动重解析并重试一次**（`AgentBrowser.run`），
   不让用户为此重启 DSH。
3. **决策循环里 CLI 根本不是瓶颈**：一步 = `snapshot`(5ms) + 一个动作(3–17ms) ≈ **22ms**，
   而一次 `ctx.judgment` 判断是 **500ms 量级**（dsh-judgment 实测）。真正的性能论点不在毫秒级：
   不做插件时每一步要花**一个宿主模型轮次**（秒级 + token），`browser_run` 把 N 步压进 **1 个轮次**。

> 复现：`pnpm probe` 会打印"实际命令"与每条命令的耗时；包装层 vs 原生二进制可以用
> `command: 'agent-browser'` 对 `command: ''` 各跑一次对比。

### 3.2 内置 skill（装插件即得，不用自己装）

官方 `agent-browser skills get core --full` / `skills list` 是**全量**参考（含 electron / slack /
dogfood 等 9 个专门技能），直接塞进 skill 目录太重、也不适合日常触发。随本包发布的是
**与已装 CLI 版本对齐的核心命令集**：

```
skills/agent-browser/SKILL.md                130 行：核心循环、两个最容易做错的点、定位优先级、
                                                    可见性/复用登录态、安全护栏、排障表
skills/agent-browser/references/commands.md  34KB：需要 SKILL.md 未列的命令时才读
                          snapshot-refs.md / session-management.md / authentication.md / trust-boundaries.md
```

注册方式（`dsh-skill` 的运行时 skill）：

```ts
ctx.skills.register({ name, description, whenToUse, content, source: 'dsh-agent-browser',
                      resourceBase: { kind: 'directory', path: <包内 references 目录> },
                      invocation: { modelInvocable: true, userInvocable: true } })
```

三条纪律：

1. **`ctx.skills` 是可选服务**（`ctx.get('skills')`）：不在就跳过并记日志，插件其余部分照常工作。
2. **原文逐字使用**：SKILL.md 是同步 CLI 版本的产物，改它会制造第二份真相。插件相关的补充
   （工具名、`browser_run`、references 的**绝对路径**）在注册时**追加**在末尾。
3. **为什么不依赖 `.agents/skills`**：DSH 的 filesystem provider 扫的是 user/project 的
   `.agents/skills` 根，**插件包里的 `skills/` 不在扫描根里**；而且层级是 project > runtime > user，
   所以插件这份会盖过 `~/.agents/skills/agent-browser`（用户手装的那份可以留着给别的 host 用）。

---

## 4. 设置页（照**通用设置面板**，标题 + 子标题）

### 4.1 视觉事实（来自 `dsh-client-ui-settings-general/lib/client.js`）

通用设置的一行就是「标题 + 子标题 + 右侧开关」：

```
.row        { justify-content:space-between; align-items:center; gap:24px;
              padding:16px 0; border-bottom:.5px solid var(--dsw-alias-border-l2) }
.title      { font-size:14px; line-height:20px }
.description{ color:var(--dsw-alias-label-secondary); margin-top:4px;
              font-size:12px; line-height:18px }
```

页面级页头沿用本插件族的既有约定（[dsh-judgment/client/styles.css](../../dsh-judgment/client/styles.css) `.jdg-pageTitle` / `.jdg-pageIntro`）：**18px/500 标题 + 13px secondary 副标题**。
开关用官方 primitives 的 `Switch`（36×20，`label` 必填，`aria-checked` 驱动视觉）。

### 4.2 页面结构

```
浏览器                                    ← 18px/500
agent-browser（Rust + CDP）的窄工具面……    ← 13px secondary

┌ ● 浏览器环境就绪                            [已安装·灰] ┐   ← summary：绿（两项都过）/ 红
│                                                          │     可用 → 按钮置灰「已安装」不可点
│                                                          │     不可用/未检查 → 「检查安装」可点
│   ✓ agent-browser   已安装 0.38.2                      │     检查就**两项**，路径之类的细节不显示
│   ✗ Chrome          没找到                             │     缺 CLI 时右侧多一个 [安装]（用户点击才跑）
│     修法：装 Chrome：https://www.google.com/chrome/     │
└────────────────────────────────────────────────────────┘

[浏览器功能        Switch]  ← 14px 标题 + 12px 子标题；每行 16px 竖距 + .5px 下边框
[决策              Switch]
工具面                      ← 分组标题（12px secondary），保留
[截图工具          Switch]
[逃生舱 browser_raw Switch]
进阶                        ← 分组标题
[允许域名]                                   ← **上下布局**（title/subtitle 在上，控件占满下面整行）
  一行一个（逗号也行），如 a.com、*.b.com          ← 子标题
  ┌ textarea（4 行，可纵向拉高，整行宽）──────────┐
  │ a.com                                        │
  │ *.b.com                                      │
  └──────────────────────────────────────────────┘
[会话名            input]  → --session
[有头模式          Switch] → --headed
[命令超时  30000 毫秒 ▲▼]  → 我们的 spawn 超时；步进器照「通用设置 → 字号」那行
                            （hover 才浮出箭头），±100ms，**数值可点进去直接输入精确毫秒**
[最大输出   0 字符 ⬚]     → --max-output；紧凑数值框（**无箭头**），可直接输入
[空闲超时   [30 分钟 ▾]]  → --idle-timeout；预设下拉（默认/10m/30m/1h/2h/自定义…）
                            选「自定义」时右侧才出现毫秒输入框
[内容边界标记      Switch] → --content-boundaries
```

> **「打开配置文件」不在这里**：那是设置外壳的**全局动作**（面板左侧导航底部的那个按钮），
> 来自 `settings/openSettingsDocument()`。本插件页面不再重复提供它——之前的实现既重复，
> 又因为 `configForms.describe().hasDocument` 与外壳的可用性判断不一致而**一直是灰的**。

**三条行距规则**（第 2、3 条来自真机反馈后的修正）：

1. 每一行都是**同一条 16px 竖距 + 同一条 `.5px` 下边框**，只有整页最后一行没有
   （General 的 `:last-child{border-bottom:none}`）。
2. **整页第一行不留上内边距**（`.ab-section > .ab-row:first-child{padding-top:0}`）——否则
   summary → 第一行会比「副标题 → summary」多出一份 16px，看起来"这里特别大"。
3. **分组标题保留**（工具面 / 进阶 / 配置文件），排版与「向上的间距」**逐字抄 Agent 预设页**
   （`@deepseek-ai/dsh-client-ui-agent-preset` 的 `.groupHead` + `.group+.group{margin-top:20px}`）：
   `12px / 600 / tertiary / letter-spacing .06em`，组与组之间 `margin-top:20px`。
   上一行自带 16px 下内边距 → 视觉上标题上方约 36px、下方 16px，标题明显更靠近它标注的那组。
   **行距本身不为了标题破例**（每一行仍是统一的 16px）——两件事分开：组间距用标题的 margin，
   行间距用行的 padding。

按钮照抄 skills-mcp 的 `.smp-button`（**`flex:none` 是重点**——少了它，按钮会被左列 `flex:1`
的文本挤成"检/查/安/装"竖排，真机截图里出现过）。

同样来自真机的 CSS 地雷：**别给「控件容器内的所有孩子」统一设宽度**（`.ab-rowControl > * { width:100% }`），
那会把 36px 的 `Switch` 拉成整列宽、开关直接变形。只对 `.ab-input` 设宽即可；
`tests/panel.test.mjs` 有一条 CSS 回归测试盯着这条。

**行有两种布局**（不是所有控件都适合挤在右侧）：

- 默认**左右**：标题/子标题在左，控件在右（开关、短输入）——`flex` 行 + `gap:24px`；
- **上下**（`.ab-rowStacked`）：文字在上，控件在下面**占满整行**。目前只有「允许域名」用它，
  因为它天然是**多行**内容（一行一个域名，`parseDomains` 同时接受换行与逗号），横向输入框会被挤压。
  多行控件用 `<textarea class="ab-textarea">`（与 `.ab-input` 同一套颜色/圆角，`resize:vertical`）；
  **回车留给换行，提交在失焦时**（别把用户正在输入的内容打断）。

### 4.2b 配置字段**必须** `.volatile()`（设置页的硬约束，踩过坑）

`dsh-settings` 的写入路径只接受 volatile 字段：

```js
const form = volatileForm(schema)                     // 全是普通字段 → undefined
if (form === undefined) throw new Error(`Plugin entry "${ns}" has no volatile fields`)
for (const path of paths) if (!isVolatilePath(schema, path)) throw new Error(`Config field … is not volatile`)
```

而 `describe()` 用 `volatileForm(schema)` 过滤 namespace —— **一个 volatile 字段都没有的 entry
根本不会出现在设置命名空间里**。这时候客户端的 `configForms.get(entryId)` 拿不到可写表单，
面板上显示的是插件自己的默认值，**任何写入都被拒绝**。

真机症状（本版踩到）：设置页能打开、控件都在、点了没反应——空闲超时选了「自定义」立刻弹回、
`+` 箭头数字不动。根因不在控件，在配置 schema。

修法（DSH 的标准范式，见 `dsh-llm-deepseek` / `dsh-judgment`）：

1. **六个顶层字段全部 `.volatile()`**（`enabled` / `browser` / `session` / `tools` / `limits` / `judgment`）；
   volatile 是**按字段**生效的，标在容器上就够，不用给每个叶子加。
2. 服务里每次现取：`this.config.browser.get()`，通过 `resolve()` 拆成 `ResolvedConfig`。
3. volatile 改动**不会重建 entry**（这正是 volatile 的意义），所以工具注册要自己重做：
   监听 `ctx.on('loader/volatile-update', …)` → `apply()` 撤销旧注册、重建 CLI 客户端、重注册
   skill / 工具。构造函数首次应用与热更新走**同一条 `apply()`**，避免两份逻辑漂移。
4. `allowedDomains` + `profile` 互斥在**首次应用时抛错**（entry 起不来），热更新时只警告并保留
   上一个可用配置（不能因为一次非法编辑把能用的工具弄没）。

测试注意：`ctx.plugin(Service, config)` 要传**原始配置**；传 `Config(config)`（已解析、字段是
`Volatile` 包装）会被 cordis 二次解析成非法形状（`$.enabled expected boolean but got [object Object]`）。

### 4.2c 兼容性闸门：`@deepseek-ai/dsh-*` 的 peer 范围是**拿去比 dsh 版本**的

DSH 0.2.1-rc.1 起，boot 时会算 `unmetRequirements(manifest, runtimeVersion)`（`dsh-app-boot`）：

- 有 `engines.dsh` → 只看它，peer 全部忽略；
- 否则遍历 `peerDependencies` 里 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的**每一个范围**，
  用 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 与**运行时 dsh 版本**比较；
- 只要有未满足的 → **整个 bundle 被跳过**：
  `dsh: skipping profile bundle "dsh-agent-browser": … requirements {"@deepseek-ai/dsh-typert-protocol":"0.2.0-rc.2"} …`

所以**绝不能精确钉死** `"@deepseek-ai/dsh-typert-protocol": "0.2.0-rc.2"`——那等于宣称
"我只在 dsh 0.2.0-rc.2 上跑"，Harness 升级到 0.2.1-rc.1 后插件**根本不加载**（真机踩到：
升级后设置页里整段插件消失，日志里只有那一行 skipping）。正确写法是跨版本区间：
`">=0.2.0-rc.2 <0.3.0"`。`@deepseek-ai/cordis` / `@deepseek-ai/schemastery` 不在闸门范围内
（名字不是 `dsh-` 前缀），但 devDependencies 仍要对齐运行时版本再跑测试。

**不重启桌面 app 的自检方法**（桌面 profile 被 Electron 独占，必须复制一份）：

```sh
cp -a ~/.dsh/profiles/desktop ~/.dsh/profiles/ab-debug
dsh --profile ab-debug headless --help 2>&1 | grep -i "skipping\|incompatible"
# 没有输出 = 所有 bundle 的兼容性都过了
```

> 桌面 profile 直接跑会被拒：`error: profile "desktop" is managed exclusively by the Electron application`。

### 4.3 实现事实（都已核对）

- 页面注册：`ctx.slots.register({ name:'settings.section', id:'browser', order:…, label:()=>'浏览器', inject:… }, Panel)`；客户端半打包成 `window.__ModuleLoader__` 单文件（照 [dsh-judgment/client/esbuild.config.mjs](../../dsh-judgment/client/esbuild.config.mjs)）。
- 读写：`ctx.configForms.get(entryId)` → `form.set(field, value)`，**不需要 Remote**。
- **「打开配置文件」不是插件能自己占的**：它是 settings 提供方的**全局**动作——`settings/openSettingsDocument()`（无路径参数，返回 `{opened:true}`），可用性由 `settings.describe().hasDocument` 决定（`@deepseek-ai/dsh-api-settings-controller`）。外壳自己调 `ctx.remote.settings.openSettingsDocument()`（`dsh-client-ui-settings-general/lib/client.js:822`）。
  → 我们的做法：**注入 `remote.settings`，页面上放一行同款入口**（`hasDocument` 为假时禁用并说明），打开的就是宿主持有的设置文档——本插件的配置段就在里面。**不假装**能打开一个我们私有的文件。
- 依赖注入：`export const inject = ['slots','configForms','remote']`；`remote.settings` 与 `remote.browser` 都用 `ctx.get()` 取（它们可能缺席，写进静态 inject 会把整个客户端半挡住）。

### 4.4 安装自检（summary 绿 / 红）

**打开面板时不许闪任何字**（真机反馈）：远端命名空间（`ctx.remote.browser`）比面板晚就绪时，
第一次 `probe()` 会失败；早先这里立刻渲染红色「自检通路不可用」，随后面板重挂、红字消失——
用户看到的是"打开就报错"。现在的纪律是：

- 首次自检**有结果（或确实失败）之前不渲染卡片**——不显示空态、不显示按钮、不显示红字；
- 第一次 `probe()` 失败**安静重试一次**（300ms），两次都失败才报错；
- 远端命名空间未就绪时**安静等待**（最多 ~3s）再跑，而不是立刻判失败；
- 「决策」的红字只在 `judgmentState === 'missing'`（宿主明确说没有）时出现，
  `checking` / `unknown` 一律不报红。

浏览器侧 **spawn 不了进程、也读不了文件系统**，所以"本机环境行不行"只能问宿主——这是本插件唯一的 Remote。
自检**只有两项**（用户口径）：本机有没有 CLI、有没有 Chrome；路径 / 包装层 / doctor 的 ffmpeg、
密钥、云 provider 之类一律不进面板（留在宿主日志里）。

- **host**：`AgentBrowserService extends TypertRemoteService`（服务名 `browser`）
  - `@Remote async probe()` —— **零实参**。返回 `{ ok, title, checks[2], checkedAt }`，
    两项各是 `{ id:'cli'|'chrome', label, status:'pass'|'fail', message, fix?, installable? }`。
    - `cli`：没装 → fail + `fix`（`brew install agent-browser` 或 `npm i -g agent-browser`）+ `installable`；
      装了但版本越界 → fail + "重跑 DESIGN §1.1 实验再放宽版本锁"。
    - `chrome`：**必须项**。CLI 可用时以它自己的 `doctor --quick --json` 为准（它认得环境变量、engine、
      自定义路径）；问不了 CLI 就退回文件系统 / PATH 探测，消息写"没找到"而不是"没有"。
  - `@Remote async installCli(target)` —— 帮忙装 **CLI**（Homebrew 优先，否则 npm 全局）。
    **Chrome 明确拒装**：`brew install --cask google-chrome` 在 macOS 上要管理员密码，
    一个后台进程挂着等密码是最糟的交互——Chrome 只给命令与下载入口。
- **client**：手写 contribution（`client/browser-remote.js`）。两个实测过的硬约束：
  1. **wire 名必须逐字等于形参名**（`target`）；
  2. **方法名不能与命名空间服务自身的方法冲突**——`install` 就是保留名，`$mount` 会直接抛
     `method "browser/install" conflicts with its namespace service`；所以叫 `installCli`。
     `pnpm verify:remote` 会把这条当场拦下来（这就是它存在的意义）。
- **载荷版本戳**：`probe()` 返回里带 `apiVersion`。客户端半热更新、host 半要重启，两侧错配时
  页面直接说"客户端半已是新版本，但 host 半还是旧代码 → 重启 DSH"，而不是把旧形状画成一张看不懂的卡片。
- **实参个数**：`probe()` 零参、`installCli(target)` 一参；**host 对缺参宽容**
  （`target` → undefined → 落到"只支持 CLI"分支），**卡实参个数的是客户端**——
  页面因此永远显式传参。
- **验证**：`pnpm verify:remote` 用真 `dsh-typert-registry` + `dsh-api-gateway` 跑两端并交叉验证（17 项）。

## 4.5 三家 Jev 浏览器实现的对比（2026-10-17 读源码 + 实测校准）

| | `jkudish/jev-browser` | `wy-coliney/jev-browser-use` | `kerpopule/hermes-jev-skills` | 我们（`browser_run`） |
|---|---|---|---|---|
| 形态 | 自带 Playwright 的 MCP/CLI | Codex skill + bridge，**不自带浏览器** | 多 skill 家族（CUA/搜索/路由） | DSH 插件，CLI 驱动 `agent-browser` |
| 每步问题 | **fan-out 三问**：action choice + goal_done noul + stuck noul | **一个 choice**，把 `DONE` / `BLOCKED` / `WAIT` 作为候选 | 一个 chooser + 独立的最终 `--expect` 验证 | fan-out 三问（同 jkudish） |
| 候选来源 | 页面注入 `data-jev-id`，代码枚举 | 解析 Codex 的无障碍状态行 | 26 元素 shortlist，代码枚举 | 快照 refs 枚举（role 白名单） |
| 停止门 | `goal_done>0.85` / `stuck>0.85`，**动作之前** | choice 选到 DONE/BLOCKED | 驱动层 `stalled_action` + 最终验证 | 同 jkudish，另加**独立确认** |
| 重复无效动作 | 从概率分布取**次优候选** | 不处理（由 Codex 接管） | **语义哈希**判断"交付了但没变"，两次就停 | **两者都做**（次优 + stalled） |
| 文字输入 | 另问一次生成文本 | **交给 Codex**（Jev 只点） | 同左 | **交回宿主**（input_required） |
| 结束语 | `goal_achieved` / `done`，仍要验证 | DONE 交回 Codex 验证 | 最终 `--expect` 独立验证 | `needs_verification` + `next` 提示 |
| 状态上限 | 无（截断元素数） | 快照 >24k 直接拒绝 | `MAX_STATE_CHARS` | 12k 截断 + 显式标注 |

### 4.5.1 移植了哪些（都有测试或实测支撑）

1. **重复无效动作 → 从分布取次优**（jkudish）。`ChoiceAnswer.probabilities` 是完整分布，
   不是我们编的猜测；`pickAlternate()` 按概率降序、排除已试过与不可执行的候选。
2. **语义哈希判断"交付了但页面没变"**（ronadin2002/jev-cua → hermes）。`stateSignature()`
   取「origin + 角色/可访问名 + 归一化正文的哈希」，**忽略 ref 编号**——否则"点了个没效果的按钮"
   和"真的推进了"分不开。两次无效 → `no_progress`。
3. **状态上限**（wy-coliney + 契约 §5.1 的成本事实）：快照正文 12k 截断，并写
   `snapshot_truncated` 显式标注。
4. **问题措辞纪律**（hermes《Writing a question Jev can answer》）：只点明**一个**判定属性，
   其余明说"只用于打破平局"；`goal_done` 直接指向 `state.page_text` 这一个字段。
5. **独立确认**（三家都有）：`goal_done` 只是"候选完成"，再用**一次**调用拿页面正文问一遍。
6. **`next` 提示**（wy-coliney 的 "Codex verifies"）：结果里带"怎么验"的下一步。

### 4.5.2 实测校准（这个 Jev 部署，n=3 × 2 次采样）

同一页面三种状态，`goal_done` 的措辞不同，答案完全不同：

| state | 笼统问"当前页面是否可见地呈现结果" | **只指向 `page_text` 字段** |
|---|---|---|
| 初始页面 | 0.800 | **0.090** |
| 中间态（"第一步完成"） | 0.740 | **0.230** |
| 已完成（SUCCESS） | 1.000 | **1.000** |

前者贴着我们的 0.85 阈值（真机上抖到 0.91 直接假阳性、一步没点就宣布完成），后者判别干净。
**结论：不是模型不行，是问题没点明"哪个字段是证据"**——这正是 hermes 那篇论文的核心发现。

另外实测这个部署的 **choice 在二选一「完成/没完成」上会饱和**（三种状态都给 `done` 0.98–1.0），
所以没有照搬 wy-coliney 的"DONE 作为候选"，而是保留 noul watcher + 独立确认。

跑通的样子（`pnpm e2e` 真机截图，`docs/e2e-success.png`）：

![e2e 成功](../docs/e2e-success.png)

### 4.5.2b 真站实测（jevusers.com → Browser → jev-browser-use）

用 `pnpm try`（`scripts/try.mjs`，goal 从命令行给）跑真实站点，暴露了四个只有真站才会出现的问题：

1. **候选太多时分布不合法**：这个部署在 65+ 候选上返回 Σp=0.97/0.98（dsh-judgment 严格校验整批拒绝）。
   对策：候选按 **goal 相关性**排序 + 封顶 60；分布不合法时**缩候选**（24 → 12）重新采样，
   而不是重复同一个请求（同一规模下经常重复失败）。
2. **内容边界标记污染证据**：`--content-boundaries` 的 `--- AGENT_BROWSER_PAGE_CONTENT nonce=… ---`
   让"正文其实只有 Skip to content"看起来像有内容。现在先剥边界再判断长度。
3. **`read` 拿不到正文**：GitHub 仓库页只回 "Skip to content"（CLI 侧 markdown 提取问题）。
   对策：`read` 失败重试一次；正文过短就**退回无障碍树文本**。
4. **过程型 goal 判不出完成**：「…然后打开 jev-browser-use 的页面」这类目标，
   `goal_done` 只问"最终结果"就永远 0.0x。对策：把 **`state.url`** 加入证据，并明说
   "打开某页/找到某物/进入某分类"这类目标，**当前就停在那上面**就算达成。

结果（`docs/try-jevusers.png`）：

```
第 1 步：goal_done=0.43 stuck=0.07 候选=65 置信=0.63
第 1 步：点击「jev-browser-use」（link，ref @e455） ✓
第 2 步：goal_done=0.95 stuck=0.13 候选=40 置信=0.73
第 2 步：goal_done=0.95 ≥ 0.85，独立确认 p=0.94 → 停，交回宿主校验
独立验证：最终 URL https://jevusers.com/p/wy-coliney-jev-browser-use
          标题 "jev-browser-use — Jev project — Jev Users"
```

另外补了两条稳健性：结束前（budget/no_progress）再确认一次——确认通过就报 `needs_verification`
而不是让调用方看到一个"失败"去重跑；超重页面取快照超时时降深度重试一次。

### 4.5.2c 真机测试（真的 `dsh` 进程跑一个 agent 回合）

`pnpm e2e` / `pnpm try` 是**旁路**：脚本自己起 cordis + 插件服务，绕过了 DSH 的插件装载。
真机测试要的是"真的 `dsh` 进程 + 真的插件装载 + agent 自己调用工具"——用 `pnpm live`：

```sh
pnpm live                      # 准备环境并打印命令
pnpm live --run "用 browser_run 打开 https://jevusers.com/ 并报告最终 URL"
```

它在一个**可丢弃的 `$DSH_HOME`（`.live-dsh/`，已 gitignore）**里：
用 `--from-default-profile headless` 生成一次性 agent profile → 以 `link:` 装本插件与
dsh-judgment → 抄 desktop 的 `judgment/provider`/`agent-browser`/模型路由配置 →
重开 headless 默认关闭的交互式凭据存储并复制 `.credentials.yaml`（**不打印**）。
`browser.headed` 从 profile 配置读，所以有头模式下真机测试会**弹出浏览器窗口**。

真机第一轮就抓到三个只有真实装载顺序才会暴露的 bug：

1. **`browser_run` 在注册时判定依赖** → 插件比 dsh-judgment 先 apply 时 `ctx.judgment` 还没有，
   于是整个工具**没注册**，模型说"没有 browser_run"。改：注册时**不判依赖**，调用时现取，
   缺失就给明确错误（`judge-unavailable`）。
2. **「决策」显示"已就绪"但用途没配**：`ctx.judgment` 在、`purposes: {}` 空着 → 一开就
   `judge_error`。改：可用性 = 服务在 **且** `status().purposes` 里该用途 `usable`；
   面板与 `checkJudgment()` 都据此判定，并直接提示"去「设置 → 决策」配一条连接"。
3. **`stale_state` 空转**：点会触发同页导航的链接时，每一步都"决策 → 页面已变 → 丢弃"，
   十几步全烧在这里。改：连续 3 次 `stale_state` 熔断（先做结束前确认，再报 `no_progress`）。

真机结果（有头模式，agent 自己调用 `browser_run`）：

```
最终 URL  https://jevusers.com/p/wy-coliney-jev-browser-use
status    needs_verification（goal_done=0.95，独立确认=0.93）
steps     2（第 1 步 65 个候选分布不合法 → 缩到 24 重采一次）
```

### 4.5.2d 耗时基准（hao123 首页，`pnpm bench`）

任务：在 hao123 首页点开一个**页内**入口（城市切换），两种模式对照。hao123 是典型的
重门户页：354+ 个可交互元素、天气翻牌/轮播/广告持续动画、大量元素被遮罩。

**固定成本（与模式无关，实测 6 次）**：

```
open 2.9–4.3 s（站点本身慢） · snapshot 40–70 ms · click 13–170 ms · read 10–28 ms · title 5–10 ms
```

**每一步"选动作"的成本**：

| | 每次成本 | 说明 |
|---|---|---|
| 有决策（`ctx.judgment`） | **0.6–1.2 s**（含 4 次样本重采时更高） | 状态 4.3k tokens/次（瘦身后） |
| 无决策（调用方主模型） | **≥1.7 s**（实测空回合 1.65/1.82 s），带工具时更高 | 每次还要重发 30–60k tokens 上下文 |

**结论：每一步确实更便宜（约 1/2 到 1/4），但不是"重大提升"，而且在这个页面上更脆弱。**

实测发现的问题与改进（都已在代码里）：

1. **状态太大**：refs 与快照文本重复，14.6k tokens/次 → 去掉 refs + 缩短正文后 **4.3k**，
   单次决策从 3–5 s 降到 0.6–1.2 s。
2. **动画页误判 stale**：文本每帧都在变 → 用「交互结构签名 + 文本 Jaccard(<0.93)」判定，
   天气模块翻牌不再导致 stale_state 空转。
3. **无名控件看不见**：hao123 的城市切换是 `generic` 且 JSON 名字为空 → 从快照文本回填名字、
   并把文本里标了 `clickable` 的元素纳入候选（否则这类入口永远不可选）。
4. **动作失败不该整轮报废**：点广告被遮罩是常态 → 失败计入排除集、连续 2 次才终止。
5. **中文 goal 没参与排序** → 加 2 字 n-gram 相关性排序；**要输入时输入框排最前**。
6. **判断层系统性欠归一**（这个部署的模型：Σp 实测 0.95/0.96/0.97/0.98，与候选数无关）
   → 自适应缩候选重采（45→24→16→8）+ 显式"总和必须为 1"提示；仍有约 1/3 的运行以
   `judge_error` 结束——这是**判断层的质量上限**，不是循环的问题。

真机（`pnpm live`）在有头模式下跑过 `browser_run`：5 步 / 5 次工具调用 / 22.9 s；
同一任务改用原子工具的真机对照两次都在 13–20 分钟后仍停在 2 步（环境/浏览器会话卡住，
不计入对照）。所以**端到端**的"决策 vs 无决策"没有拿到可信的完整样本，只有每步成本这一层可信。

### 4.5.2e 从两个高星项目移植的优化（P1–P5）

对照 `dsh-jev-plugin` 与 `jev-ultrafast` 的实现，移植了五条结构性优化：

| # | 优化 | 依据 | 效果 |
|---|---|---|---|
| **P1** | **删掉"执行前再取一次树"**：直接 act；CLI 的 `@eN` 是身份绑定的，失效会报 `Unknown ref`（绝不点错元素），按 stale 重观察 | jev-ultrafast `fresh()` 只做 O(1) 的 in-page 守卫，因为它那层协议不绑身份；我们的 CLI 绑，所以全树快照是纯浪费 | 每步快照 **2 → 1**；`stale_state` 误判类消失 |
| **P2** | 候选按**总数**封顶 40（原为 40 点击 + 20 输入 = 64）；页面上没有可操作元素时**不发请求**；唯一输入框**免判断**直接交回宿主 | dsh-jev-plugin 的 40/12 配比与 "no-request bypass" | 大选项集的不合法分布变少；简单页省整次请求 |
| **P3** | 快照失败**重试** 3 次（40/80ms 退避）+ 最后降深度 | jev-ultrafast `observe()` 重试 10 次 | 少一类 `action_error` |
| **P4** | 结果带 `timings`（snapshot/read/title/ask/act/total）与 `usage.estCostUsd`（$0.042/M 输入 tokens，取自 dsh-jev-plugin 冻结费率） | dsh-jev-plugin 的 receipts 纪律 | 优化可被 `pnpm bench` 直接对照，不再靠印象 |
| **P5** | 执行过动作后，观察要求"结构稳定"（**1 次** 40ms 探测） | jev-ultrafast 的 after_input 短等待（50/200ms） | 少"弹层没出来就选"的空转；动画页只探 1 次，不白付延迟 |

实测（hao123，`pnpm bench`）：`snapshot 316ms / read 126ms / title 42ms / ask 1906ms / act 5604ms`，
估算成本 **$0.0008**/任务。**瓶颈仍然在判断层**：这个部署的 Σp 实测 0.95–0.98（与候选数无关），
重采吃掉的 `ask` 时间占总耗时一半以上——那是 provider 侧的上限，不是循环能修的。

### 4.5.2f 进程启动成本与批量命令（batch）

> **更正**：本节最初写的是"每次 CLI 调用 63ms"。那其实是 **PATH 上的 `agent-browser` 壳**的成本——
> 它是个 Node 脚本（`bin/agent-browser.js`），真正的实现是同目录的
> `agent-browser-darwin-arm64`（Rust 二进制）。插件的 `resolveCommand()` 早就把 JS 壳换成原生二进制
> （`nativeSiblingOf`），所以**插件实际成本是 5–10ms/次**：

| 方式 | `--version` / 单次操作 |
|---|---|
| PATH 上的 Node 壳 | 63–69 ms |
| 原生二进制直调 | **6.6 ms**（`get url` 7.0 / `snapshot -i` 9.5 / `read` 6.0 / `get title` 5.2） |

所以 `batch` 在 **CLI 层**省的是 ~10ms/步（三次独立调用 18.0ms → `observe()` 8.0ms），
不是 114ms。它真正的价值在**模型回合**：一次工具调用 vs 三次，每回合约 1.7s。

`batch` 在一个进程里顺序执行多条命令，`--json` 返回逐条结果数组：

```sh
agent-browser batch --json 'snapshot -i' 'read' 'get title'   # observe() 内部就是它
agent-browser batch --bail 'open X' 'wait --load load' 'snapshot -i'
```

落地：`AgentBrowser.observe()`（树+正文+标题一次拿齐，循环每步用它）、
`browser_snapshot` 的 `includeText` / `includeTitle`（模型一次调用拿三样，省两个回合）、
内置 skill 的「批量命令（batch）」一节。

### 4.5.2g 页面内抽取（P8，已接入）：给判断层只发"可信的少数"

判断层是真正的瓶颈（实测 `ask` 占循环耗时一半以上），而它每次要吃掉整份状态
（~4.3k tokens）。**在页面里用一次 `eval` 预抽候选**，状态就小一个数量级（实测 hao123）：

| 方案 | 负载 | 每步耗时 |
|---|---:|---:|
| CLI `snapshot -i --json`（旧路径） | 13,985 字符文本 + 354 refs ≈ 4.3k tokens/次 | ~10 ms |
| 页面内 `eval` 抽取（当前快路径） | 80 个元素 → 1,021 字符 ≈ **1.1–1.9k tokens/次** | ~7–10 ms |

**为什么用属性句柄而不是 `@eN`**：refs 只存在 Rust daemon 里，页面里没有任何映射
（实测：`window` 无句柄、DOM 无 `data-*ref` 属性）。脚本给元素打 `data-dsh-idx="i"`，
动作时 `browser_act('click', '[data-dsh-idx="7"]')`——实测可点击并跳转。

**抽取时就把不可信的候选滤掉**（判断层看到的东西必须可信）：不可见
（display/visibility/opacity）、离屏、被遮挡（`elementFromPoint`）、无名（输入框除外）。

**给判断层的选项上限 16**（`JUDGE_OPTION_CAP`）：候选池可以有 54 个，但一次问给判断层的
不能那么多——实测这个部署在 40+ 选项上系统性欠归一（Σp 0.95–0.98，整批被拒），
选项越多"选错"概率越高。16 是实测能稳定给出合法分布的规模。

**降级路径（功能不降级，只是慢/贵）**：

1. `eval` 失败（CSP 拦、脚本异常）→ 退回整树；
2. 抽取 0 个候选 → 退回整树；
3. **目标覆盖检查**：目标提到的词在抽取结果里一个都没对上 → 退回整树
   （抽取只认 DOM 语义元素，会漏掉"a11y 上 clickable、但只是 generic"的控件，
   真机：hao123 的城市切换入口）。**带语言一致性守卫**：目标英文、页面中文时不比相关性
   （真机踩到：宿主把目标翻成英文 "click the top-left locality" → 误触发退回整树）。

实测（hao123，4 步）：`snapshot 98ms · ask 1196ms（5 次）· act 231ms`，**tokens 5,350**
（旧路径同规模 19–28k）→ 单次判断平均 **~1.07k tokens / ~239ms**，比之前 4.3k / ~380ms
降了 4 倍（tokens）与 1.6 倍（延迟）。**仍受判断层质量限制**：Σp 欠归一依然要靠重采。

**实现注意**（三条都是真机踩出来的）：

1. `batch` 会把每条命令按空白切分，而 JS 关键字之间必须有空白——抽取**不能放进 batch**，
   单走一次 `eval`（反而更省进程）；
2. `--content-boundaries` 会把 `eval` 输出包住，解析前必须剥掉；
3. **脚本里不能写正则的空白转义**：模板字符串会把 `\s` 当未知转义吃掉成 `s`，
   结果把所有 s 换成空格（真机：fixture 上 "Find stays" 变成 "Find  tay"、"Casa" 变成 "Ca a"）。
   现在用 `split(String.fromCharCode(10))` 之类的**零转义**写法归一化空白。
4. **名字要取 `<label>`**：checkbox/select 的 `innerText` 是空的，只有关联 label 才有
   真实名字（"Free cancellation"）；角色也要按 `input[type]` 细分
   （`type=search` → searchbox、`type=checkbox` → checkbox），否则判断层看到一堆 `input`。
5. **离屏元素不要丢**：CLI 的 click 会自动滚进视图；丢掉会把首屏之下的结果卡片藏起来
   （真机：fixture 的 "View Casa Flora"）。

**"少选项 + 多次采样投票"实测**（`pnpm bench:vote`，fixture + hao123，每个目标独立采样 6 次）：

| 选项上限 | 命中率（5 个目标） | tokens/次（hao123） | 不合法率 | 每次决策成本 |
|---|---|---|---:|---:|
| **10** | **5/5** | **2,879** | **0/6** | **$0.000121** |
| 16 | 4/5（"七日天气"选错） | 3,026 | 0/6 | $0.000127 |
| 40 | 3/5（"新华网"分布不合法 6/6） | 3,689 | 6/6（该目标） | $0.000155 |

**结论**：选项越少越准也越便宜（前提是候选池按目标相关性排过序）。
**投票没有收益**——单次采样已经全对，错误是**系统性**的（由选项集决定，不是随机抖动），
3/5 次采样只会把成本放大 3–5 倍。所以 `JUDGE_OPTION_CAP = 10`，默认不投票。

**抽取命中率的改进**（真机 fixture/hao123 上验证）：

| 改进 | 之前 | 现在 |
|---|---|---|
| 名字来源 | 只有 `aria-label`/`innerText`（checkbox 名字是 "on"） | `aria-label` → 关联 `<label for>` → 最近的 `<label>` → innerText/value/placeholder |
| 角色 | 一律 `input` | 按 `input[type]` 细分（searchbox/textbox/checkbox/radio）、`select`→combobox、`textarea`→textbox |
| 状态 | 没有 | 勾选态（未勾选/已勾选）、当前值、已有内容、链接目标（`链接: host/path`） |
| 选择器 | 固定 12 个 | 加 `label[for]`、`[aria-checked]`、`[aria-selected]`、`[contenteditable]`，并去重 |
| 离屏元素 | 丢弃（结果卡片消失） | 保留（CLI 的 click 会自动滚进视图） |

### 4.5.2h `inputs` 与状态守卫（内部循环能力）

**`inputs`**（`browser_run(goal, inputs)`）：调用方一次把字段值给进来（JSON 对象字符串），
插件按字段名匹配候选后**在同一次调用内**完成 fill / select / check，不再返回 `input_required`。
值仍然由调用方提供——**插件绝不猜文字**，但省掉了"每个字段一轮往返"（每轮 ≥1 次主模型回合）。

**状态守卫**（确定性，不靠判断层）：

| goal 动词 | 候选状态 | 行为 |
|---|---|---|
| enable / check / 勾选 / 打开 | `已勾选` | 跳过（已满足），不进判断层 |
| disable / uncheck / 关闭 | `未勾选` | 跳过 |
| 有 `inputs` 值 | 当前值/已有内容 == 目标值 | 跳过 |
| 全部可操作元素都已满足 | — | 直接 `needs_verification`（不花判断请求） |

勾选框/单选框在**有值时用 `check`/`uncheck`（幂等）**，没值时仍用 click（切换）——
真机踩过：goal "enable X" 在已勾选状态下又被 click 一次，把开关点回去。

实测（fixture）：**A. inputs 模式 6.6s / 22 次判断 / 宿主补填 0 次**；
**B. 无 inputs（宿主补填）8.6s / 21 次判断 / 宿主补填 6 次** → 省约 2s 与 6 次往返。
但两条路径在 fixture 上仍**未完全达成**（Destination / Free cancellation 没体现在最终详情页）——
根因是 fixture 的"提交时才读输入值"时序 + 我的多阶段 harness，不是插件；单动作命中率已 5/5。

**对照 jev-ultrafast 的本地酒店 fixture**（他们公布 1.896 s）：我们的循环 + 宿主填字段
实测约 **6.0 s / 14 次判断 / 9.1k tokens**，且三个筛选条件未全部生效——差距主要来自
**文本/选择必须交回宿主**（每个字段一轮 `runTask`），以及判断层延迟（~240 ms vs 他们的 178 ms）。
这条也说明：本插件适合"点击型目标"，表单型目标要宿主配合、成本更高。

### 4.5.2i 对照 Ying-Kai-Liao/jev-browser（MCP 服务器，42 任务 benchmark）

他们的做法（README + 布局）：**调用方（LLM）每步只说要什么结果，Jev 决定怎么做**。
一次 ~300ms 请求里同时问：目标元素 / 动作 / 值 / 完成? / 错误? / 不可逆?；
`values` 由调用方给、**Jev 只选哪个值**（永不写字）；Playwright 执行。
状态齐：`done / likely_done / needs_login / needs_confirmation / error / stuck / max_actions / ambiguous / blocked`。
另有 `browser_read(question)`（Jev 分块排序页面文本，<8k 字符不调用）、`diff`、两阶段选择（2000+ 元素）、
双向成本账（caller tokens vs Jev tokens，`net` 可为负）、42 任务 benchmark（40/42 正确、**0 次假 done**）。

**今天采纳的三项**：

1. **一次请求问全**：问题批次从 3 个涨到 **5 个**（+`irreversible`、+`page_error`）。
   实测（fixture，真实判断层）：5 问 **357ms / 1,033 tokens**，3 问 890 tokens —— 只多 16%，
   换来"下单前停一下"和"报错就停"两个能力。
2. **`needs_confirmation`**：下一步 p(irreversible) ≥ 0.7 且是点击 → 停在动作之前，
   调用方可带 `allowIrreversible` 重新调用。
3. **`page_error`**：p(页面报错) ≥ 0.8 → 直接返回 `page_error`（不是 `no_progress`），
   让宿主去修输入而不是盲目重试。

**还没采纳、按价值排序**：

| 项 | 他们的做法 | 我们的现状 | 价值 |
|---|---|---|---|
| `values` 语义 | 值带 key，Jev **选 key** | `inputs` 名字匹配 | 一个值填多个字段、模糊字段名 |
| `likely_done` / `ambiguous` | 0.7–0.85 与低置信度单独成状态 | 归到"没完成" | 会把有用的中间态丢掉 |
| 两阶段选择 | 2000+ 元素先选区域再选元素 | 相关性排序 + cap 10 | 大页面里目标可能不在 top10 |
| `diff` 状态 | 只把变化喂给 Jev | 每步发全量紧凑候选 | 候选少时收益小，大页面才有 |
| cost ledger | caller tokens vs Jev tokens + `net` | 只有 timings/tokens/成本 | 判断"这步到底值不值" |
| 42 任务 / 0 假 done | 固定 benchmark + 独立校验 | fixture + hao123 + 真机 | 质量纪律，值得搬 |

### 4.5.2j `values` 语义：判断层只选 key，值由调用方给（对齐 Ying-Kai-Liao/jev-browser）

他们的核心做法：调用方传 `values`，**Jev 只选"用哪个值"（key），永远不写字**。
我们没有直接抄"让 Jev 填答案"，而是按我们的纪律落地：

1. **问题批次里多一个 `value` 选择**（只在"页面有输入框 且 调用方给了 ≥2 个值"时出现）：
   选项是值的 **key**（敏感 key 只显示名字与长度，**值绝不出门**），外加 `value:none`。
2. **填写顺序**：名字匹配（确定性）→ 判断层选的 key → 都没有才 `input_required`。
3. 实测（fixture，真实判断层）：6 个问题一次 **378ms / 1,085 tokens**（5 问时 1,033，+5%），
   判断层正确选了 `value:style` → 填进 `Stay category`；字段名故意与 key 对不上时也能映射。

配套修掉的真机问题（都是这一轮实测暴露的）：

| 问题 | 现象 | 修法 |
|---|---|---|
| **重复填同一字段** | 填完 Lisbon 后又填 3 次（"填了值"本身算页面变化，停滞检测抓不到） | `filledFields` 记账 + 状态比对：已生效的字段从候选里剔除 |
| **goal_done 假阳性** | 目标词出现在下拉选项/卡片文字里 → `goal_done=0.94` 而筛选器仍是 `all` | ① state 里**带上字段状态**（`当前值: all`）；② **待生效字段守卫**：调用方给的值还没生效 → 不许以 goal_done 结束 |
| 假阳性的另一半 | 判断层"看到 DESIGN 卡片"就以为已筛选 | 判据里加一条：**已生效 ≠ 出现在页面上**（下拉选项/正文里出现不算） |

最终三个字段用例的实测（fixture，真实判断层）：

| 目标 | 结果 | 耗时 | 判断次数 | tokens |
|---|---|---:|---:|---:|
| type Lisbon into Destination | Destination=`Lisbon` ✓ | — | — | — |
| choose the Design category | `Stay category=Design` ✓ · `needs_verification` | **741ms** | 3 | 2,882 |
| enable Free cancellation | `Free cancellation=已勾选` ✓ | — | — | — |

**仍不完美**：单字段完成后，判断层有时继续乱点（goal_done 被独立确认拦住），最后落在 `budget`；
没有 `inputs` 时（调用方没给值）"待生效字段"守卫无从判断，goal_done 假阳性仍可能发生。

### 4.5.2k `likely_done` / `ambiguous`：把"中间态"与"分不清"交回宿主

来自 Ying-Kai-Liao/jev-browser 的状态分类。我们原来把这两个区间都归到"没完成 → 继续猜"，
结果是**乱点**（真机：单字段填完后继续点无关按钮直到 budget）。

| 状态 | 触发条件 | 交给调用方做什么 |
|---|---|---|
| `likely_done` | `0.6 ≤ goal_done < goalThreshold` + 独立确认 ≥ 0.6 + 至少执行过一步 + 没有待生效字段 | **先验证再继续**（不要当成"完成"，也不要继续乱点） |
| `ambiguous` | 置信度 < 0.45 **且** 前两名概率差 < 0.15 | 结果里带 `candidates`（前 3 名），用 `browser_act` 直接指定 |

同时修掉一个真 bug：**抽取路径只返回页面元素、不带控制项**，所以"只有一个按钮的页面"
会发出只有 1 个选项的 `choice` → 契约拒绝（`invalid-request: 候选数 1 不在 2–255`）。
现在 `CONTROL_CANDIDATES`（上滚/下滚/返回/等待）在两条路径里都常驻（实测：单按钮页 → 5 个候选）。

### 4.5.3 顺手修掉的两个真 bug（都是 e2e 跑出来的）

1. **`open` 返回 ≠ 导航已提交**：真机（0.38.2）上紧接着取快照还是 `about:blank`，
   决策循环只看到滚动/等待候选、白跑几步才超时。`open()` 现在轮询 `get url` 直到落地（≤5s）。
2. **`close` 返回 ≠ 守护进程已退出**：紧接着 `open` 会挂到正在退出的 daemon 上，导航变成 no-op。
   实测 6 次里 4 次失败；`close()` 之后加 300ms settle 后 **6/6 成功**（e2e 连跑 3 次全绿）。
   `open()` 另加一次"close → 等 → open"兜底，仍不动就抛 `open-stalled`（不静默留在空白页）。

> 这两个 bug 都不会在单条命令里暴露，只有"open 之后立刻操作"/"close 之后立刻 open"才触发——
> 正是 `browser_run` 这种连续循环的典型用法。

### 4.5.4 任务基准（`bench/`）：用别人的任务集回答"真的做对了吗"

之前所有 bench 只量**时间/token**，不判对错——所以"这套体系在哪些场景真的强"一直没答案。
新增 `bench/`：移植 4 家 MIT 任务集（出处与许可见 `bench/tasks.mjs` 头部），
每条 step 带**页面内 JS 断言**（ground truth），跑在本插件上：

- `offline`：jev-ultrafast 的酒店 fixture + jkudish 的 login/select fixture（本地 HTML、可重复）；
- `base` / `hard` / `guard`：Ying-Kai-Liao/jev-browser 的 41 条任务（真实站点）。

跑法：`pnpm bench:tasks`。**默认复用已打开的浏览器会话**（`--session default`），不冷启动；
想隔离就 `--session <name>`，想接指定端口 `--cdp`，想跑完关掉 `--close`。

**口径**：`needs_verification` / `likely_done` = 声称完成；断言假却声称完成 = **false done**；
断言真却没声称 = **missed**；负例任务（`expect: "fail"`）只要求"不许声称完成"。

**首轮结果**（2026-10-19，`decision-model-preview`，复用同一标签）：

| 套件 | 首轮 | P0 之后 |
|---|---|---|
| offline（3 条起，现 5 条） | 2/3，0 false-done | **4/5**，0 false-done（fixture-lazy 仍卡住，见下） |
| live 子集（6 条） | 1/6，1 false-done | 网络抖动中：ti-inputs ✓、ti-checkboxes ✓（一次）、其余待复测 |

**P0 改动（按 bench 的失败逐条修，全部有单测）**

1. **`last_change` diff + `done_change`**（ykl 的 `pageDiff`/`task.last_change`）：把"上一步实际改变了什么"
   （新增/移除控件、状态变化、正文/URL 变化）塞进 state，并在**同一批请求**里加一个 `done_change` noul；
   有 diff 时 `goal_done = max(goal_done, done_change)`。fixture-hotel 的 submit 步不再卡死
   （整条任务 31 次判断 → **13 次**）。
2. **可见正文指纹 `textDigest`**：抽取路径的 `snapshot` 只有"控件名+状态"，像 `"Loading..."`
   这种短正文进不去 → "点了开始加载"被判成"页面没变"。现在 `stateChanged` 也比正文指纹，
   短正文（<40 字符）不再被替换成候选列表。
3. **自适应 wait + 加载门**：`control:wait` 改为轮询到状态变化（加载页最多 6s）；
   页面显示 `Loading.../加载中` 时**确定性地先等**，不再让判断层重复点同一个按钮。
4. **抽取上限 80 → 300，且"离屏 ≠ 被遮挡"**：以前第 81 个元素之后根本不进候选；
   离屏元素又被 hit-test 误标成 covered 全部丢弃（fixture-dense 251 个元素只剩 37 个候选、目标不可见）。
   现在离屏保留（CLI 点击会自动滚进视图），抽取路径也走同一套 **40 候选预算 + goal 相关性排序**。
5. **state.snapshot 只用候选池合成**（不再塞整页 250+ 元素）：判断层在 250 个几乎一样的链接里选 10 个，
   置信 0.16 → ambiguous；改成"候选池就是该看的那部分页面"后，fixture-dense **3 次判断通过**。
6. **长文本 head+tail 截断**：结果往往出现在页面**末尾**（点开条目后追加的正文），只截开头会让确认问句永远看不到它。
7. **确认问句区分"结果型目标"与"动作型目标"**：`"直到出现/显示/看到 X"` 必须看到结果；
   只有"提交/点击这个按钮"这类目标才允许"动作已执行即达成"。（fixture-lazy 的 0.94 假阳性就是这句话修出来的。）

**P1（同日）：select 二阶段 + 候选上下文**

| 改动 | 机制 | 效果 |
|---|---|---|
| **native select 二阶段** | 抽取时带上 select 的选项（label+value，≤30）；调用方没给值时，**单独一次 choice** 让判断层在选项里选（ykl/jkudish 各自独立都这么做），选不到返回 none → input_required | `ti-dropdown` **通过**（4 次判断，之前 input_required） |
| **候选 near 上下文** | 抽取每个元素**所在行/容器的文本**（≤80 字符），拼进候选描述（"附近: …"），并在 action 提示词里说明"具体条目 vs 导航条同名链接" | 已生效，但 hn-comments **仍然**选了导航条 "comments"（goal_done .89 + 确认 .91）→ 假阳性 |
| **确认加 target_match 第二问** | 同一请求里再问一次"上一步点的控件是不是目标指的那个对象"；低于 0.6 就否决确认 | 已实现（省一次往返）；HN 这个例子模型仍判"是" |
| **inputsApplied 修 goal 传参** | 之前用输入 key 当 goal 判 `enable/disable` 动词，导致勾选类目标永远不算"已生效" | fixture-hotel 的 checkbox 步恢复 |

**P1 后的数字**：offline **4/5**（0 false-done，fixture-lazy 仍失败）；live 子集 2/5（`ti-dropdown`、`ti-inputs` 通过；hn-comments 仍 false-done；webform ambiguous；ti-checkboxes 在多次运行间**时对时错**）。

**结论（要写进下一步的）**：select/填值这类"有确定状态可查"的目标已经稳；
**"目标词命中同名导航"和"判断层稳定性"是模型能力问题，不是循环逻辑问题**——
换更强的 judge（或给 judge 做 few-shot 校准）比继续加门更划算；先别在逻辑里堆特例。

**全量基线（`baseline-3`，2026-10-19）**

41 条任务（`context-menu`/`upload` 跳过）= **13/39 正确（33%）**，7 false-done，1 missed，
230 次判断、317k tokens、191s。按类别：widget 2/2、negative 4/5、dynamic 1/3、form 1/4、
interaction 1/4、large-page 1/4、e2e 0/2、iframe 0/2、shadow-dom 0/1、actions 0/2、spa 0/2。

跑基线前先修了三个**测量卫生**问题（否则数字没意义）：
1. **JS 对话框会毒化整个会话**：一个 confirm 没处理，后面 30 条任务全部 `open` 失败。
   现在循环每步先查 `dialog status`，按目标 accept/dismiss（`ti-js-confirm` 因此通过）。
2. **共用标签偶发"open 成功但还停在上一个任务页"**：runner 加 `openVerified`（open 后核对 URL，不符重试）。
3. **网络失败与逻辑失败分开计**（`outcome=network`），不让机房网络污染正确率。

同一轮还补了三个逻辑缺口（都是基线暴露的）：
- **键盘动作**：新增 `control:press_enter` 候选（todomvc 新建、搜索框提交都需要 Enter；
  之前填完只能干等 → false-done）。
- **"填完 ≠ 完成"门**：目标带提交/搜索/添加等后续动词、且本轮填过值时，必须看到后续动作生效
  （跳转/新增元素/正文变化）才允许停。
- **字段名归一 + 单值绑定**：`first_name` ↔ "First Name"；调用方只给一个值时直接绑判断层选中的字段
  （ykl 的语义：值由调用方给、字段由判断层按 goal 选）。

**能力边界（`92ccfd4`）**

基线里 0/9 的 iframe / shadow-dom / custom-widget / actions / spa / lazy 不是"循环没调好"，
而是**能力不存在**。现在明确写进 skill 与 `browser_run` 描述：

- 循环只做 click / 填值 / select / 勾选 / 滚动 / 返回 / 等待 / Enter；
- iframe、shadow DOM、上传下载、右键菜单、画布、多标签流程 → `browser_act` / `browser_raw` / CLI；
- **有序子目标必须拆**成多次 `browser_run`（ykl 的 42 任务里两条失败就是"一个 goal 多个子目标"）；
- `browser_act` 补上 `drag`（CLI 早就有 `drag <src> <dst>`，以前没接进工具）。

**judge 校准实验（结论：不值得继续调 prompt）**

拿 7 个 false-done + 8 个 ambiguous 的样本，给 action / goal_done / confirm 三个提示词都加了
"必须指出与目标具体对象对应的证据，同名导航不算"这类判据，跑同一组 5 条失败任务：

| | 基线（同代码） | 加证据判据 |
|---|---|---|
| 5 条失败任务 | 0/5 | **0/5**（ti-entry-ad/ti-sort-table 退化到 1 次判断就停） |

而且**同一份代码重跑**时 `github-pulls` 从 false-done 翻成通过 → **单次基线的 ±1~2 条是噪声**。
所以：prompt 级校准不动这个 judge 的上限；继续堆"证据要求"只会让它在慢页面上更早放弃。
真正的杠杆是换更强 judge，或把这类判断下放给宿主复核（我们本来就把结果标成 `needs_verification`）。

**换了 judge：预览模型 → 真 jev-1.13（2026-10-19 下午）**

用户把 DSH 的「决策」配了两条连接：`DashScope`（`decision-model-preview`，百炼预览）
和 `TypeSafe`（`jev-1.13.0`）。bench 支持 `--connection <name>` 后同一套代码跑了两遍：

| judge | 选项上限 | 正确 | false-done | missed | 判断次数 | tokens | 耗时 |
|---|---|---|---|---|---|---|---|
| preview | 10 | 13/39 | **7** | 1 | 230 | 317k | 191s |
| jev-1.13 | 10 | 12/39 | **2** | 6 | 284 | 578k | 479s |
| jev-1.13 | 24 | **14/39** | 3 | 5 | 265 | 615k | 364s |

**结论一：之前归给"judge 判别力"的那批假阳性，换真 Jev 后全部消失。**
preview 的 7 个 false-done 里，`hn-comments`、`github-pulls`、`todomvc-coarse`、
`github-issue-search` 在 jev-1.13 上都不再假完成——说明"同名导航/关键词"这类误判是
**预览模型的能力问题**，不是循环逻辑问题。我们当时没在循环里堆特例是对的。

**结论二：真 Jev 更保守，问题从"太敢说"变成"不敢说"。**
false-done 7 → 2/3，但 missed 1 → 5/6（做到了却没声称完成）：多出来的失败是
`control:scroll_down` 反复无效果后停、或点了同名链接后卡住。分数只从 13 → 14，
**但安全profile 完全变了**：真 Jev 下"假完成"这件事基本被消除了。

**结论三：`JUDGE_OPTION_CAP=10` 是预览时代的约束，对真 Jev 不成立。**

| 候选上限 | 命中（稠密干扰页） | 不合法分布 | tokens/次 |
|---|---|---|---|
| 10 | 3/9 | 0 | 2,402 |
| 16 | 6/9 | 0 | 2,689 |
| 24 | 6/9 | 0 | 3,073 |
| 40 | **9/9** | **0** | 3,841 |

预览模型在 40 个候选时 Σp 不归一、整批被拒；**真 Jev 在 10/16/24/40 上 0 次不合法**，
而且候选越多、在"一堆长得一样的选项"里反而越准。同一 12 条任务子集：cap10 **5/12** → cap24 **7/12**
（判断次数 102 → 93、耗时 139s → 113s，token 基本持平）。
为此加了 `JEV_OPTION_CAP` 环境变量只做实验用；**建议默认值改为 24（配 jev-1.13 时）**，
40 更准但 token 再涨 25%。

**成本**：真 Jev 的 token 约为预览的 2 倍、单次延迟约 1.7–2 倍（1.69s/call vs ~0.83s）。
"便宜"这个卖点属于预览模型；真 Jev 买的是准确性。

**试过但回退的改动**：页面不可滚时不给 `scroll` 候选（想修"反复 scroll"的卡死）。
12 条子集从 7/12 掉到 3/12，且同代码重跑的波动本身有 ±1–2 条——**没有正信号，回退**。
"无效果动作"要在**执行后**处理（换次优/放弃），不要在候选生成阶段猜。

**照 ykl 补能力：两阶段 / needs_login / 表单判定（2026-10-19 晚）**

把 ykl 那套"循环成熟度"逐项对照实现，并**用数据决定留不留**：

| 能力 | 我们的实现 | 结论 |
|---|---|---|
| group→element 两阶段 | 候选 > cap 时先问"相邻 8 个元素一组"的 group choice，再在组内选 | **回退**：全量 14/39 不变，token 615k → 844k（+37%）。我们的候选池上限本来就是 40，两阶段没有用武之地（它适合 200+ 元素） |
| diff / last_change | P0 已实现（added/removed/changed/文本/URL + done_change） | 保留 |
| needs_login | 同批加 login noul；≥0.75 且调用方无凭据 → `needs_login`（放在 page_error 之后） | 保留（很便宜，一条 noul） |
| 表单已提交判定 | 填过密码类字段 + 页面已无输入框 → `needs_verification` | 保留（saucedemo 登录后 goal_done 只有 0.42，循环会接着点 Logout） |
| 调过的任务集 | 已移植 41 条 + 本地 fixture | 保留 |

**干净基线**（cookie 隔离 + login/form 门，cap24）：**13/39 · false-done 4 · missed 6**，
301 次判断、743k tokens。与共享 cookie 的 14/39 在 ±2 噪声内——**之前那个 14/39 略偏乐观**
（任务间共享标签会把上一条的登录态带进来，比如 login-wall 在已登录状态下被判"完成"）。

**这一轮的结论**：ykl 的"循环成熟度"不是靠堆功能堆出来的，而是**任务集与循环互相调出来的**。
他们的 42 条任务里大量是"一次一个干净步骤 + 明确 done"，配上 group/diff 才有意义；
我们的失败桶里 7 条是**能力不存在**（iframe/shadow/上传/拖拽），12 条 ambiguous、12 条 no_progress
——**先把动作集合（hover/键盘）和候选质量补上，比继续加两阶段更划算**。

**确定性完成判定（`4b5019c`，来自 13 条失败的分析）**

原则：**能不能停下来由代码判，判断层只负责"下一步做什么"**。

| 门 | 规则 | 证据 |
|---|---|---|
| 选择匹配 | 选中的 option label 出现在目标里（"Select Option 2"）→ 收尾 | ti-dropdown：11 次判断/13.7s → **2 次/2.9s**，稳定通过 |
| 先填后点 | 调用方给了值且还有字段没生效 → 忽略判断层选的 click，先填 | saucedemo 登录页曾"置信 0.27 → ambiguous，一个框都没填" |
| Enter 门控 | 只有刚填过输入框才提供 `press_enter` | 下拉页上判断层反复选 Enter 到 stalled |
| 表单已提交 | 填过密码框（state 脱敏 ●●● 识别）+ 页面已无输入框 → 收尾 | saucedemo 登录后 goal_done 0.42、循环接着点 Logout |
| 单步守卫 | 多子目标（"登录、加购、结算"）不套用上述收尾；停止阈值抬到 0.95、不开放 likely_done | saucedemo-coarse 曾在登录页就报完成 |

**测量现状**：同一配置（jev cap24）重复跑，正确数在 **13–16/39** 之间波动。
单次基线不足以判断"某个改动值不值"——**下一步必须先加 `--repeat`（每个任务跑 3 次取多数）再谈提升**。

**折叠线下点击（`d0fcf6a`）——"候选没进前 24"原来是误诊**

排查 wiki-link 时实测：
- 目标链接 "Bletchley Park" 在 **候选第 1 名**、Jev 在 Top-10 里也**选对了**（置信 0.76）；
- 但点击返回 ok、页面纹丝不动：元素 rect y=807、高 23，中心 y=818.5，而视口高 812
  → **鼠标坐标落在视口外 6.5px**，CDP 鼠标事件被丢弃 → "成功但无效果"；
  `scrollintoview` 后再点 → 正常跳转。
  （早先"JS `el.click()` 也不跳转"是**测量误差**：没等导航提交就读了 URL；复测确认
  `el.click()` 会跳转——但它是合成事件，对依赖 pointerdown/hover 的组件不完整。）

修法：click 前先 `scrollintoview`（仅页面内抽取路径）。结果：
- wiki-link：10 步 budget → **3 次判断/3.1s 通过**；
- 大页子集 wiki-link/github-pulls/hn-comments/books-poetry/wiki-search **5/5**；
- 全量：**16/39 · false-done 2（5%）· missed 5**（至今最好的安全 profile）。

**对"粗筛 → Top-10"的实测反馈**：五个稠密页（251/296/243/200/94 个元素）上，
简单词面打分（name+near+role）的 **recall@10 = 100%**——目标本来就在前 10；而且
在干扰项实验里 Jev **候选越多越准**（cap10 命中 3/9 → cap40 9/9）。所以：
- 粗筛不是当前瓶颈，**Top-10 反而可能降低精度**；
- 真要做，触发条件应该是"词面无命中"（排序最高分 ≈ 0），且产出 **Top-20~24 + 必选项并集**
  （待填输入框、精确命中项、控制项），而不是纯 10；
- 还要先有一个 recall 评测，recall@K < 95% 就不许上。

**点击层最终形态（`e0cd1a7`）**

| 元素 | 动作 | 理由 |
|---|---|---|
| `<a>` / `<button>` | `el.click()`（合成点击，缺省行为独立于坐标） | 折叠线下也生效；比"滚动+鼠标"少一次 CLI 调用 |
| 其它（div 按钮、自定义组件、hover 菜单、拖拽） | `scrollintoview` + CDP 真实鼠标 | 依赖 pointerdown/命中测试/坐标 |
| 回退 | 合成点击后页面没变化 → 同一候选改走"滚动+真实点击"，每候选一次 | 少数 a/button 会检查 `isTrusted` |

**定位候选的速度（实测）**

```
一次 eval（整页 DOM + 语义遍历）→ 300 元素 → 本地排序 <1ms
```

| 页面 | 抽取耗时 | 元素数 |
|---|---|---|
| 本地 fixture | 8ms | 10 |
| GitHub 仓库页 | 18ms | 177 |
| Wikipedia 首页 | 25ms | 276 |

约 **12μs/元素**；兜底 a11y snapshot 路径 10–58ms（只在抽取对不上目标时走）。
单步耗时构成：**抽取 8–25ms（约 2%）+ 判断 600–1200ms（约 53%）+ 动作/等待（约 35%）**。
结论：**定位层已经不是瓶颈**；耗时由判断次数决定（成功任务平均 4.4 次判断、失败任务 8.3 次）。

**现状与下一步（2026-10-19 晚，最新两次全量）**

| 配置 | 正确 | false-done | missed | 判断次数 | tokens | 耗时 |
|---|---|---|---|---|---|---|
| jev-1.13 · cap24 + 折叠线下点击修复（`d0fcf6a`） | **16/39** | **2** | 5 | 292 | 717k | 297s |
| 上述 + a/button 直接 `el.click()`（`e0cd1a7`） | 15/39 | 5 | 4 | 257 | 638k | 275s |

两次差异全部集中在 5 条任务的翻转上（hn-comments/wiki-search/github-issue-search/
guard-checkout/infinite-scroll），无一条能归因到 jsClick 机制 → **±3 条噪声内，都不能当"提升"**。

**最新失败桶（`jev-jsclick`，24 条失败）**

| 桶 | 数量 | 任务 | 性质 |
|---|---|---|---|
| ambiguous（判断层分不清） | 5 | ti-checkboxes、ti-dynamic-controls、ti-hover、hn-comments、saucedemo-coarse | 候选质量 + 判别力 |
| no_progress（无效动作后停） | 6 | ti-dynamic-loading、todomvc-coarse、ti-js-confirm、ti-entry-ad、saucedemo-fine、guard-webform | **换路策略**（现在"停"，应"换"） |
| budget（10 步打转） | 2 | webform、ti-sort-table | 同上 + 有序子目标 |
| 完成判定误判 | 5 | todomvc-fine、infinite-scroll、github-issue-search、webform-fine、guard-checkout | 完成判定 |
| **能力缺口（不计入"该修"）** | **7** | iframe×2、shadow×1、react-select、无限滚动、drag、key-press | 上游/能力边界 |

**通过 15 条**：ti-login、ti-dropdown、ti-inputs、ti-add-remove、books-poetry、wiki-search、
wiki-link、github-pulls、neg-bad-password、neg-missing-page、neg-disabled、new-window、
login-wall、neg-missing-option、guard-login。

**下一步（按 ROI，且必须配 `--repeat` 才能宣称提升）**

1. **测量纪律（P0）**：`bench/run.mjs --repeat 3`，每任务多数票；这是后面所有 A/B 的前提。
2. **卡死换路（P1）**：无效动作**一次**就把它从本轮候选里排除并换次优，而不是两次后直接
   `no_progress`——它同时改善完成率与耗时（失败任务 8.3 次判断 vs 成功 4.4 次）。
3. **候选质量（P1）**：把 `near`/区块标题纳入排序；dense 页把候选上限 40 放开到 80 并做
   `JUDGE_OPTION_CAP` 24 → 40 的 A/B（干扰项实验 cap40 命中 9/9）。
4. **动作集合（P2）**：`hover`、任意键、把 `drag` 接进循环——直接吃 interaction 0/4。
5. **完成判定扩展（P2）**：checkbox/计数/文本出现这类确定性收尾（select/表单/登录已做）。
6. **能力缺口（P3）**：iframe（需上游 frame 支持）、shadow（JS 穿透+坐标点击）、
   react-select（键盘/portal）——成本最高，最后做。

> 口径说明：**能力边界之外的任务（iframe/shadow/上传/拖拽/右键）不计入"该修"的范围**，
> 它们由 skill 引导宿主改用原子工具；循环只对"该做的能做好"负责。

**测量纪律：`--repeat` + 多数票（2026-10-20）**

同一份代码单次跑出过 13/15/16/16 —— 单次基线**不足以**判断改动。现在：
- `bench/run.mjs --repeat N`：每任务跑 N 次，每条 record 带 `run`；
- 跑完额外输出**多数票**（tie 不算通过）和"跑不稳的任务"清单；
- 每任务前额外 `dialog dismiss`（上一条任务的 confirm/prompt 会毒化整个会话）；
- 修了两个**断言自身**的崩溃（`ti-hover`/`ti-entry-ad` 的元素不存在时 `getComputedStyle` 抛错）。

**可信基线（repeat=3，jev-1.13 · cap24）**

| 轮次 | 正确 | false-done | 判断次数 |
|---|---|---|---|
| run1 | 16/39 | 3 | 270 |
| run2 | **17/39** | 2 | 267 |
| run3 | 16/39 | 3 | 268 |
| **多数票** | **17/39** | **2** | — |

- 稳定通过 15 条、跑不稳只有 2 条（`ti-add-remove` 2/3、`wiki-search` 2/3）；
- 成本：**6.9 次判断/任务、16.8k tokens、8.3s/任务**；
- 稳定失败 22 条 = **7 条能力缺口 + 15 条逻辑/判断**。

**稳定失败的 15 条（按桶）**

| 桶 | 数量 | 任务 |
|---|---|---|
| ambiguous（分不清） | 4 | ti-checkboxes、ti-dynamic-controls、ti-js-confirm、saucedemo-fine |
| budget（10 步打转） | 5 | webform、todomvc-coarse、ti-sort-table、saucedemo-coarse、ti-dynamic-loading |
| 完成判定误判 | 3 | todomvc-fine（likely_done）、github-issue-search（likely_done）、webform-fine（needs_verification） |
| no_progress（无效动作后停） | 2 | ti-entry-ad、guard-webform |
| page_error | 1 | guard-checkout（saucedemo 登录失败被正确识别，但任务本身要登录） |

**卡死换路（本轮实现）**：一次"执行了但页面没变"就把该候选记进 `useless`，
从后续判断的候选池里剔除（至少留 2 个），逼判断层换路；换路上限 2 次，避免拖成 budget。
效果是"不再原地重复同一个无效动作"，但上面 5 条 budget 任务的根因不在重复动作
（是有序子目标/缺动作），所以分数没变——**这轮的真实产出是"可信基线"和"测量工具"**。

**试过但回退：ambiguous 二次询问 + 开关收尾（2026-10-20）**

按 repeat=3 的失败桶，先做最便宜的两项，**结果都回退了**：

| 改动 | 设计 | 结果 |
|---|---|---|
| ambiguous 二次询问 | 先独立确认（通过则 `needs_verification`），不通过缩到 top-5 强制重问，置信 ≥0.5 才执行 | 全量 **15/39**（基线 17/39），`ti-checkboxes` 从 ambiguous 变 budget，没救回来 |
| 开关（checkbox/switch）确定性收尾 | 目标要"勾选/取消"、所有开关到位 → 直接停；并支持"确定性选择"跳过 ambiguous 门 | **导入 3 个新 false-done**：`neg-disabled`（负例！）、`ti-dynamic-controls`；负例假完成是不可接受的，立即回退 |
| 状态守卫"只剩控制项就算完成" | 修成看未过滤候选 + 未勾选开关 | 这条本身是对的，但和上面打包在一起时仍不达基线，一并回退 |

**结论（重要）**：
1. **"判断层犹豫"不能靠加确定性规则硬救**——`ti-checkboxes` 的 goal 是混合语义
   （"checkbox 1 checked and checkbox 2 **un**checked"），任何"统一 wanted"的简化都会反过来
   把已经对的开关点掉；
2. **负例任务是回归红线**：任何改动只要让 `expect:"fail"` 的任务变成声称完成，直接回退，
   不看总分（`neg-disabled` 就是被"开关到位即完成"误判的）；
3. ambiguous 的真正出路是**候选更少/更准**，不是加确认——确认会让慢页面上的判断层更早放弃。

回退后复测：**17/39 · false-done 2**（与基线一致），实验代码留在 git stash 里备查。

**P1a 动作集扩展（2026-10-20，来自用户优化方案）**

方案指出：账上 7 条"能力缺口"里有 3 条是**假缺口**——上游 CLI 早就有 `press`/`hover`/`drag`，
是循环没铺候选。核实后按方案实现：

| 改动 | 细节 |
|---|---|
| goal→动作推导（纯函数） | `keysWantedByGoal`（+ 白名单 `normalizeKey`，拒绝 Meta 单键）、`wantsHover`、`wantsDrag`；**只在 goal 命中动词时注入**，默认不加大候选池 |
| 执行层 | press → `act('press')`；hover → `act('hover')`；drag → **`jsDrag`（HTML5 合成 dragstart/dragover/drop + DataTransfer）**，失败退回 CLI 鼠标拖拽 |
| 抽取按需纳入媒体元素 | hover/drag 的目标常常不是交互元素（hovers 页头像是 `.figure > img`、drag 页是 `div#column-a/b`，以前只抽到 2 个页脚链接）→ `includeMedia` 时才把 `figure,img[alt],[draggable]` 加进 selector；img 名字用 `alt` 兜底 |
| 拖拽确定性收尾 | 上一步是 drag 且页面变化 → `needs_verification`（判断层 goal_done 只有 0.2，会再拖一次把状态换回去，ping-pong 到 stuck） |

**实测（repeat=3）**：

| 任务 | 之前 | 之后 |
|---|---|---|
| drag | 0/3 | **3/3** |
| key-press | 0/3 | **3/3** |
| ti-hover | 0/3 | **3/3** |

**净收益**：base 12/25（不变，hover +1 被 wiki-link/github-pulls 的波动抵消）+ hard/guard 6/14（+1）
= **18/39 多数票**（基线 17/39）。false-done 4 条（webform-fine、todomvc-fine、saucedemo-coarse、
infinite-scroll），比基线多 2 条——是后续要盯的红线。

**同轮试过但回退的两项（方案 P2a/P2c）**：

| 试的 | 结果 | 处理 |
|---|---|---|
| P2a 填完下拉后等弹层（react-select portal） | react-select **仍 ambiguous（3/3）**，只多花 300–600ms | 回退 |
| P2c wait 预算 3→6 | ti-dynamic-loading **仍 budget（3/3）** | 回退（失败页不再多烧 18s） |

**顺带修的基础设施 bug**：
- CLI 超时用 SIGKILL + 断开管道（wrapper 对 SIGTERM 不敏感，真机 60s 超时拖成 928s）；
- bench `open` 用 20s 超时、重试 2 次（一条卡死不再拖垮整轮）。

**事件驱动等待：替代固定 40ms/250ms（`1bbfc36`）**

用户指出："点击后固定等 40ms 判断跳转，网络慢时数据没回来会误判"——**实测证明完全正确**：

| 站点 | 点击 → URL 变化 |
|---|---|
| GitHub Pull requests 标签 | **1027ms** |
| the-internet 导航 | **858ms** |
| Wikipedia 链接 | **1153ms** |

也就是说"点击后等 40ms（或补 250ms）就判定没效果"**必然**把正常跳转误判成失败，
`github-pulls` 就是这样反复 no_progress 的。

**改法（不猜时长，让页面自己说"变了"）**：新增 `AgentBrowser.waitForPageShift()`——
一次 CLI `wait --fn` 在页面内轮询，任一条件满足即返回：
`location.href != 旧URL || !body.innerText.includes(旧正文样本) || 目标选择器出现`，超时 4s。

接入两处：
1. **每步观察后**：40ms 快路径没变化 → 事件驱动等待（最多 4s）→ 再观察；
2. **判定"动作无效果"之前**：再给一次机会，等到变化就继续，而不是换候选/停。

**结果**：`github-pulls` 1/3 → **3/3**；base 子集 navwait 4/5、0 false-done。
全量（repeat=3，分 chunk）：base **13/25**（12→13）+ hard/guard **6/14** = **19/39 多数票**，
false-done 4（webform-fine、todomvc-fine、saucedemo-coarse、infinite-scroll）。

**为什么不用"更大的固定等待"**：固定等待在快站点上纯浪费（每步多 1s），在慢站点上仍然可能不够；
事件驱动的成本是"变了就立刻返回"，只有真慢才付钱，而且**上限明确**（4s 后按原逻辑处理）。

**网络不可控 → 用"信号"换"时长"（`5247141`）**

HTTP 层不可控时，固定等待两头不讨好：快站点白等、慢站点不够。我们统一改成**有界的事件驱动**：

| 门 | 信号 | 上限 | 位置 |
|---|---|---|---|
| 就绪门 `waitForReady` | `document.readyState === 'complete'` | 3s（插件内 2.5s） | `open` 之后 / `runTask` 开头 |
| 跳转门 `waitForPageShift` | URL 变 / 正文样本消失 / 目标选择器出现 | 4s | 每步观察后 + 判定"无效果"之前 |

实测证据：点击到 URL 变化 GitHub 1027ms、herokuapp 858ms、Wikipedia 1153ms——
**固定 40ms/250ms 必然误判**，而事件驱动在快路径上几乎零成本。

**验收（repeat=3）**：
- 原通过的 6 条 ×3 = **18/18**、0 false-done（无回归）；
- 卡在判断/多子目标的一组（ti-checkboxes / ti-dynamic-controls / ti-js-confirm /
  github-issue-search / webform / ti-sort-table）仍 0/5 —— 就绪门**只防"半张页面误判"**，
  不修 ambiguous/budget，不夸大。

**R4 探针结论：能力缺口 7 条的真实归属（`a8a309a`）**

按第二轮方案 R4 做探针（不猜），结果推翻了"上游缺失"的假设：

| 任务 | 树里有？ | 动作可达？ | 归属 |
|---|---|---|---|
| **shadow-checkbox** | ✅ `checkbox [checked=false, ref=e190]` | ✅ `click @e190` → shadow 内 checked=true | **插件侧可修（已修）** |
| iframe-form / iframe-datepicker | ✅ `Iframe [ref=e95]` 下有 textbox/button | ❌ `fill @e98` → **`Unknown ref: e98`** | **上游限制**（跨 frame 动作不可达，记 issue） |
| react-select | ✅ portal 选项在 DOM 里 | ✅ 但判断层 ambiguous | 判断层问题（P2a 已试无效） |

**修掉的三个连环 bug**（都在候选生成层，不动判断层协议）：

1. **语言守卫被控制项污染**：`pageIsCjk` 拿 `candidates` 判，而 `CONTROL_CANDIDATES` 描述是中文
   → 英文目标在英文页上被判"不可比" → 覆盖检查（零命中→退回整树）**永远不触发**；
2. **覆盖检查被自制中文模板污染**：候选描述是 `在…里输入/选择`、`点击…`，同样让 pageIsCjk 恒真
   → 改为**只看元素自身的 name**；
3. **子串命中骗过覆盖检查**：goal "Check the checkbox" 的 token "check" 命中 "textbox"
   → 新增**角色感知**：goal 提到的控件名词（checkbox/radio/textbox/button/link/tab/option…）
   必须在候选角色里存在，否则退回整树。

**副作用修复**：`singleInputBypass`（页面只有一个输入框就免判断）收窄为
"goal 含打字动词 **或** 框名命中 goal" —— 否则 shadow 页会把唯一那 1 个 textbox 当目标直接
`input_required`，判断层连目标都没见过。

**结果**：shadow-checkbox **0/3 → 3/3**（3 次判断/3s）；base 层全量 **13/25 持平**（无回归）；
合计多数票 **20/39**（基线 17、上一轮 19）。

**DashScope vs TypeSafe 对照（同 8 条 ×3）**：

| 指标 | TypeSafe（jev-1.13） | DashScope（preview） |
|---|---|---|
| 多数票 | **6/8** | 4/8 |
| false-done | **0** | **2** |
| tokens | 323k | **161k** |
| 耗时 | 163s | **100s** |

结论：DashScope 便宜一半、快 40%，但**制造假完成**（正是我们花多轮从 7 条压到 2 条的指标）。
如果要用，只适合"动作选择"或 CI 冒烟；**完成判定必须留在强 judge**。本轮按要求不动用途配置。

**第二轮 R1/R3/R4/R6 结算（`622587b` → HEAD，2026-10-20 晚）**

按用户第二轮方案逐项执行，全部以 repeat=3 多数票验收：

| 项 | 结果 |
|---|---|
| **R4 探针** | ✅ shadow=插件侧（**0/3→3/3**，语言守卫三连修）；iframe=树里有 ref 但 `Unknown ref`——**复探后推翻**：同会话同快照的 ref 完全可操作，真因是**我们的死代码**（见下） |
| **R6 iframe 复探** | ✅ "refs inside iframes already work" 属实——之前探针跨快照用了过期 ref。真因：`candidates.length === 0` **永不成立**（控制项恒在）→ 退回树的路径从未执行。改为数**页面元素**后，iframe 表单**填值成功**（断言 true） |
| **R3 cap24** | ✅ 默认改 24（本轮所有 19/39 的跑分都在它下面），与环境变量 `JEV_OPTION_CAP` 保持一致 |
| **R1 false-done 归因** | ✅ webform-fine="页面空了"当成完成；todomvc-fine=第一步 budget 第二步误判；saucedemo-coarse=多子目标 |
| **（计划外）树路径回退** | ⚠️ 半成功：iframe 填值成功但**判 ambiguous 没声称完成**（树路径 45 个候选、goal 词对不上无名框）→ P1b 场景 |

**⚠️ 又一次负例红线（`neg-disabled` 3/3 → 0/3 假完成）**：
"树路径的输入框填过一次就从候选消失"——负例唯一的输入框消失后 → 页面无可操作元素 →
确认通过 → 假完成。**已回退**（同第一轮"开关确定性收尾"的教训，第 2 次）：
**任何"X 已完成就从候选消失"的规则，在负例/部分完成的场景下都会变成假完成制造机**。

**最终干净基线（分 chunk repeat=3）**：

| 层 | 多数票 | false-done |
|---|---|---|
| base | **14/25**（上一轮 12/25） | 3 |
| hard+guard | 5/14 | 0 |
| **合计** | **19/39** | **3** |

波动说明：上一轮 19/39（fd 4）→ 本轮 19/39（fd 3），分数持平、安全 profile 略好；
base 层 13 → 14 是本轮净变化（shadow +1 与波动相抵）。

**接下来的关键路径**（按 ROI）：
1. **P1b near/标题加权排序**：树路径 45 个候选里 goal 词对不上无名框——这正是排序要解的
   （iframe-form 实质已达成但判不出）；
2. **R1 落地**：false-done 三条的收尾分支分别收紧（webform-fine 的"页面空了"路径、
   todomvc-fine 的 likely_done、infinite-scroll 的计数）；
3. 有序子目标（browser_run subgoals）：budget 5 条的正解，等 P1b 落地后单独立项。

### 4.5.5 第三轮优化路线图（方案稿，2026-10-20，**未实施**）

> 基线：**19/39 多数票**（base 14/25 + hard/guard 5/14，false-done 3，repeat=3 分 chunk）。
> 本节是方案，不是实验记录——每项动手前先按 §末尾的验收纪律跑定向子集，做完把数字写回来。

**测量基建先行（一次性，10 分钟）**

全量一轮 repeat=3 很贵，之后的每一条都必须能"只跑受影响的几条"：

```bash
node bench/run.mjs --only ti-checkboxes --repeat 3 --trace   # 单任务 + 复盘
node bench/run.mjs --tier offline                            # 本地 fixture 5 条：冒烟/回归快车道
node bench/run.mjs --tier offline,base,hard --only <改动任务>,neg-bad-password,neg-missing-page,neg-disabled,neg-missing-option --repeat 3
```

`--only` 只会筛选 `--tier` 已选中的任务；`neg-missing-option` 在 `hard`，改 guard 逻辑时还要显式选 `guard` tier。负例按本次改动触及的门控选择，涉及通用停止/完成判定时至少覆盖上述四条。

**R-A：false-done 收尾收紧（先复核基线归因，安全红线）**

| # | 任务 | 已归因根因 | 修法 |
|---|---|---|---|
| A1 | webform-fine | "页面空了"被当成完成（跳转后正文抽取为空/极短，confirm 只问"没报错"） | 空正文只能视为**证据不足**，不能直接当作成功或失败：confirm state 暴露 `page_text_empty` 供 trace/judge 使用；停止需另有目标相关证据（如 URL/标题/结果内容）。不要用通用的"正文短于 40 字就硬拦"，因为合法完成页也可能很短，空页面目标也可能合法 |
| A2 | todomvc-fine | 第一步 budget 后第二步误判 likely_done | **先归因再动手**：`--only todomvc-fine --repeat 3 --trace` 存 trace；定位究竟是哪一步、truth/status/confirm 概率为何不一致，再只收紧那条分支。不能先假设 `LIKELY_CONFIRM_FLOOR=0.6` 是根因 |
| A3 | saucedemo-coarse | 多子目标任务提前声称完成（登录/加购/结账没有全部完成） | 先区分 false-done 发生在哪个子目标；完成确认必须覆盖最后要求的订单结果，不能只因当前页面看似合理就停。与 R-C 子目标方案联动，但先用 trace 证实 |

`infinite-scroll` 曾出现在上一轮 false-done 清单，但不属于当前 19/39 基线的三条归因；应作为独立诊断任务，不计入本轮 R-A 的已确认问题。若重新跑出的 trace/结果显示它再次 false-done，再另立修复项。

**R-B：候选上下文与排序（命中率本体，收益待测；先验证候选覆盖，再改策略）**

| # | 改动 | 说明 | 主要收益任务 |
|---|---|---|---|
| B1 | 目标语义化定位信息 | 优先使用 label/aria-label/placeholder、父容器文本与可访问树关系；只有 goal 明确说“第 N 个/checkbox 1”且页面能稳定映射时才附加序号。DOM 顺序不是天然的用户编号，序号只能作上下文，不能单独决定动作 | ti-checkboxes（先 trace 证实是否选错对象）；ti-dynamic-controls 要另查禁用字段行为，不是 checkbox 序号问题 |
| B2 | **P1b：tree fallback 上下文** | extract 路径的候选 description 已带 `near`，且 `rankByGoal` 已对 description 做词面排序；这里不是全局缺 near。探索点仅是 tree fallback：先记录 snapshot 层级、候选 top-N 和缺失属性，确认能否可靠关联上下文；不要假定顶层 DOM eval 能读到 iframe 子树 | iframe-form（45 个树候选、无名 textbox）、hn-comments 类，需 trace 证实 |
| B3 | 无名字段诊断 | extract 能从当前 document 读取 labels/placeholder，但 tree fallback 只有 accessibility refs，不能直接复用 DOM label 链。先用探针确认字段是否有语义名、DOM 属性、ref 映射和可达性；只有能可靠关联时再增加映射 | iframe-form / 无名字段类 |

明确不做（都有实测否决）：ambiguous 二次询问（上轮 15/39 倒退）；候选上限收紧（干扰项实验 cap40 反而 9/9）；“开关到位即完成”类确定性收尾（负例红线 ×2）。

**R-C：有序子目标（budget 任务候选方向，收益待测，改动面最大，放最后）**

根因假设：webform、todomvc-coarse、saucedemo-coarse 等把多个行为压在一个 goal 里。先分别检查 trace：字段填写顺序、后续按钮/导航和多步完成门是不同问题，不能假设一个 inputs cursor 能解决全部。

| 方案 | 内容 | 取舍 |
|---|---|---|
| **C-A（推荐先做小实验）** | 对纯表单先定义可验证的字段队列：每个字段写入后读回状态；字段满足后再允许提交动作。字段队列是填表策略，不代表完整任务 plan | 不从 `Object.keys(inputs)` 推导用户流程（对象键顺序不是 API 契约）；按页面字段与目标显式匹配。先用离线 fixture 原型并覆盖 disabled/负例；当前 `pendingFieldOf` 已优先填未生效字段，实验必须证明它修复了什么具体失败 |
| C-B | 为 browser_run 增加显式、有序 `subgoals` 输入 | 更通用，但需变更工具契约/调用方；每个子目标独立保留状态、校验与失败 handoff。单独与旧单 goal 模式做 A/B，不改既有 benchmark 口径 |
| C-C | 让判断层先生成自由文本 plan 再执行 | 不推荐：多一次不可控开放问题，偏离“判断只做排序”不变式；除非先把计划限定为可校验的结构化子目标 |

inputs 队列不能表达 webform 的第二 radio 和 submit；todomvc-coarse 的 `first`/`second` 是同一输入框的两次不同操作；saucedemo-coarse 的 checkout 字段要到登录、加购、进入结账后才存在。它们需要显式子目标/阶段状态，不能要求所有 inputs 先应用。**R-D：单点诊断（先看 trace，不预设根因或收益）**

| 任务 | 已有机制/待查点 | 第一步 |
|---|---|---|
| ti-js-confirm | 已有 dialog blocker 和按 goal 词接受对话框逻辑；查触发按钮是否点击、dialog 是否出现、下一轮是否 accept | `--only ti-js-confirm --repeat 3 --trace --verbose` |
| ti-dynamic-loading | 有最多约 6s 的页面变化轮询；已记录增加 wait 预算仍失败；先区分等待、正文抽取、goal_done/confirm 哪一环 | 同上 |
| react-select | portal 候选已有可达探针，但判断层曾 ambiguous；确认抽取候选、焦点和选项动作，再决定是否需要键盘策略 | 同上 |
| ti-entry-ad / guard-webform | 看停滞/换路后的候选和 trace；确定阻断阶段再改 | 同上 |
| infinite-scroll | 当前 goal 没写数量阈值（“Scroll down to load more paragraphs”）；检查任务定义与断言是否对齐，不把隐藏的 `>=3` oracle 注入通用判断 prompt | `--tier hard --only infinite-scroll --repeat 3 --trace --verbose` |

**验收纪律（每条改动必须全过，缺一不合并）**

1. **先定向**：受影响任务 repeat=3，保留 trace；安全相关改动按 tier 明确纳入负例（涉及 guard 时加 `--tier guard`）；
2. **再全量**：分 chunk repeat=3 多数票；不引入新的 false-done，负例零假完成；分数与稳定性都不达目标则回退，不叠加下一项；
3. **存档**：结果 JSON 落 `bench/results/`，记录 commit、tier、model/connection、task IDs 和 trace 摘要，避免网络失败混进逻辑失败；
4. **不预报固定加分**：先建立逐任务原因矩阵；只报告实际重复验证的正确数、false-done、missed、network 和波动任务。context-menu/upload 等明确跳过项不计为可修失败。

**方案复核结论（2026-10-20）**

§4.5.5 方向可作为待验证假设，不能按原排序直接实施，也没有数据支持“R-A +2~3、R-B +2~3、R-C +2~3”的加分承诺。实施前先跑：

```bash
node bench/run.mjs --tier base --only webform-fine,todomvc-fine,saucedemo-coarse,ti-checkboxes,ti-dynamic-controls,ti-js-confirm,ti-dynamic-loading,neg-bad-password,neg-missing-page,neg-disabled --repeat 3 --trace --verbose
node bench/run.mjs --tier hard --only infinite-scroll,react-select,iframe-form,neg-missing-option --repeat 3 --trace --verbose
node bench/run.mjs --tier guard --only guard-checkout,guard-webform,guard-login --repeat 3 --trace --verbose
```

第一组复核当前 false-done 归因和 base 失败环节，第二组诊断 hard 任务，第三组单独审查 irreversible guard；定向结果用于选一个可复现机制做 A/B，随后才跑全量分 chunk。

还需分开衡量三个指标：①**任务完成率**（断言通过且所有 planned steps 符合，现有 `correct/tasks`）；②**false-done / missed**（安全与召回）；③**动作命中率**（目标动作是否进入候选、judge top choice 是否正确、动作后是否产生目标相关变化）。当前 bench 的终态断言不能单独推出第③项；需先在可控 fixture 为关键动作标注 acceptable-action 集或加诊断 oracle（只评分，不传给 agent），再统计候选 recall@K、top-choice accuracy 与 action success。不要把候选覆盖失败、judge 选择错误、动作执行无效、完成门误判混成一个“完成率”问题。

### 4.5.6 第三轮第一批：确定性收尾（已实施，2026-10-20）

按 §4.5.5 的"先 trace、再改一个可复现机制"执行，**共 5 处**（都有单测；未提交）：

| 改动 | 规则 | 证据（真机 trace） |
|---|---|---|
| 通用 key 的 pending 判定（`specificallyNamed`/`goalMentions`） | 值 key 是 `text` 这类通用词时，"已有别的值"的字段不算 pending；空字段只有**目标点名**且本轮没填过才算 | webform-fine：`pw123` 被覆写成 `hello world`、`pendingFieldOf` 永远"没生效" → 30 次判断/35s；修复后 18 次/20s，**假完成消失** |
| 通用 key 的字段改选（`bestEmptyInputForGoal`） | 单值 + key 不对应字段名 + 判断层选的字段与目标无关 → 改选**目标点名的空文本字段**（不碰下拉框） | 同一 trace：`pw123` 被填进 Textarea、`hello world` 被填进 Text input |
| 导航证据（`urlChangeMatchesGoal`） | 目标词出现在**当前地址相对起始地址新增段**里 → 收尾（不绑 goal_done，避免判断层抖动） | fixture-hotel：`#casa-flora` 命中但确认只给 p=0.24；fixture-dense：预算 11 次 → **1 次判断/2s** |
| 命名提交控件（`submitControlOf`/`namedSubmitGoal`） | 控件名在目标里 + 动词是提交类 + 点击后页面**净变化** → 收尾；登录类/数量型目标禁止 | fixture-hotel step 2：`Find stays` 被反复点击 10 步 → 1 次点击收尾 |
| 加载完成（`loading_finished`） | 进入加载等待时的正文 → 加载标记消失 + 正文出现新内容 + 无错误词 → 收尾；`waitForPageChange` 改为"等到加载标记消失"而不是"签名一变就返回" | fixture-lazy：14 次判断/30s budget → **1 次/5s 通过** |

**安全护栏（这轮新加）**：
- `looksLikeErrorPage()`：浏览器错误页不收尾；URL 证据还要求**页面有实质内容**（≥ `MIN_PAGE_TEXT`）——webform-fine 的"提交成功页只有 27 字、日期被日期插件清空"因此不再被当成完成；
- **"没有可操作元素"不再单独作为完成证据**（这条老规则本身就制造假完成）——只记 trace，状态如实报 `no_progress`；
- 独立确认遇到"正文很短"时**保留真实正文**并与控件树拼接（fixture-lazy 的 `Hello World!` 之前被短正文回退丢掉）。

**实测（本机，repeat=2）**：offline tier **5/5 全绿**（10/10 次运行、0 false-done、0 missed，总计 42s；本轮开始时是 2/5、missed+false-done）；
webform-fine 仍是**失败**但不再是假完成（真实根因：页面日期插件在失焦后清空输入，URL 里 `my-date` 为空——站点行为，非循环问题）；
`todomvc-fine` 从"假完成"变为"truth=true 但 budget"（missed），待下一轮处理。

**未解决 / 下一轮**：`todomvc-fine`（同一输入框跨步骤重填后的提交路径仍烧步数）、`infinite-scroll`（goal 未给数量阈值，属任务/断言口径问题）、`ti-js-confirm`、`react-select`；另：`which()`/`nativeSiblingPath` 在 Windows 上的 PATH 解析仍是产品级缺陷（本机靠 profile 里 `browser.executablePath` 绕开）。

## 5. 决策形态（v2 定稿）

### 5.1 「是否启用决策」的确切语义（两种可观察形态）

**依赖是显式声明的**（`package.json`）：

```json
"peerDependencies": { "dsh-judgment": ">=0.1.0 <1.0.0" },
"peerDependenciesMeta": { "dsh-judgment": { "optional": true } }
```

可选 peer：不装 dsh-judgment 插件照常能装、能用浏览器工具，只是不能开「决策」。

**先检查再允许开启**，判定是**四态**的（`probe.judgment` + `apiVersion` 共同决定）：

| 状态 | 含义 | 开关 |
|---|---|---|
| `ready` | 宿主明确说 `ctx.judgment` 在 | 可开启 |
| `checking` | 挂载时那次自检还没回来 | 置灰 |
| `unknown` | 自检失败，或 host 半是旧码（载荷版本不匹配） | 置灰 |
| `missing` | 宿主明确说没有 `ctx.judgment` | 置灰 |

**未知一律不许开启**——早先"未知 = 不拦"是漏洞：依赖不在也能点开，开了 `browser_run` 只会报错。
点开启时面板还会调宿主 `checkJudgment()` **现问一次**（不信任挂载缓存），不可用就不写配置。
宿主侧兜底：`apply()` 里 `tools.decision === true` 但 `ctx.judgment` 缺失 → 警告、不注册该工具。

| `tools.decision` | 模型面前有什么 | 谁在驱动 |
|---|---|---|
| **关** | `browser_snapshot` / `browser_act` / `browser_read` / `browser_session` / `browser_screenshot` | **主模型**一步步驱动（就是现在的 CLI 用法） |
| **开** | 以上 **+ `browser_run(goal)`** | **插件内部有界循环**，每步 `ctx.judgment.ask()` 在代码枚举好的候选间选一个 |

### 5.2 `browser_run` 的一步（顺序即纪律）

```
snapshot（重取，永远新鲜）
  → 代码枚举候选（refs + scroll/back/wait/done，文本输入**不入候选**）
  → ctx.judgment.ask(state, { action: choice, goal_done: noul, stuck: noul,
                              purpose: 'browser.action' })
  → 停止门（在动作之前判定）：done / goal_done ≥ 阈值 / stuck ≥ 阈值
  → 执行前新鲜度：再取一次 snapshot，比对 `digest`
     └─ 不一致 → 丢弃这次决策，回到本步开头（记 `stale_state`）
  → 执行**一个**动作
  → 记 history（动作、结果、无效果标记）→ 下一步
```

> 新鲜度用**页面身份（origin + 无障碍树）的 digest**，不用 `judge.fingerprint`：
> 后者是 judge 的请求配方，回答的是"是不是同一份请求"，不是"页面还是不是那一页"。
> `judge.fingerprint` 留给"同一次判断的答案有没有过期"这种场景（M3 的动作账本会用到）。
> 文本输入在候选枚举阶段被标成 `input:*`，循环遇到它**不执行**，直接以 `input_required` 交回宿主。

### 5.3 三条不变式

1. **门控必须确定性**：域名白名单、危险子命令、`guard` 这些**绝不用判断**（对应 dsh-judgment 设计不变量 3）。
2. **判断只做排序**：候选由代码枚举，judge 只在一个 `choice` 里排序；答案不合法**即拒**，不"修复"。
3. **降级必须显式可见**：`ctx.get('judgment')` 缺失、`apiVersion` 不匹配、用途 `browser.action` 未配置、密钥缺失、配额耗尽 → **类型化失败 + 明确文案**（"去 设置 → 决策 配一条连接"），**绝不静默退回主模型假装在决策**。

### 5.4 结束语与 handoff

- 达到目标 → **`needs_verification`**（不是"已完成"；最终校验留给宿主，参考项目三家一致）。
- 需要文字/密钥 → **`input-required`**，把字段描述交回宿主，**由宿主提供值**，插件不猜（借 jev-browser 的 redaction 纪律：值只从宿主/凭据来，且从日志与结果里擦除）。
- 其它状态：`blocked` / `no_progress`（重复动作或无效果）/ `budget`（步数/时间）/ `judge_error` / `action_error`。

### 5.5 会话归属（v1 §2④ 保留）

CLI 默认会话**全机共享、跨对话持久**（会劫持别的 agent 或把人类开着的页面导航走）。做法：每个 DSH agent/session 一个命名会话（`--session`，默认 `dsh-agent-browser`，可在设置页改）；用 `--idle-timeout` 控制守护进程存活。

**不**在插件 dispose 时自动 `close`：配置一改就会重新应用 entry，自动 close 会**误杀**用户正在用的会话。要主动收尾就用 `browser_session close`，剩下的交给 `--idle-timeout`。（这是 v1 §2④「卸载时 close」的修正。）

### 5.6 审计（v1 §2② 保留，后置）

搬 [dsh-judgment/src/provider/ledger.ts](../../dsh-judgment/src/provider/ledger.ts)：**动作前先落库**（会话、动作、ref/selector、url、digest），回来补结算。事后能回答"谁点了什么、当时页面什么样"。M1 只做内存 trace（`browser_run` 返回值里），M2 落盘。

---

## 6. 从 dsh-judgment 直接搬的骨架

| 要搬的 | 位置 | 用途 |
|---|---|---|
| 客户端半配方 | `client/esbuild.config.mjs` · `client/primitives.js` · `client/react.js` | 单文件 `window.__ModuleLoader__`；宿主模块必须**同步 `require`** |
| 页面视觉与页头 | `client/styles.css` · `client/panel.jsx` | 标题 + 子标题；卡片可展开（设置页首版只要行） |
| 配置范式 | `src/config.ts` | schemastery + 容器级 `.volatile()` + 默认值/pattern |
| client→host 通路（**本插件首版不需要**） | `client/judgment-remote.js` · `@Remote` · `scripts/verify-remote.mjs` | 只有当我们要暴露自己的 Service 方法给页面时才需要（例如"自检 CLI 版本"） |
| 验证习惯 | `scripts/probe.mjs` · `verify-served.mjs` | 不靠"我觉得好了"，靠可复跑命令 |
| 消费契约 | `contract/index.ts`（**仅类型、零 import**） | `import type { Judge } from 'dsh-judgment/contract'`；运行期不引入它的任何代码 |

---

## 7. 风险与未验证项（不粉饰）

1. **版本边界**：§1.1 的实测只对 `0.38.2` 成立 → 锁 `>=0.38 <0.39`，启动即校验；升级要重跑 §1.1 的实验。
2. **输出格式**：多数命令是给人看的文本；`--json` 是全局开关但**不是每个子命令都真有结构化输出** → 只用能确认结构的命令（`snapshot --json` 已在本项目验证过 `data.snapshot` + `data.refs`），解析失败**明确报错**而不是猜。
3. **新鲜度比对的成本**：`diff snapshot` 依赖"上一次快照"，语义可疑 → 我们**不依赖它**，改用"再取一次 snapshot + digest/指纹比对"（贵一点但正确）。
4. **人机接管**：滑块/验证码需要人上手 → 必须做成一等状态（交回宿主），不能让模型傻等。
5. **会话/守护进程生命周期**与 DSH 生命周期对齐（`--idle-timeout`、`close --all`）。
6. **信任边界**：页面内容是不可信数据，绝不是指令或授权 → 工具返回值带 `--content-boundaries`，工具描述里写明。
7. **未验证**：`agent-browser` 的 `--action-policy` / `--confirm-actions` 的确切 JSON 结构与语义（CLI 帮助里只有一行）；M1 不用它，用我们自己的 `guard`。
8. **明确不支持**：Electron、Safari/iOS、云浏览器（agentcore / vercel-sandbox）先排除并写进 README。

---

## 8. 里程碑

- **M1（✅ 已完成）**：DESIGN v2 定稿；host（Service 类 + 5 个原子工具）+ client 设置页（summary + 2 开关 + 工具面 + 进阶 + 配置文件入口）；CLI 封装 + 版本锁 + 会话命名；`pnpm build` / `pnpm test`（23 项）/ `pnpm probe`（真 CLI）/ `pnpm verify:remote`（16 项）全绿。
- **M2（代码已就位，待真机联调）**：`ctx.judgment` 接入 + `browser_run` 有界循环（每步重取快照、停止门在动作前、digest 新鲜度、`input_required` / `needs_verification` handoff）；`browser_raw` + 白名单。**待办**：在「设置 → 决策」配一条 Jev 连接 + 用途 `browser.action`，跑一次真 goal。
- **M3**：动作审计（落盘 ledger）、配额可视化、Electron/云浏览器评估、`ctx.tools.guard()`（把白名单从工具内部提到整条流水线）。

---

## 9. 下一步

1. `pnpm install && pnpm build && pnpm test && pnpm verify:remote && pnpm probe`（已全绿：27 / 16 / 5 项）。
2. **已安装到 profile**（`dsh plugin --profile desktop add <本仓库>`）→ profile 的 `package.json` 多一行
   `link:` 依赖、`dsh.profile.bundles` 多一项 `dsh-agent-browser`。实测结果：
   - **新增 bundle 会热组合**：app 进程 18:48 启动、插件 22:10 才装，`scripts/verify-served.mjs`
     已经能拿到本插件的 combo bundle（7/7 关键字），skill 目录里也出现了 `agent-browser`
     （用户手装的那份 `~/.agents/skills/agent-browser` 已删除 → 只可能来自我们的
     `ctx.skills.register()`）。所以"装完要重启"这句对**新增**不成立。
   - 但 **host 半的代码改动需要重启**：改完 `lib/index.js` 后运行中的实例仍在跑旧模块
     （实测：旧错误文案 `browser_act 需要 ref 或 selector` 依旧返回）。客户端半重新构建后
     由 app 重新组合即可生效。
3. 打开 **设置 → 浏览器**：summary 应是绿色并写明版本/二进制/会话；关掉「浏览器功能」后确认模型面前**没有**浏览器工具。
4. 在 **设置 → 决策** 里建一条连接与用途 `browser.action`，然后跑一次 `browser_run`；把 trace 与 handoff 贴进 README。
