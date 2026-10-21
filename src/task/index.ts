/**
 * `src/task/index.ts`：按核心功能拆分的决策模块统一导出。
 *
 * 目录职责划分：
 * - `types.ts`      — 公共类型、阈值常量与交回提示契约
 * - `utils.ts`      — 纯工具函数（哈希、语义签名、快照 diff、键名/词元解析、截断）
 * - `candidates.ts` — 候选枚举、目标相关性排序与特殊动作面（悬停/拖拽/按键）注入
 * - `gates.ts`      — 确定性门控与字段状态匹配（状态守卫、URL/提交完成证据、次优候选概率门槛）
 * - `judge.ts`      — Jev 判断层协议（问题构造、调用封装、二阶段选值、独立确认）
 * - `actions.ts`    — 浏览器动作执行（fill/select/click/hover/drag/press）与页面等待
 * - `loop.ts`       — 有界决策主循环（`runTask`）与子目标编排（`runSubgoals`）
 */

export * from './types.js'
export * from './utils.js'
export * from './candidates.js'
export * from './gates.js'
export * from './judge.js'
export * from './actions.js'
export * from './loop.js'
