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
   真机：hao123 的城市切换入口）。

实测（hao123，4 步）：`snapshot 98ms · ask 1196ms（5 次）· act 231ms`，**tokens 5,350**
（旧路径同规模 19–28k）→ 单次判断平均 **~1.07k tokens / ~239ms**，比之前 4.3k / ~380ms
降了 4 倍（tokens）与 1.6 倍（延迟）。**仍受判断层质量限制**：Σp 欠归一依然要靠重采。

**实现注意**：`batch` 会把每条命令按空白切分，而 JS 关键字之间必须有空白——所以抽取
**不能放进 batch**，单走一次 `eval`（反而更省进程）；`--content-boundaries` 会把 `eval`
输出包住，解析前必须剥掉。

### 4.5.3 顺手修掉的两个真 bug（都是 e2e 跑出来的）

1. **`open` 返回 ≠ 导航已提交**：真机（0.38.2）上紧接着取快照还是 `about:blank`，
   决策循环只看到滚动/等待候选、白跑几步才超时。`open()` 现在轮询 `get url` 直到落地（≤5s）。
2. **`close` 返回 ≠ 守护进程已退出**：紧接着 `open` 会挂到正在退出的 daemon 上，导航变成 no-op。
   实测 6 次里 4 次失败；`close()` 之后加 300ms settle 后 **6/6 成功**（e2e 连跑 3 次全绿）。
   `open()` 另加一次"close → 等 → open"兜底，仍不动就抛 `open-stalled`（不静默留在空白页）。

> 这两个 bug 都不会在单条命令里暴露，只有"open 之后立刻操作"/"close 之后立刻 open"才触发——
> 正是 `browser_run` 这种连续循环的典型用法。

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
