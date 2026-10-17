/**
 * 包清单纪律测试 —— 钉住一次真实事故，防止同类问题第二次发生。
 *
 * 事故（2026-10-17，dsh 从 0.2.0-rc.2 升到 0.2.1-rc.1 之后）：本插件的 peer 里
 * 写着精确版本 `"@deepseek-ai/dsh-typert-protocol": "0.2.0-rc.2"`，运行中的应用这样判：
 *
 *   { "code": "incompatible-version",
 *     "incompatible": [{ "name": "…", "version": "0.1.0",
 *                        "runtimeVersion": "0.2.1-rc.1",
 *                        "requirements": { "@deepseek-ai/dsh-typert-protocol": "0.2.0-rc.2" } }] }
 *
 * 后果不是"少个功能"，而是 **bundle 的 rows 变 0 → 整个插件不被组合**：
 * 设置页整块消失、host 半不加载，看上去像"插件坏了"。
 * 判定入口：运行中的应用的 `pluginManager/listBundles`（或设置页的 Plugins 面板）。
 *
 * 所以：host 侧 seam 的 peer 依赖只允许**区间**（`>=` / `^` / `*`），不允许精确版本。
 * devDependencies 仍允许钉精确版本（构建要可复现），但必须满足 peer 的最低要求，
 * 且应与 app 实际运行的内核版本对齐。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

/** 精确版本：可选 `v` 前缀 + 纯 semver（含 prerelease），不含任何区间运算符。 */
const EXACT = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

test('peer 依赖必须是区间，不能精确钉死（精确钉死会在 app 升版时被判 incompatible-version）', () => {
  const pinned = Object.entries(manifest.peerDependencies ?? {})
    .filter(([, range]) => EXACT.test(String(range)))
  assert.deepEqual(
    pinned,
    [],
    '这些 peer 写成了精确版本，app 升版时会整插件被判 incompatible-version：' + JSON.stringify(pinned),
  )
})

test('peer 依赖覆盖我们真正用到的 host 侧 seam', () => {
  const peers = manifest.peerDependencies ?? {}
  for (const name of [
    '@deepseek-ai/cordis',
    '@deepseek-ai/schemastery',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-typert-protocol',
  ]) {
    assert.equal(typeof peers[name], 'string', `缺少 peer：${name}`)
  }
  // 与 dsh-judgment 的联动是可选依赖：缺了要能降级，所以允许 `*`，但必须声明出来。
  assert.equal(typeof peers['dsh-judgment'], 'string', '缺少可选 peer：dsh-judgment（缺失时应降级为「只执行、不判断」）')
})

test('devDependencies 可以钉精确版本，但不能低于 peer 的最低要求', () => {
  const peers = manifest.peerDependencies ?? {}
  const dev = manifest.devDependencies ?? {}
  for (const [name, pinned] of Object.entries(dev)) {
    const range = peers[name]
    if (range === undefined) continue
    const floor = /^>=\s*v?(\d+)\.(\d+)\.(\d+)/.exec(range)
    if (floor === null) continue
    // `file:` / `link:` / `workspace:` / git 等是路径或源码 spec，不是版本，不在本测试范围内。
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(pinned)
    if (match === null) continue
    const [major, minor, patch] = match.slice(1).map(Number)
    const [fMajor, fMinor, fPatch] = floor.slice(1).map(Number)
    const atLeast = major > fMajor
      || (major === fMajor && (minor > fMinor || (minor === fMinor && patch >= fPatch)))
    assert.ok(atLeast, `devDependency ${name}@${pinned} 低于 peer 要求 ${range}`)
  }
})

test('bundle 声明的 patch 文件必须真的存在（否则整个 bundle 组合时被跳过）', async () => {
  const patch = manifest.dsh?.bundle?.patch
  if (patch === undefined) return
  await assert.doesNotReject(
    readFile(new URL(patch.replace(/^\.\//, ''), root)),
    `package.json 里 dsh.bundle.patch="${patch}" 指向的文件不存在，bundle 会被跳过`,
  )
})
