/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: 策略模块入口——统一 re-export 校验逻辑与模板引导
 *   校验逻辑（check.ts）与策略模板引导（template.ts）同属安全策略模块。
 * ======================================================
 */

export {
  DEFAULT_POLICY,
  loadPolicy,
  parseCmd,
  checkCommand,
  createPolicyWatcher,
} from './check.js';
export type { DefaultAction, PolicyRule, PolicyResult } from './check.js';
export { ensurePolicyTemplate } from './template.js';
