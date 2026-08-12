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

import { readFile } from 'node:fs/promises';

import { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';

import type { WorkerConfig } from '../config/index.js';
import { findSshConfig } from '../config/index.js';
import type { SshConfig } from '../config/index.js';
import { logger } from '../log/index.js';
import type { ShellSession, ShellSessionFactory } from './types.js';

/** ssh2 shell channel + pty 的交互式会话封装 */
class SshSession implements ShellSession {
  readonly sessionId: string;
  readonly device: string;
  private readonly stream: import('ssh2').ClientChannel;
  private readonly stdoutCbs: Array<(chunk: string) => void> = [];
  private readonly stderrCbs: Array<(chunk: string) => void> = [];
  private readonly closeCbs: Array<() => void> = [];
  private closed = false;

  constructor(sessionId: string, device: string, stream: import('ssh2').ClientChannel) {
    this.sessionId = sessionId;
    this.device = device;
    this.stream = stream;

    stream.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      for (const cb of [...this.stdoutCbs]) cb(text);
    });
    if (stream.stderr) {
      stream.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        for (const cb of [...this.stderrCbs]) cb(text);
      });
    }
    stream.on('close', () => {
      this.closed = true;
      for (const cb of [...this.closeCbs]) cb();
      this.closeCbs.length = 0;
    });
    stream.on('error', (e: Error) => {
      logger.warn(`[executor] ${sessionId} shell stream error: ${e.message}`);
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
  private readonly connectTimeoutMs = 10000;

  constructor(private readonly config: WorkerConfig) {}

  async open(device?: string): Promise<ShellSession> {
    const normalized = device && device.trim() !== '' ? device : 'default';
    // 按设备查 SSH 配置，未找到则抛错（调用方回写失败结果）
    const sshConfig = findSshConfig(this.config, normalized === 'default' ? undefined : normalized);
    if (!sshConfig) {
      throw new Error(`no ssh config for device "${normalized}"`);
    }

    const sessionId = `ssh_${++this.counter}`;
    logger.info(`[executor] opening shell ${sessionId}: device=${normalized} host=${sshConfig.host}:${sshConfig.port} user=${sshConfig.username}`);

    // 建连 → 打开 shell channel + pty → 封装为会话对象
    const client = await this.connect(sshConfig, sessionId);
    this.clients.add(client);

    const stream = await this.openShellChannel(client, sessionId);
    const session = new SshSession(sessionId, normalized, stream);
    this.sessions.add(session);
    // 会话关闭时同步释放连接与缓存记录
    session.onClose(() => {
      this.sessions.delete(session);
      this.clients.delete(client);
    });
    logger.info(`[executor] ${sessionId} shell opened`);
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

  private connect(sshConfig: SshConfig, sessionId: string): Promise<import('ssh2').Client> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const connectCfg: ConnectConfig = {
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username,
        readyTimeout: this.connectTimeoutMs,
        keepaliveInterval: 15000,
      };

      const doConnect = () => client.connect(connectCfg);
      if (sshConfig.private_key_path) {
        readFile(sshConfig.private_key_path, 'utf-8')
          .then((keyContent) => {
            connectCfg.privateKey = keyContent;
            if (sshConfig.password) {
              connectCfg.passphrase = sshConfig.password;
            }
            doConnect();
          })
          .catch((err) => {
            reject(new Error(`[executor] ${sessionId} read private key failed: ${err.message}`));
          });
      } else if (sshConfig.password) {
        connectCfg.password = sshConfig.password;
        doConnect();
      } else {
        reject(new Error(`[executor] ${sessionId} no auth: neither private_key_path nor password`));
        return;
      }

      const timer = setTimeout(() => {
        client.end();
        reject(new Error(`[executor] ${sessionId} connect timeout after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs + 5000);

      client.once('ready', () => {
        clearTimeout(timer);
        resolve(client);
      });
      client.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`[executor] ${sessionId} connect error: ${err.message}`));
      });
    });
  }

  private openShellChannel(client: import('ssh2').Client, sessionId: string): Promise<import('ssh2').ClientChannel> {
    return new Promise((resolve, reject) => {
      client.shell({ term: 'xterm', cols: 120, rows: 40 }, (err, stream) => {
        if (err) {
          reject(new Error(`[executor] ${sessionId} open shell channel failed: ${err.message}`));
          return;
        }
        resolve(stream);
      });
    });
  }
}
