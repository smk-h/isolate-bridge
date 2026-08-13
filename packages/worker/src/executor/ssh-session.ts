/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : ssh-session.ts
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: ssh2 真实交互式 shell 会话与工厂（shell channel + pty）
 *   会话生命周期由调用方（session.ts）管理，与一次性命令执行器（SshExecExecutor）解耦。
 * ======================================================
 */

import type { WorkerConfig } from '../config/index.js';
import { findSshConfig } from '../config/index.js';
import { logger } from '../log/index.js';
import { connectClient } from './ssh-conn.js';
import type { ShellSession, ShellSessionFactory } from './types.js';
import { FileLogger, isLogSaveEnabled, SSH_SHELL_LOG_DIR } from '@smai-kit/msgferry-shared';
import { join } from 'node:path';

/** ssh2 shell channel + pty 的交互式会话封装 */
class SshSession implements ShellSession {
  readonly sessionId: string;
  readonly device: string;
  private readonly stream: import('ssh2').ClientChannel;
  private readonly stdoutCbs: Array<(chunk: string) => void> = [];
  private readonly stderrCbs: Array<(chunk: string) => void> = [];
  private readonly closeCbs: Array<() => void> = [];
  private readonly fileLogger = new FileLogger();
  private closed = false;

  constructor(
    sessionId: string,
    device: string,
    stream: import('ssh2').ClientChannel,
    logRoot?: string,
  ) {
    this.sessionId = sessionId;
    this.device = device;
    this.stream = stream;

    // SSH shell 原始会话日志：仅 LOG_SAVE 开启时落盘到 <logRoot>/<device>/ssh_<id>_<ts>.log
    if (logRoot && isLogSaveEnabled()) {
      this.fileLogger.enableForShell(logRoot, device, sessionId);
    }

    stream.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      this.fileLogger.write(text);
      for (const cb of [...this.stdoutCbs]) cb(text);
    });
    if (stream.stderr) {
      stream.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        this.fileLogger.write(text);
        for (const cb of [...this.stderrCbs]) cb(text);
      });
    }
    stream.on('close', () => {
      this.closed = true;
      for (const cb of [...this.closeCbs]) cb();
      this.closeCbs.length = 0;
    });
    stream.on('error', (e: Error) => {
      logger.warn(`[executor:ssh-session] ${sessionId} shell stream error: ${e.message}`);
    });
  }

  /**
   * 写入 stdin（交互式 shell 输入）
   * @param data - 输入内容（UTF-8 文本）
   */
  write(data: string): void {
    this.stream.write(data, 'utf-8');
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
    this.fileLogger.disable();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      this.stream.once('close', finish);
      try {
        this.stream.end();
      } catch {
        finish();
      }
      // 兜底：1s 内未关闭也强行结束
      setTimeout(finish, 1000);
    });
  }
}

/**
 * ssh2 真实会话工厂
 * 每个会话独立建立一条 SSH 连接，打开 shell channel + pty 后交回会话对象。
 * 与一次性命令执行器（SshExecExecutor）解耦，会话生命周期由调用方（session.ts）管理。
 */
export class SshSessionFactory implements ShellSessionFactory {
  private readonly sessions = new Set<SshSession>();
  private readonly clients = new Set<import('ssh2').Client>();
  private counter = 0;

  constructor(private readonly config: WorkerConfig) {}

  async open(device?: string): Promise<ShellSession> {
    const normalized = device && device.trim() !== '' ? device : 'default';
    // 按设备查 SSH 配置，未找到则抛错（调用方回写失败结果）
    const sshConfig = findSshConfig(this.config, normalized === 'default' ? undefined : normalized);
    if (!sshConfig) {
      throw new Error(`no ssh config for device "${normalized}"`);
    }

    const sessionId = `ssh_${++this.counter}`;
    logger.info(`[executor:ssh-session] opening shell ${sessionId}: device=${normalized} host=${sshConfig.host}:${sshConfig.port} user=${sshConfig.username}`);

    // 建连 → 打开 shell channel + pty → 封装为会话对象
    const client = await connectClient(sshConfig, sessionId);
    this.clients.add(client);

    const stream = await this.openShellChannel(client, sessionId);
    // SSH shell 原始会话日志根目录：<hgfs_root>/logs/ssh-shell（LOG_SAVE 开启时有效）
    const logRoot = join(this.config.hgfs_root, SSH_SHELL_LOG_DIR);
    const session = new SshSession(sessionId, normalized, stream, logRoot);
    this.sessions.add(session);
    // 会话关闭时同步释放连接与缓存记录
    session.onClose(() => {
      this.sessions.delete(session);
      this.clients.delete(client);
    });
    logger.info(`[executor:ssh-session] ${sessionId} shell opened`);
    return session;
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions];
    this.sessions.clear();
    for (const s of sessions) {
      await s.close();
    }
    const clients = [...this.clients];
    this.clients.clear();
    for (const c of clients) {
      try {
        c.end();
      } catch {
        // 忽略单连接关闭异常
      }
    }
  }

  private openShellChannel(client: import('ssh2').Client, sessionId: string): Promise<import('ssh2').ClientChannel> {
    return new Promise((resolve, reject) => {
      client.shell({ term: 'xterm', cols: 120, rows: 40 }, (err, stream) => {
        if (err) {
          reject(new Error(`[executor:ssh-session] ${sessionId} open shell channel failed: ${err.message}`));
          return;
        }
        resolve(stream);
      });
    });
  }
}
