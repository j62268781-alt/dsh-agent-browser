# dsh-agent-browser

面向 **DeepSeek Harness** 的浏览器自动化插件：把 [`agent-browser`](https://www.npmjs.com/package/agent-browser)
（Rust + CDP）接成一组**窄工具** + 一个**设置页**，可选再挂一个由 [`dsh-judgment`](../dsh-judgment/README.md)
判断的**目标循环**。

**语言：** 中文（本文件） · [English](README.en.md)

> 为什么不是 MCP：`agent-browser mcp` 会把几十个原子动作全局塞进模型上下文，而它**结构上做不到**
> 插件内部的有界循环、每步新鲜度门控、动作审计与设置页。形态取舍的完整论证见 [DESIGN.md](DESIGN.md) §1.2。
> 参考的三个同类项目（`jev-browser-use` / `jkudish/jev-browser` / `forvela/jev-agent-browser`）
> 也都不走"把动作墙交给模型"这条路——它们的形态是**一个 delegate 工具 + 代码拥有循环**。

---

## 状态（诚实清单）

| 项 | 状态 |
|---|---|
| 设置页（安装自检 summary + 平铺行流 + 开关/输入 + 打开配置文件） | ✅ 已实现 |
| 安装自检：**两项**（CLI / Chrome）+ 帮忙装 CLI | ✅ 已实现（host `@Remote probe/installCli` + 客户端手写 contribution，`pnpm verify:remote` 交叉验证） |
| 内置 skill（`skills/agent-browser/`：核心命令 + 5 份 references） | ✅ 已实现（`ctx.skills.register()` 运行时注册，装插件即得） |
| `browser_snapshot` / `browser_act` / `browser_read` / `browser_session` / `browser_screenshot` | ✅ 已实现 |
| `browser_raw` 逃生舱（白名单） | ✅ 已实现，默认关 |
| `browser_run`（决策循环，judge = `ctx.judgment`） | ✅ 已实现（首次真机联调待做：需要一条 Jev 连接） |
| CLI 版本锁 `>=0.38 <0.39` | ✅ 已实现（实测基准 0.38.2） |
| 动作审计落盘 / 配额可视化 | ⏳ 见 DESIGN.md §8（M3） |

**实测**：`pnpm probe` 会 spawn 真浏览器跑一遍（版本锁 → snapshot refs → 按 ref 点击 → 陈旧 ref 被拒）。
陈旧 ref 的实测结论（**不会**静默点到别的元素）是 DESIGN v2 §1.1 的立身证据。

---

## 安装

```bash
# 本地路径（开发用；profile 名见 ~/.dsh/profiles）
dsh plugin --profile desktop add /Users/joeson/Documents/dsh-plugins/dsh-agent-browser
```

装完在 **设置 → 浏览器** 里配置。本插件**零 MCP**：只在 `enabled` 为真时注册工具；
关掉「浏览器功能」= 一个工具都不进模型上下文。

`agent-browser` 需要单独装：

```bash
brew install agent-browser        # 或 npm i -g agent-browser
agent-browser --version           # 必须在 [0.38.0, 0.39.0)
```

---

## 工具面（窄核心 + 逃生舱）

| 工具 | 作用 |
|---|---|
| `browser_snapshot` | 无障碍树 + `@eN` refs，返回 `origin` / `refs` / `digest`。**先快照再动作**。 |
| `browser_act` | **唯一变更入口**，一次一个动作：click/fill/type/press/select/scroll/hover/check/uncheck/upload/dblclick/focus。可带 `expectUrl` / `expectName` 做执行前的新鲜度断言。 |
| `browser_read` | 只读：`read <url>`（markdown / llms.txt 协商）或读元素的 text/html/value/attr/title/url/count。 |
| `browser_session` | `open` / `close` / `tabs`。固定使用命名会话，不劫持别的 agent 或人类开着的窗口。 |
| `browser_screenshot` | 截图（可关）。 |
| `browser_raw` | 逃生舱：白名单内的其它 CLI 子命令（`get` / `find` / `network` / `storage` …）；禁 `mcp`/`chat`/`install`/`plugin`/`connect`/`auth`/`--cdp`/`--profile`。默认关。 |
| `browser_run` | **决策开才注册**：一句话 goal → 插件内部有界循环 → `trace` + handoff。 |

### 关于 ref

ref 是**元素身份绑定**的（0.38.2 实测）：页面变了、元素没了、换页了，旧 ref 会给
`Unknown ref` / `Could not locate element with role=… name=…` —— **不会**点到别的元素。
所以本插件**不设** `snapshot_id` 强制门控；`browser_act` 的 `expectUrl` / `expectName`
是**可选**的额外保险。详见 [DESIGN.md](DESIGN.md) §1.1（含复现命令）。

---

## 内置 skill

插件自带一份**与已装 CLI 版本对齐的核心 skill**（`skills/agent-browser/`）：

- `SKILL.md`（130 行）：核心循环、两个最容易做错的点（会话隔离、等待）、定位优先级、可见性/复用登录态、
  安全护栏、排障表；
- `references/`：`commands.md`（34KB，需要时才读）、`snapshot-refs.md`、`session-management.md`、
  `authentication.md`、`trust-boundaries.md`。

插件启动时用 `ctx.skills.register()` 把它注册成**运行时 skill**（`resourceBase` 指向 references 目录，
模型可按需读取绝对路径），并在末尾**追加**一段插件补充（工具名、`browser_run`、references 路径）——
SKILL.md 原文逐字不改，避免两份真相漂移。

为什么不直接用官方全量 skills：`agent-browser skills get core --full` 与 9 个专门技能（electron / slack /
dogfood …）很全，但不适合作为常驻目录；需要时仍可用 `agent-browser skills get <name>` 现拉。

> `ctx.skills` 是**可选**服务：宿主没装 `dsh-skill` 时跳过注册，插件其余部分照常工作。

---

## 安装自检（设置页顶部 summary）

进「设置 → 浏览器」自动跑一次，**只有两项**（路径之类的细节不显示）。按钮只有两个状态：
**环境可用 → 灰色「已安装」（不可点）**；**环境不可用（或还没检查过）→ 「检查安装」（可点，修完能重新确认）**。

| 项 | 通过 | 不通过 |
|---|---|---|
| **agent-browser** | `已安装 0.38.2` | `本机没安装` + 修法，并出现 **[安装]** 按钮（Homebrew 优先，否则 `npm i -g`；**点了才跑**） |
| **Chrome** | `已就绪（Google Chrome 155）` | `没找到` + 下载入口（Chrome 是必须项：没有它页面根本驱动不了） |

两项都过 → 卡片是绿的（`浏览器环境就绪`）；任一项不过 → 红，直接摊开原因与修法。

**Chrome 为什么不帮忙装**：`brew install --cask google-chrome` 在 macOS 上要管理员密码，
一个后台进程挂着等密码是最糟的交互。CLI 可以（纯用户态安装），Chrome 只给命令与链接。

Chrome 的判定优先用 CLI 自己的 `agent-browser doctor --quick --json`（约 0.5s，它认得环境变量、
engine 与自定义路径）；CLI 不可用时退回文件系统 / PATH 探测，消息写「没找到」而不是「没有」。

## 性能（实测，2026-10 · agent-browser 0.38.2）

| 被测 | 均值 |
|---|---|
| `spawn /bin/echo`（spawn 下限） | 1.2ms |
| `spawn bash -c …`（bash 路线） | 1.4ms ← **比直接 spawn 更贵** |
| `agent-browser --version`（PATH 上的 Node 包装脚本） | 57.3ms |
| **原生二进制** `--version` / `get title` / `snapshot -i` / `click @e2` | **3.1 / 3.7 / 5.1 / 16.8ms** |

所以：

- 插件比"用 bash 调 CLI"**更省**，不是更贵：bash 是 shell + CLI 两次 spawn，插件是直接一次。
- PATH 上的 `agent-browser` 是 Node 包装脚本（Homebrew / npx 都如此），每次调用白付一份 Node 启动。
  插件默认**自动解析到同目录的原生二进制**（`agent-browser-<platform>-<arch>`），砍掉 11–15 倍启动开销；
  要指定别的就配 `browser.executablePath`（带 `/` 时原样使用）。`brew upgrade` 后旧路径失效会**自动重解析重试一次**。
- 决策循环里 CLI 不是瓶颈：一步 ≈ 22ms，而一次 Jev 判断是 **500ms 量级**；真正的收益是
  **N 步压进 1 个宿主轮次**，而不是省那几毫秒。

`pnpm probe` 会打印实际使用的命令与每条命令耗时，数字可复跑。

---

## 决策（`browser_run`）

「决策」开启后多一个 `browser_run(goal)`：插件内部跑一个**有界循环**——

```
每步重新快照 → 代码枚举候选（refs + scroll/back/wait/done，文本输入不入候选）
  → ctx.judgment.ask(state, { action: choice, goal_done: noul, stuck: noul }, { purpose: 'browser.action' })
  → 停止门在**动作之前**判定（goal_done / stuck）
  → 执行前再取一次快照比对，变了就丢弃这次决策（stale_state）
  → 执行**一个**动作 → 记 history → 下一步
```

纪律：

- **门控是确定性的，判断只做排序**：域名白名单等硬规则由 CLI 的 `--allowed-domains` 负责，绝不交给判断。
- **文字/密钥不决策**：需要时以 `input_required` 交回宿主，由宿主提供值。
- **结束语是 `needs_verification`**，不是"已完成"——最终校验留给宿主。
- **降级必须显式**：没有 `ctx.judgment`、用途名未配置、密钥缺失、配额耗尽 → 类型化失败 + 明确文案，绝不静默退回主模型假装在决策。

判断走 [`dsh-judgment`](../dsh-judgment/README.md)：在 **设置 → 决策** 里建一条连接，
把用途名 `browser.action` 指向它（默认值就是这个）。换厂商/模型/密钥只改那里，不动本插件。

---

## 开发

```bash
pnpm install
pnpm build            # host(tsc) + 客户端(esbuild → lib/client.js)
pnpm test             # 注册面 + 自检 + 页面渲染 + 纯逻辑（29 项，不需要真 DSH）
pnpm typecheck
pnpm verify:remote    # Remote 通路交叉验证（17 项）：host SRC fallback ↔ 手写 contribution
pnpm verify:served    # 问运行中的应用：boot 数据里有没有本插件的客户端半（7 项）
pnpm probe            # 真 CLI 探针（会开浏览器，结束前自动关掉自己的会话）
```

目录：

```
src/config.ts   配置（schemastery；开关决定工具注册）
src/cli.ts      agent-browser CLI 薄封装：spawn · JSON 信封 · 版本锁 · 原生二进制解析
src/task.ts     browser_run 的有界循环（消费 ctx.judgment）
src/env.ts      环境探测（Chrome / 安装计划 / 跑命令）——自检那两项的本机侧
src/skill.ts    内置 skill 的加载与注册
src/index.ts    入口：Service 类（工具注册 + @Remote probe 自检）
client/         设置页（统一 JSX，esbuild 打成 window.__ModuleLoader__ 单文件）
skills/         随包发布的核心 skill（SKILL.md + references/）
tests/          注册面 · 自检 · 纯逻辑
scripts/        probe.mjs（真 CLI）· verify-remote.mjs（Remote 通路）
```

> ⚠️ **新增/客户端改动的生效方式**（实测）：`dsh plugin add` 之后 app 会**热组合**新的 bundle
> （无需重启：boot 数据里立刻有本插件，skill 目录里也出现了 `agent-browser`）。
> 但 **host 半是 Node 模块，改完 `lib/index.js` 要重启 DSH** 才会换上新代码；客户端半重新构建即生效。
> 配置项写的是 **volatile** 字段：**不会**重建 entry，工具注册由服务监听 `loader/volatile-update` 自己重做，
> 所以改完即时生效、也不需要重启。

> ⚠️ **兼容性**：DSH 的 boot 会把插件 `peerDependencies` 里 `@deepseek-ai/dsh-*` 的**版本范围**
> 拿去和「dsh 运行时版本」比对，不满足就**整个跳过这个 bundle**（日志一行 `dsh: skipping profile bundle`）。
> 所以这里用的是跨版本区间（`>=0.2.0-rc.2 <0.3.0`），**不要精确钉死**某个 dsh 版本。
> 当前验证过的运行时：dsh 0.2.1-rc.1 / cordis 4.0.5 / schemastery 3.18.5 /
> dsh-tools 0.2.1-rc.1 / dsh-typert-protocol 0.2.1-rc.1。

> **决策循环**（`browser_run`）的设计参考了三家实现并做了实测校准：
> fan-out 五问里的停止门在动作之前；`goal_done` 只认「页面可见正文」这一个字段；
> 重复且无效的动作从**概率分布**里换次优候选；两次无效即停；状态超 12k 截断并显式标注；
> 结束时只给 `needs_verification` + `next`（"怎么验"），从不宣布完成。
> 真机端到端：`pnpm e2e`（真 Chrome + 真 Jev，两步点击后被独立确认为 SUCCESS）。

> ⚠️ **「决策」依赖 dsh-judgment**（依赖在 `package.json` 里显式声明：`peerDependencies.dsh-judgment`
> + `peerDependenciesMeta.dsh-judgment.optional = true`，所以不装也能用插件，只是不能开决策）。
> 设置页的判定是**四态**的——`ready`（可开启）/ `checking`（自检未返回）/ `unknown`（自检失败或
> host 半版本不匹配）/ `missing`（宿主明确说没有 `ctx.judgment`）。**只有 `ready` 才允许开启**：
> 其余三态开关一律置灰并说明原因；点开启时还会向宿主 `checkJudgment()` **现问一次**（不信任缓存），
> 依赖不在就不写配置。宿主侧也有兜底：`apply()` 发现 `tools.decision` 开着但依赖缺失只警告、不注册工具。

## 许可

MIT
