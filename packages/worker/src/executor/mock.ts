/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : mock.ts
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: Mock 执行器与 Mock 交互式 shell 会话（测试用，不真实连网）
 * ======================================================
 */

import type { CmdExecutor, CmdResult, ShellSession, ShellSessionFactory } from './types.js';

/**
 * Mock SSH 执行器
 * 执行时打印命令信息并返回固定文本，不真实连网
 */
export class MockSshExecutor implements CmdExecutor {
  /**
   * 打印命令信息并返回固定文本
   * @param cmd - 待执行命令
   * @param _timeout_sec - 超时秒数（mock 模式忽略，仅做极短延时）
   * @param _device - 目标设备名（mock 模式忽略）
   * @returns 固定文本结果
   */
  async execute(cmd: string, _timeout_sec: number, _device?: string): Promise<CmdResult> {
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
 * Mock 交互式 shell 会话
 * 打开时生成唯一 sessionId，写入的输入会回显为 mock 输出，供测试验证摆渡链路。
 */
class MockShellSession implements ShellSession {
  readonly sessionId: string;
  readonly device: string;
  private readonly stdoutCbs: Array<(chunk: string) => void> = [];
  private readonly stderrCbs: Array<(chunk: string) => void> = [];
  private readonly closeCbs: Array<() => void> = [];
  private closed = false;

  constructor(sessionId: string, device: string) {
    this.sessionId = sessionId;
    this.device = device;
    // 打开后回显一行提示
    this.emitStdout(`[mock-shell] session ${sessionId} ready (device=${device})\n`);
  }

  /**
   * 写入 stdin（交互式输入）：按行回显并模拟结束标记回显
   * @param data - 输入内容（UTF-8 文本）
   */
  write(data: string): void {
    // 输入按行回显，模拟交互式 shell 的 echo
    for (const line of data.split(/\r?\n/)) {
      if (line !== '') {
        this.emitStdout(`[mock-shell] $ ${line}\n`);
        // 模拟结束标记回显（echo <marker>:$? → <marker>:0），使 marker 检测在 mock 下可验证
        const markerMatch = line.match(/^echo\s+(__MSG_DONE_\w+):\$\?$/);
        if (markerMatch) {
          this.emitStdout(`${markerMatch[1]}:0\n`);
        }
      }
    }
  }

  onStdout(cb: (chunk: string) => void): void { this.stdoutCbs.push(cb); }
  offStdout(cb: (chunk: string) => void): void { this.removeCb(this.stdoutCbs, cb); }
  onStderr(cb: (chunk: string) => void): void { this.stderrCbs.push(cb); }
  offStderr(cb: (chunk: string) => void): void { this.removeCb(this.stderrCbs, cb); }
  onClose(cb: () => void): void { this.closeCbs.push(cb); }
  offClose(cb: () => void): void { this.removeCb(this.closeCbs, cb); }

  /**
   * 从订阅回调数组中移除指定回调
   * @param arr - 回调数组
   * @param cb - 待移除的回调
   */
  private removeCb<T>(arr: Array<T>, cb: T): void {
    const idx = arr.indexOf(cb);
    if (idx !== -1) {
      arr.splice(idx, 1);
    }
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.emitStdout('[mock-shell] session closed\n');
    for (const cb of this.closeCbs) cb();
    this.closeCbs.length = 0;
    return Promise.resolve();
  }

  /**
   * 向所有 stdout 订阅者广播一段输出
   * @param chunk - 输出的 UTF-8 文本块
   */
  private emitStdout(chunk: string): void {
    for (const cb of [...this.stdoutCbs]) cb(chunk);
  }
}

/**
 * Mock 会话工厂：每次 open 都新建一个 MockShellSession，不真实连网
 */
export class MockShellSessionFactory implements ShellSessionFactory {
  private readonly sessions = new Set<MockShellSession>();
  private counter = 0;

  async open(device?: string): Promise<ShellSession> {
    const normalized = device && device.trim() !== '' ? device : 'default';
    const session = new MockShellSession(`ssh_${++this.counter}`, normalized);
    this.sessions.add(session);
    return session;
  }

  async closeAll(): Promise<void> {
    for (const s of [...this.sessions]) {
      await s.close();
      this.sessions.delete(s);
    }
  }
}
