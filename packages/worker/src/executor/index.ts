/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: 执行器模块入口——统一 re-export 类型、实现与工厂
 *   对外符号面与旧 executor.ts 完全一致，供 main.ts / session.ts / 单测 import。
 * ======================================================
 */

export type { CmdResult, CmdExecutor, ShellSession, ShellSessionFactory } from './types.js';
export { MockSshExecutor, MockShellSessionFactory } from './mock.js';
export { Ssh2Executor } from './command.js';
export { Ssh2ShellSessionFactory } from './shell.js';
export { ShellCmdExecutor } from './shell-cmd.js';
export { createExecutor, createShellSessionFactory } from './factory.js';
