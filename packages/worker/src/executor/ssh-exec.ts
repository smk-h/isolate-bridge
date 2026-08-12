/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : ssh-exec.ts
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: ssh2 一次性命令执行器（exec 通道）
 *   - SshExecExecutor：按设备名查 SSH 配置 → 建连接 → 生成 ssh_N 会话 id →
 *     后续同一设备复用该连接发命令；连接失败抛 SshConnectionFailed。
 * ======================================================
 */

import { readFile } from 'node:fs/promises';

import { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';

import type { WorkerConfig } from '../config/index.js';
import { findSshConfig } from '../config/index.js';
import type { SshConfig } from '../config/index.js';
import { logger } from '../log/index.js';
import type { CmdExecutor, CmdResult } from './types.js';

/** 已建立的 exec 会话条目（按设备名复用） */
interface ExecSession {
  /** 会话 id，形如 ssh_1、ssh_2，全局自增 */
  sessionId: string;
  /** 设备名（normalize 后：显式设备名或 'default'） */
  device: string;
  /** ssh2 Client 实例 */
  client: Client;
}

/**
 * ssh2 真实执行器
 *
 * 按 device 查 SSH 配置；首次命中某设备时建连接并生成 ssh_N 形式的会话 id，
 * 后续同一设备复用已建连接发命令，避免每条命令重新握手。
 * 连接失败抛 Error（调用方据此回写 failed 结果）。
 */
export class SshExecExecutor implements CmdExecutor {
  /** 设备名 → 会话条目（含已建立的 ssh2 Client） */
  private readonly sessions = new Map<string, ExecSession>();
  /** 全局会话自增计数器，生成 ssh_1、ssh_2… */
  private sessionCounter = 0;
  /** 默认连接超时（毫秒） */
  private readonly connectTimeoutMs = 10000;

  constructor(private readonly config: WorkerConfig) {}

  /**
   * 执行命令：按 device 复用或新建连接，exec 一条命令并回收 stdout/stderr/exit_code
   * @param cmd - 待执行 SSH 命令
   * @param timeout_sec - 命令执行超时秒数
   * @param device - 目标设备名（可选，未指定走默认设备）
   * @returns stdout/stderr/exit_code/timed_out
   */
  async execute(cmd: string, timeout_sec: number, device?: string): Promise<CmdResult> {
    const session = await this.getOrCreateSession(device);
    logger.info(`[executor:ssh-exec] execute on ${session.sessionId} (device=${session.device}): ${cmd}`);

    return this.runCommand(session, cmd, timeout_sec);
  }

  /**
   * 查询某设备已建立的会话 id（未连接返回 undefined）
   * 供审计等外部模块读取 ssh_target 用。
   * @param device - 目标设备名（可选）
   * @returns 会话 id 或 undefined
   */
  getSessionId(device?: string): string | undefined {
    const normalized = this.normalizeDevice(device);
    return this.sessions.get(normalized)?.sessionId;
  }

  /**
   * 关闭所有已建立的 SSH 连接，供 Worker 优雅退出时调用
   */
  async close(): Promise<void> {
    const closes: Promise<void>[] = [];
    for (const [, session] of this.sessions) {
      closes.push(this.closeSession(session));
    }
    this.sessions.clear();
    await Promise.all(closes);
  }

  // ── 内部实现 ──

  /**
   * 归一化设备名：未指定或空串统一为 'default'
   */
  private normalizeDevice(device?: string): string {
    return device && device.trim() !== '' ? device : 'default';
  }

  /**
   * 取或建某设备的 SSH 会话
   * - 已建立则直接复用
   * - 未建立则查 config 拿 SshConfig，握手成功后存入 sessions 并返回
   * @param device - 调用方传入的设备名（可能 undefined）
   * @returns 会话条目
   * @throws {Error} 设备未配置 / 连接失败
   */
  private async getOrCreateSession(device?: string): Promise<ExecSession> {
    const normalized = this.normalizeDevice(device);
    const existing = this.sessions.get(normalized);
    if (existing) {
      return existing;
    }

    // 查 SSH 配置：显式设备名 → default → 旧 ssh 字段
    const sshConfig = findSshConfig(this.config, normalized === 'default' ? undefined : normalized);
    if (!sshConfig) {
      throw new Error(`no ssh config for device "${normalized}"`);
    }

    const sessionId = `ssh_${++this.sessionCounter}`;
    logger.info(`[executor:ssh-exec] connecting ${sessionId}: device=${normalized} host=${sshConfig.host}:${sshConfig.port} user=${sshConfig.username}`);

    const client = await this.connect(sshConfig, sessionId);
    const session: ExecSession = { sessionId, device: normalized, client };
    this.sessions.set(normalized, session);
    logger.info(`[executor:ssh-exec] ${sessionId} connected`);
    return session;
  }

  /**
   * 建立 ssh2 连接，握手成功返回 Client，失败抛错
   */
  private connect(sshConfig: SshConfig, sessionId: string): Promise<Client> {
    return new Promise<Client>((resolve, reject) => {
      const client = new Client();
      const connectCfg: ConnectConfig = {
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username,
        readyTimeout: this.connectTimeoutMs,
        keepaliveInterval: 15000,
      };

      // 认证方式：优先私钥（可带 passphrase），其次密码，两者皆无则报错
      if (sshConfig.private_key_path) {
        readFile(sshConfig.private_key_path, 'utf-8')
          .then((keyContent) => {
            connectCfg.privateKey = keyContent;
            // 密码在私钥场景下作为私钥 passphrase（若配置了）
            if (sshConfig.password) {
              connectCfg.passphrase = sshConfig.password;
            }
            client.connect(connectCfg);
          })
          .catch((err) => {
            reject(new Error(`[executor:ssh-exec] ${sessionId} read private key failed: ${err.message}`));
          });
      } else if (sshConfig.password) {
        connectCfg.password = sshConfig.password;
        client.connect(connectCfg);
      } else {
        reject(new Error(`[executor:ssh-exec] ${sessionId} no auth: neither private_key_path nor password`));
        return;
      }

      // 连接超时兜底：超时强制断连并拒绝
      const timer = setTimeout(() => {
        client.end();
        reject(new Error(`[executor:ssh-exec] ${sessionId} connect timeout after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs + 5000);

      // 握手成功后清除超时定时器并交付 Client
      client.once('ready', () => {
        clearTimeout(timer);
        resolve(client);
      });

      client.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`[executor:ssh-exec] ${sessionId} connect error: ${err.message}`));
      });
    });
  }

  /**
   * 在已建立的会话上执行一条命令，超时或异常时回收通道
   */
  private runCommand(session: ExecSession, cmd: string, timeout_sec: number): Promise<CmdResult> {
    return new Promise<CmdResult>((resolve) => {
      const timeoutMs = timeout_sec * 1000;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        logger.warn(`[executor:ssh-exec] ${session.sessionId} command timed out after ${timeout_sec}s: ${cmd}`);
        // 超时直接回退结果，通道由 ssh2 内部在 close 事件后回收
        resolve({
          stdout: '',
          stderr: '',
          exit_code: null,
          timed_out: true,
        });
      }, timeoutMs);

      session.client.exec(cmd, (err, s) => {
        // exec 通道打开失败：直接返回错误信息
        if (err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            stdout: '',
            stderr: err.message,
            exit_code: null,
            timed_out: false,
          });
          return;
        }

        let stdout = '';
        let stderr = '';
        let exitCode: number | null = null;

        // 分别累积 stdout / stderr 输出
        s.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
        s.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
        // exit 事件仅记录退出码，最终以 close 事件为准交付结果
        s.on('exit', (code: number | null) => {
          exitCode = code;
        });
        // 通道关闭：命令执行完毕，交付最终结果
        s.on('close', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            stdout,
            stderr,
            exit_code: exitCode,
            timed_out: false,
          });
        });
        // 通道异常：附上已收集的 stderr 与错误信息返回
        s.on('error', (e: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            stdout,
            stderr: stderr + (stderr ? '\n' : '') + e.message,
            exit_code: null,
            timed_out: false,
          });
        });
      });
    });
  }

  /**
   * 关闭单个会话：end() 触发 ssh2 优雅断连
   */
  private closeSession(session: ExecSession): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      session.client.once('close', finish);
      session.client.once('end', finish);
      try {
        session.client.end();
      } catch {
        finish();
      }
      // 兜底：1s 内未收到 close/end 事件也强行结束
      setTimeout(finish, 1000);
    });
  }
}
