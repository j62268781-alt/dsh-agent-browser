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

┌ ● 浏览器环境就绪                              [检查安装] ┐   ← summary：绿（两项都过）/ 红
│   ✓ agent-browser   已安装 0.38.2                      │     检查就**两项**，路径之类的细节不显示
│   ✗ Chrome          没找到                             │     缺 CLI 时右侧多一个 [安装]（用户点击才跑）
│     修法：装 Chrome：https://www.google.com/chrome/     │
└────────────────────────────────────────────────────────┘

[浏览器功能        Switch]  ← 14px 标题 + 12px 子标题；每行 16px 竖距 + .5px 下边框
[决策              Switch]
[截图工具          Switch]
[逃生舱 browser_raw Switch]
[允许域名          input]  → --allowed-domains
[会话名            input]  → --session
[有头模式          Switch] → --headed
[命令超时(ms)      input]  → 我们的 spawn 超时
[最大输出(字符)    input]  → --max-output
[空闲超时          input]  → --idle-timeout
[内容边界标记      Switch] → --content-boundaries
[打开配置文件      按钮]   在系统文本编辑器中打开宿主设置文档（本插件配置就在里面）
```

**为什么要拉平**：分组标题（工具面/进阶/配置文件）会打断"每一行都一样"的节奏。
General 的设置页就是一条平铺的行流：**同一条 16px 竖距 + 同一条 `.5px` 下边框，
只有整页最后一行没有**（General 的 `:last-child{border-bottom:none}`）。我们照抄，
按钮也照抄 skills-mcp 的 `.smp-button`（**`flex:none` 是重点**——少了它，按钮会被
左列 `flex:1` 的文本挤成"检/查/安/装"竖排，这是真机截图里出现过的）。

### 4.3 实现事实（都已核对）

- 页面注册：`ctx.slots.register({ name:'settings.section', id:'browser', order:…, label:()=>'浏览器', inject:… }, Panel)`；客户端半打包成 `window.__ModuleLoader__` 单文件（照 [dsh-judgment/client/esbuild.config.mjs](../../dsh-judgment/client/esbuild.config.mjs)）。
- 读写：`ctx.configForms.get(entryId)` → `form.set(field, value)`，**不需要 Remote**。
- **「打开配置文件」不是插件能自己占的**：它是 settings 提供方的**全局**动作——`settings/openSettingsDocument()`（无路径参数，返回 `{opened:true}`），可用性由 `settings.describe().hasDocument` 决定（`@deepseek-ai/dsh-api-settings-controller`）。外壳自己调 `ctx.remote.settings.openSettingsDocument()`（`dsh-client-ui-settings-general/lib/client.js:822`）。
  → 我们的做法：**注入 `remote.settings`，页面上放一行同款入口**（`hasDocument` 为假时禁用并说明），打开的就是宿主持有的设置文档——本插件的配置段就在里面。**不假装**能打开一个我们私有的文件。
- 依赖注入：`export const inject = ['slots','configForms','remote']`；`remote.settings` 与 `remote.browser` 都用 `ctx.get()` 取（它们可能缺席，写进静态 inject 会把整个客户端半挡住）。

### 4.4 安装自检（summary 绿 / 红）

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

## 5. 决策形态（v2 定稿）

### 5.1 「是否启用决策」的确切语义（两种可观察形态）

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
