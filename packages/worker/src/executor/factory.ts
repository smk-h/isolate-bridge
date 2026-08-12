/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : factory.ts
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: 执行器与会话工厂选择——按 config 组装具体实现
 * ======================================================
 */

import type { WorkerConfig } from '../config.js';
import { Ssh2Executor } from './command.js';
import { MockSshExecutor, MockShellSessionFactory } from './mock.js';
import { ShellCmdExecutor } from './shell-cmd.js';
import { Ssh2ShellSessionFactory } from './shell.js';
import type { CmdExecutor, ShellSessionFactory } from './types.js';

/**
 * 按 config 选择执行器
 * - executor_type=mock：返回 MockSshExecutor（mock 模式忽略 exec_mode）
 * - executor_type=ssh2 且 exec_mode=shell：返回基于交互式 shell 通道的 ShellCmdExecutor
 * - executor_type=ssh2 且 exec_mode=command（默认）：返回一次性命令 Ssh2Executor
 * @param config - Worker 配置
 * @returns 执行器实例
 * @throws {Error} executor_type 非法时抛错
 */
export function createExecutor(config: WorkerConfig): CmdExecutor {
  if (config.executor_type === 'mock') {
    return new MockSshExecutor();
  }
  if (config.executor_type === 'ssh2') {
    if (config.exec_mode === 'shell') {
      return new ShellCmdExecutor(config);
    }
    return new Ssh2Executor(config);
  }
  throw new Error(`unknown executor_type: ${config.executor_type}`);
}

/**
 * 按 config 选择会话工厂（交互式 shell）
 * @param config - Worker 配置
 * @returns 会话工厂实例
 * @throws {Error} executor_type 既非 mock 也非 ssh2 时抛错
 */
export function createShellSessionFactory(config: WorkerConfig): ShellSessionFactory {
  if (config.executor_type === 'mock') {
    return new MockShellSessionFactory();
  }
  if (config.executor_type === 'ssh2') {
    return new Ssh2ShellSessionFactory(config);
  }
  throw new Error(`unknown executor_type: ${config.executor_type}`);
}
