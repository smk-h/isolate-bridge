/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : executor.ts
 * Author     : MsgFerry
 * Date       : 2026/08/07
 * Version    : 0.0.1
 * Description: SSH 执行器接口与 Mock 实现
 * ======================================================
 */

import type { WorkerConfig } from './config.js';

/** SSH 执行结果 */
export interface SshResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
}

/** SSH 执行器接口 */
export interface SshExecutor {
  /**
   * 执行命令并返回结果
   * @param cmd - 待执行命令
   * @param timeout_sec - 超时秒数
   * @returns 执行结果
   */
  execute(cmd: string, timeout_sec: number): Promise<SshResult>;
}

/**
 * Mock SSH 执行器
 * 执行时打印命令信息并返回固定文本，不真实连网
 */
export class MockSshExecutor implements SshExecutor {
  /**
   * 打印命令信息并返回固定文本
   * @param cmd - 待执行命令
   * @param timeout_sec - 超时秒数（mock 模式忽略，仅做极短延时）
   * @returns 固定文本结果
   */
  async execute(cmd: string, _timeout_sec: number): Promise<SshResult> {
    // 模拟极短执行延时，便于测试优雅退出窗口
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stdout = `[mock] executed: ${cmd}\n`;
    return {
      stdout,
      stderr: '',
      exit_code: 0,
      timed_out: false,
    };
  }
}

/**
 * 按 config 选择执行器
 * @param config - Worker 配置
 * @returns 执行器实例
 * @throws {Error} executor_type 为 ssh2 时抛错（本章未实现）
 */
export function createExecutor(config: WorkerConfig): SshExecutor {
  if (config.executor_type === 'mock') {
    return new MockSshExecutor();
  }
  // 真实 ssh2 实现预留，后续章节填充
  throw new Error('ssh2 executor not implemented yet');
}
