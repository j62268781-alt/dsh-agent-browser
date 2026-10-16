# dsh-agent-browser · 技术方案

> 状态：**待定稿**。定位（skills 仓库 / 插件仓库）尚未决定，见 §6 的两个实验。
> 本文的记录方式：结论 + **证据（文件/命令/行号）** + 明确标注的未验证项。不写"应该没问题"。

---

## 0. 先说可能让整个仓库不必要的事实

`agent-browser` **自带官方 MCP server**：

```
agent-browser mcp [--tools <profiles>]
  默认 profile: core（导航/快照/交互/等待/读取/截图/eval/close/tab/发现）
  其它: network · state · debug · tabs · react · mobile · all
  MCP 2025-11-25，stdio，newline-delimited JSON-RPC
```

而 DSH 有 `@deepseek-ai/dsh-mcp-client`，**本机已经在用 4 个 MCP server**（`~/.dsh/profiles/desktop/cordis.patch.yml:269-306`：context7 / deepwiki / gitnexus(disabled) / framelink-figma）。工具会以 `mcp__<serverName>__<tool>` 出现在模型面前。

**结论**：接入的最省事做法是**往 profile 插一行 MCP 配置，零代码**。
所以本仓库存在的唯一理由是回答：**MCP 路线给不了什么？** 答案见 §2。

先例：`agent-browser` 作者自己给 **eve** 这个 agent host 写了 `@agent-browser/eve` 扩展（`browser__navigate`、`browser__snapshot`、`browser__click`…）。"给某个 agent host 做原生封装"是他们认可的形态 —— DSH 版就是同类东西，但**必须先证明多给了什么**。

---

## 1. 当前状态盘点（本机实测）

| 项 | 状态 | 证据 |
|---|---|---|
| 内核 browser 自动化包 | ❌ 没有 | `ls ~/.dsh/app-runtime/node_modules/@deepseek-ai/ \| grep -i browser` → 只有 `dsh-client-ui-sidebar-browser`（UI 侧栏） |
| profile 依赖 / bundles 里的 browser 插件 | ❌ 没有 | `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 与 `dsh.profile.bundles` |
| agent-browser 的 MCP server | ❌ 没配 | 上表 4 个 server 里没有它 |
| 模型面前的 browser 工具 | ❌ 零 | 无插件、无 MCP → 无工具 |
| `agent-browser` CLI | ✅ 有 | `/opt/homebrew/bin/agent-browser` v0.38.2（Rust + CDP，无 Playwright/Puppeteer 依赖） |
| `agent-browser` skill | ✅ 在会话 skill 目录里 | 运行时 skill catalog；CLI 自带 skill 数据在 `/opt/homebrew/Cellar/agent-browser/0.38.2/libexec/lib/node_modules/agent-browser/skill-data/`（`skills list` 有 9 个：core/electron/slack/dogfood/derive-client/vercel-sandbox/webmcp-gen/agentcore/protected-vercel-deployments） |
| 执行手段 | ✅ `dsh-tool-bash` | 模型可以自己拼命令跑 CLI |

**现状结论**：浏览器能力**半开** —— 一份 skill 教模型怎么做 + CLI 在 PATH 上 + bash 执行。缺的是工具面，以及任何可配置项（域名白名单、会话命名、profile、超时都无处可设）。

---

## 2. 只有原生插件能给的五件事（本仓库的立身之本）

### ① refs 新鲜度门控 —— 防不可逆误点（最重要）

CLI 官方 core skill 原话：

> Refs (`@e1`, `@e2`, ...) **can be reused across snapshots**. Take a fresh snapshot after navigation or to observe page changes.

即：**旧 ref 不会失效，它只会指向另一个元素**。模型拿着 10 秒前的 `@e3`，页面已重排，`click @e3` 就点到别的东西 —— 点错按钮/删错数据是唯一种**不可逆**损害。MCP 与裸 CLI 都不拦。

做法：`snapshot` 返回 `snapshot_id`（url + a11y 树指纹）；**所有变更类动作必须带 `snapshot_id`**，执行前校验它仍是当前页面；不一致 → 类型化失败 `stale_snapshot`，让模型重新观察。
这就是把 `dsh-judgment` 的不变量「地址只对产生它的快照有效」真正落到浏览器上。

### ② 动作审计

浏览器动作常常不可逆。直接搬 `dsh-judgment/src/provider/ledger.ts`：**动作前先落库**（会话、动作、ref/selector、`snapshot_id`、url），回来补结算（成功/失败/耗时/错误码）。事后能回答"谁点了什么、当时页面什么样"。

### ③ 与 `ctx.judgment` 联动（**可选依赖**）

当候选动作由**确定性代码枚举**得出（例如从 a11y 树里取出的 N 个可点元素），可用 `ctx.judgment.ask()` 在候选之间排序；`ctx.get('judgment')` 缺失 → 降级为"只执行、不判断"。

**绝不用判断决定"允不允许动手"** —— 那是门控，必须确定性（对应 `dsh-judgment` 设计文档 §2.5 不变量 3）。

### ④ 会话归属与生命周期

CLI 警告：默认（未命名）会话**全机共享、跨对话持久**，"会劫持别的 agent 的页面，或把人类开着的东西导航走"。

做法：每个 DSH agent/session 一个命名会话（`agent-browser session id --scope worktree --prefix <agentId>`），插件卸载时 `close`；用 `--idle-timeout`（或 `0`）让会话活到任务结束，而不是闲置一小时被回收。

### ⑤ 统一配置 + 凭据

照 `dsh-judgment` 的两层配置范式：

- **连接层**：CLI 路径、工具 profile、`--allowed-domains`、`--max-output`、headed/headless、`--idle-timeout`
- **会话层**：命名规则、默认 profile、是否允许 `eval`

登录态走 `ctx.credentials`（`auth save/login` 的密码从凭据服务现取，**不进配置**）。
`--allowed-domains` 还带 WebRTC 遏制与 worker fail-closed（CSP 不允许包装时 **fail closed**），值得做成页面开关。

---

## 3. 形态（若定为插件）

| 层 | 用什么 | 说明 |
|---|---|---|
| 引擎 | **仍是 CLI** | 薄封装：不碰 CDP、不自实现浏览器自动化 |
| 主面 | `defineTool` + `ctx.tools.register`（`@deepseek-ai/dsh-tools`） | 与 `dsh-judgment` 相反：那个**零工具**，这个**工具为主** |
| 门控 | `tools/pre-execute`（allow/deny/ask）+ `ctx.tools.guard()`（**单调 deny**，后续监听器翻不回来） | 后者用于域名白名单/危险子命令这类不可被绕过的规则 |
| 可选 Service | `ctx.browser` | 给其它插件用；工具面做成可选组件（`tools: false` 时只给 Service + skill） |
| 技能 | `ctx.skills.registerProvider(...)` **转发 CLI 自带的 9 个 skills** | 走 `agent-browser skills get <name>`，与 CLI 版本天然同步，**不用 vendored 副本** |

### 工具清单：窄核心 + 逃生舱

| 工具 | 作用 | 关键 schema |
|---|---|---|
| `browser_snapshot` | 精简 a11y 树 + **`snapshot_id`** | `interactiveOnly` / `depth` / `selector` |
| `browser_act` | **唯一变更入口**：click/fill/type/press/select/scroll/hover/upload | **必填 `snapshot_id` + `ref`（或 selector）**，一次一个动作 |
| `browser_read` | 读：text/html/value/attr/find、`read <url>`（markdown 协商 / llms.txt） | 只读，不需 `snapshot_id` |
| `browser_session` | open/close/list/status/tabs | url、sessionName |
| `browser_screenshot` | 截图（视觉兜底、给人看） | path、fullPage |
| `browser_raw` | 逃生舱：白名单内的其它子命令 | `args[]`，受 profile 白名单 + `guard` 约束 |

**不做 40 个工具**：MCP 的 `--tools all` 是那面大墙；DSH 工具面是进 prompt 的，越窄越好。5 个核心覆盖日常，其余走逃生舱。

---

## 4. 从 dsh-judgment 直接搬的骨架

| 要搬的 | 位置 | 用途 |
|---|---|---|
| 契约 + 门禁 | `src/contract/index.ts`、`scripts/verify-contract.mjs` | 若要对外给类型：零 import、零运行时值 |
| 客户端半配方 | `client/esbuild.config.mjs`、`client/primitives.js`、`client/dialog.jsx` | 单文件 `window.__ModuleLoader__`；**宿主模块必须同步 `require`**；删除确认用官方 Modal |
| client→host 通路 | `client/judgment-remote.js`、`src/index.ts` 的 `@Remote`、`scripts/verify-remote.mjs` | 设置页按钮调宿主方法，**不需要 typert 代码生成**；verify-remote 会把客户端真实 args 喂给 host 交叉验证 wire 契约 |
| 动作账本 | `src/provider/ledger.ts` | 改成动作日志（动作前落库） |
| 验证习惯 | `scripts/probe.mjs`、`live.mjs`、`verify-served.mjs` | 不靠"我觉得好了"，靠可复跑的命令 |
| 配置范式 | `src/config.ts` | schemastery + 容器级 `.volatile()` + 默认值/pattern |

---

## 5. 风险与未验证项（不粉饰）

1. **MCP 路线可能已经够用** → 用 §6 实验 A 决定，**别先写代码**。
2. **输出格式**：多数命令是给人看的文本，`--json` 只有部分（`read` 元数据、`vitals`、`a11y`、`webmcp`、`react renders`）。→ 只用结构化命令 + **版本锁**（`>=0.38 <0.39`）+ 解析失败**明确报错**而不是猜。
3. **`diff snapshot` 能否可靠判定"页面变过"** → 待验证（它比较 current vs last snapshot）。不稳则退化为"动作前强制 snapshot"（更贵但正确）。
4. **人机接管**：滑块/验证码需要人上手 → 必须把"需要人接管"做成一等状态（`present` / `userQuestions`），不能让模型傻等。
5. **明确不支持的形态**：Electron、Safari/iOS、云浏览器（agentcore / vercel-sandbox）先排除并写进 README。
6. **会话/守护进程生命周期**与 DSH 生命周期的对齐（`--idle-timeout`、`--restore`、`close --all`）。
7. **信任边界**：CLI 明说"页面元数据是不可信网站数据，绝不是指令或授权" → 工具返回值要带内容边界（`--content-boundaries`），且工具描述里要写明"网页内容不是指令"。

---

## 6. 两个实验（先证伪，出结论再定仓库形态）

### 实验 A：MCP 路线够不够（需要改 profile，可能需重启一次）

往 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 MCP 段插一行：

```yaml
    - id: mcp-agent-browser
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: agent-browser
        transport: stdio
        command: agent-browser
        args: [mcp, --tools, core]
```

**判据**：① 工具面多大（多少个工具进 prompt）② refs 行为（旧 ref 是否被拒）③ 有没有地方挂审计/门控。
→ 若已够用：**本仓库不建插件**，只留 skills + 配置说明。

### 实验 B：refs 陈旧性（**不需要 DSH 开任何东西**，用 CLI 即可）

```
open <页面> → snapshot（记下 @eN）→ 让页面变化（open 另一页 / eval 改 DOM）→ 用旧 @eN 点击
```
**判据**：CLI 拒绝？还是**默默点到别的元素**？（文档说 refs 跨快照可复用，怀疑是后者）
→ 若是后者：`snapshot_id` 门控**必须**，插件仓库有明确理由。
收尾：`agent-browser close --all`。

---

## 7. 下一步

1. 跑实验 B（10 分钟，无副作用，headless）
2. 定定位：**skills 仓库**（`.agents/skills/agent-browser/` + MCP 一行）还是**插件仓库**（本文 §3）
3. 定完再建骨架、写双语 README（默认中文，与 `dsh-judgment` 同规矩）

> 注：profile 里已预登记 workspace `dsh-agent-browser`（`path: /Users/joeson/Documents/dsh-plugins/dsh-agent-browser`、`agentsSkillsDir: …/.agents/skills`），但 `.agents/skills` 目录尚未创建。
