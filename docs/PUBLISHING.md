# 发布流程

这份文档只讲一件事：**怎么把这个包发到 npm**，以及踩过的坑为什么这么绕。

包名是 `@j62268781-alt/dsh-agent-browser`。无 scope 的 `dsh-agent-browser` 在 npm 上
已被他人占用（shantanugoel/dsh-browser-control），所以只能挂在 scope 下——这也是为什么
下面所有命令都得写全名，短名会 404。

## 一次发版的完整动作

发版由 **GitHub Actions 的 tag 触发**，本地只负责"把代码和版本号推到那个状态"：

```bash
# 1. 改版本号（同时更新 CHANGELOG.md 的 [x.y.z] 段）
pnpm version patch --no-git-tag-version   # 或 minor / major

# 2. 本地先自测：构建 + 全部单测
pnpm verify

# 3. 提交、打 tag、推
git add -A && git commit -m "chore: release v0.1.1"
git tag v0.1.1
git push origin main --follow-tags
```

tag 推上去之后，`.github/workflows/release.yml` 会依次做：装依赖 → **校验 tag 与
package.json 版本一致** → `pnpm verify` → `npm publish --provenance` → `gh release create`。

### 想先演练一遍

仓库的 Actions 页面手动跑 `Release`，`dry-run` 默认是 `true` —— 它会完整装依赖、
跑测试、跑 `npm publish --dry-run`（会打出将要上传的文件清单），但不真的发布。

### 想用命令行发（不走 Actions）

只有在本机 `~/.npmrc` 里有有效 token 时才可行：

```bash
npm publish --registry=https://registry.npmjs.org/ --access public
```

## 四条必须遵守的约束（每条都是真实事故）

### ① registry 必须显式写死官方

本机默认 registry 是 `registry.npmmirror.com`（**只读镜像**），只有
`@j62268781-alt` 这个 scope 指向官方。曾经出现过 token 是对的、但登录/发布打向镜像，
于是报 `ENEEDAUTH` 的情况——看起来像 token 坏了，其实是地址错了。

所以：`.npmrc` 里 scope 要指向官方，命令行也要显式带
`--registry=https://registry.npmjs.org/`。CI 里 `setup-node` 的 `registry-url` 加上
命令行的 `--registry` 是两道保险。

### ② tag 名必须等于 package.json 的 version

`v0.1.0` 对应 `"version": "0.1.0"`。忘了 bump 版本就会被 npm 拒（"cannot publish over
previously published versions"）——那是好结果；更糟的是版本号对、tag 名写错，于是
GitHub Release 指向的 commit 和 npm 上的产物对不上。workflow 里因此在**发布之前**
先做一致性门禁。

### ③ 发布前显式跑 `pnpm verify`，不要指望 `prepublishOnly`

`prepublishOnly` 也会跑（`"prepublishOnly": "pnpm verify"`），但那是在 npm 已经接手之后，
失败信息的可读性差。显式跑一遍能让失败停在"测试"这一步。

### ④ `lib/` 是构建产物，不入库

`.gitignore` 里有 `lib/`。npm 的 `files` 白名单里有 `lib`，所以**发布前必须构建**。
漏了这条，发出去的包里没有 `lib/index.js`，用户装上就是"插件不加载"。
这条由 `prepublishOnly` 兜底，CI 里还会先跑一次 `pnpm verify`。

## NPM_TOKEN 怎么配

GitHub 仓库 Settings → Secrets and variables → Actions → `NPM_TOKEN`。

token 必须是 **Granular Access Token**：

- 权限：`Read and write`
- scope：覆盖 `@j62268781-alt`
- 旧的 **Automation token 已经不能新建了**，别去找

配好后可以用手动 `workflow_dispatch` 的 dry-run 先验证 secrets 能读到。

## 依赖上的两个坑

### `dsh-judgment` 必须用 registry 版本

`devDependencies` 里写的是 `"dsh-judgment": "^0.1.0"`，**不是** `file:../dsh-judgment`。

原因：本仓库对 `dsh-judgment` 的引用全是 `import type`（编译期擦除），只需要它的
`./contract` 类型声明；而 `file:../dsh-judgment` 这种路径依赖在 GitHub runner 上不存在，
`pnpm install --frozen-lockfile` 会直接 ENOENT，CI 根本走不到测试那一步。

想在本地针对未发布的 `dsh-judgment` 契约做实验时，用 `pnpm link ../dsh-judgment` 临时
覆盖，别把 `file:` 写回 `package.json`。

### `esbuild` 的安装脚本白名单

`pnpm-workspace.yaml` 里有 `allowBuilds: { esbuild: true }`。pnpm 10 默认不跑依赖的
postinstall，白名单去掉后 `pnpm build:client` 会找不到 esbuild 的可执行文件。

## 装到 DSH 里验证

发布完想知道"装上去到底生效没有"，光看 `dsh plugin add` 成功是不够的（那只是改了
profile 的 package.json 和 bundles）。真正的判据是 app 的 boot 数据里出现了本插件的
客户端 bundle：

```bash
pnpm verify:served     # 需要 DSH 正在运行；端口用 DSH_AUTHORITY 覆盖
pnpm verify:remote     # 不需要运行中的应用：真的起 host + gateway 交叉验证 Remote 通路
```
