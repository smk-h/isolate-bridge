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
 *   - 连接复用与失效检测收敛到公共连接层 SshClientCache：
 *     缓存 client 监听 close/error 自动驱逐，下次任务惰性重连，并发建连去重。
 * ======================================================
 */

import type { WorkerConfig } from '../config/index.js';
import { findSshConfig } from '../config/index.js';
import { logger } from '../log/index.js';
import { connectClient, SshClientCache } from './ssh-conn.js';
import type { CmdExecutor, CmdResult } from './types.js';

/**
 * ssh2 真实执行器
 *
 * 按 device 查 SSH 配置；首次命中某设备时建连接并生成 ssh_N 形式的会话 id，
 * 后续同一设备复用已建连接发命令，避免每条命令重新握手。
 * 连接失效（client close/error）时由 SshClientCache 自动驱逐缓存，下次任务自动重连。
 * 连接失败抛 Error（调用方据此回写 failed 结果）。
 */
export class SshExecExecutor implements CmdExecutor {
  /** 公共连接缓存：设备名 → client 会话（含失效检测 + 惰性重连 + 建连去重） */
  private readonly cache: SshClientCache;

  constructor(private readonly config: WorkerConfig) {
    this.cache = new SshClientCache();
  }

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

    return this.runCommand(session.client, session.sessionId, cmd, timeout_sec);
  }

  /**
   * 查询某设备已建立的会话 id（未连接返回 undefined）
   * 供审计等外部模块读取 ssh_target 用。
   * @param device - 目标设备名（可选）
   * @returns 会话 id 或 undefined
   */
  getSessionId(device?: string): string | undefined {
    return this.cache.getSessionId(this.normalizeDevice(device));
  }

  /**
   * 关闭所有已建立的 SSH 连接，供 Worker 优雅退出时调用
   */
  async close(): Promise<void> {
    await this.cache.closeAll();
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
   * - 已缓存且未失效则直接复用（连接失效已由 SshClientCache 自动驱逐）
   * - 未命中则查 config 拿 SshConfig，握手成功后存入缓存并返回
   * @param device - 调用方传入的设备名（可能 undefined）
   * @returns 会话条目
   * @throws {Error} 设备未配置 / 连接失败
   */
  private async getOrCreateSession(device?: string): Promise<{ sessionId: string; device: string; client: import('ssh2').Client }> {
    const normalized = this.normalizeDevice(device);

    // 查 SSH 配置：显式设备名 → default → 旧 ssh 字段
    const sshConfig = findSshConfig(this.config, normalized === 'default' ? undefined : normalized);
    if (!sshConfig) {
      throw new Error(`no ssh config for device "${normalized}"`);
    }

    return this.cache.getOrCreate(normalized, sshConfig, connectClient);
  }

  /**
   * 在已建立的连接上执行一条命令，超时或异常时回收通道
   * @param client - 已建立的 ssh2 Client
   * @param sessionId - 会话 id（日志定位用）
   * @param cmd - 待执行命令
   * @param timeout_sec - 超时秒数
   * @returns 命令执行结果
   */
  private runCommand(client: import('ssh2').Client, sessionId: string, cmd: string, timeout_sec: number): Promise<CmdResult> {
    return new Promise<CmdResult>((resolve) => {
      const timeoutMs = timeout_sec * 1000;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        logger.warn(`[executor:ssh-exec] ${sessionId} command timed out after ${timeout_sec}s: ${cmd}`);
        // 超时直接回退结果，通道由 ssh2 内部在 close 事件后回收
        resolve({
          stdout: '',
          stderr: '',
          exit_code: null,
          timed_out: true,
        });
      }, timeoutMs);

      client.exec(cmd, (err, s) => {
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
}
