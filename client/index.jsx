/**
 * 客户端入口（browser half）。
 *
 * 一件事：在设置里注册一个 `settings.section` 页面（`id: browser`），把该插件的配置表单、
 * settings 的 Remote（打开配置文件）与插件自己的自检 Remote 交给它。
 */

import './react.js'
import { browserContribution } from './browser-remote.js'
import { findForm } from './config.js'
import { primitives } from './primitives.js'
import { Panel } from './panel.jsx'

/** 浏览器侧需要的服务：槽位 + 配置表单 + remote（`remote.settings` 开配置文件）。 */
export const inject = ['slots', 'configForms', 'remote']

export async function apply(ctx) {
  // entry id 在注册时就解析一次：页面渲染时宿主不会再变。
  const { form, entryId } = findForm(ctx)

  // `settings/openSettingsDocument` 由 settings 控制器提供。用 `ctx.get`（**不带 inject 守卫**
  // 的取法）拿命名空间：写进静态 inject 会在它缺席时把整个客户端半挡住。
  let settings
  try {
    settings = ctx.get('remote.settings')
  } catch {
    settings = undefined
  }

  // 配置文件入口只在宿主确认"能准备一份本地文档"时出现（非 loopback 永远没有）。
  let hasDocument = false
  try {
    hasDocument = ctx.configForms?.describe?.()?.hasDocument === true
  } catch {
    hasDocument = false
  }

  // 自检通路：必须在注册槽位**之前** mount——页面渲染时那个命名空间就得存在。
  // 失败就退化成"没有自检"，页面其余部分照常可用。
  let browser
  try {
    await ctx.remote.$mount(browserContribution())
  } catch (error) {
    console.warn('[agent-browser] Remote $mount 失败，安装自检将不可用：', error)
  }
  try {
    browser = ctx.get('remote.browser')
  } catch (error) {
    browser = undefined
    console.warn('[agent-browser] 取 remote.browser 失败，安装自检将不可用：', error)
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    // 排在「通用」(10) 与「决策」(21) 之后。
    id: 'browser',
    order: 22,
    label: () => '浏览器',
    inject: () => ({ form, entryId, primitives, settings, hasDocument, browser }),
  }, Panel))
}
