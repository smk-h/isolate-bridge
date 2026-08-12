/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : ssh-shell-exec.ts
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: 基于交互式 shell 通道的单命令执行器（exec_mode: shell）
 *
 *   适用于目标设备不支持 exec 通道、仅支持交互式 shell（如部分 Dropbear/受限登录 shell）
 *   的场景：打开 shell channel + pty，把 cmd 作为输入注入，收集 stdout 到超时或会话关闭。
 *
 *   长连接复用：按 device 缓存交互式 shell 会话，同一设备后续命令复用已建立会话，
 *   避免每条命令重新 TCP 握手 + SSH 密钥交换；会话远端关闭时自动从缓存移除，下次任务重连。
 *
 *   结束标记检测：交互式 shell 执行完命令不会关闭通道，仅靠超时兜底会白白等待。
 *   因此在命令后注入唯一 marker（echo <marker>:$?），在 stdout 中匹配到 marker 即判定命令
 *   已结束并解析退出码，无需等到超时。
 *
 *   职责边界：本文件承载「短生命周期」单命令执行，与 session/（长生命周期会话管理）
 *   共享 ShellSession 接口，但互不耦合。
 * ======================================================
 */

import type { WorkerConfig } from '../config/index.js';
import { logger } from '../log/index.js';
import { createShellSessionFactory } from './factory.js';
import type { CmdExecutor, CmdResult, ShellSession, ShellSessionFactory } from './types.js';

/**
 * 从 stdout 中剥离结束 marker 相关的行
 * 交互式 shell 会回显注入的命令（echo <marker>:$?），同时 pty 也会把命令回显出来，
 * 这两类行都含 marker，需要一并去掉，避免污染返回给上层的结果。
 * @param stdout - 原始 stdout 文本
 * @param marker - 结束标记
 * @returns 剥离 marker 相关行后的文本
 */
function stripMarkerLines(stdout: string, marker: string): string {
  return stdout
    .split(/\r?\n/)
    .filter((line) => !line.includes(marker))
    .join('\n');
}

/**
 * 基于交互式 shell 通道的单命令执行器
 */
export class SshShellExecExecutor implements CmdExecutor {
  private readonly factory: ShellSessionFactory;
  /** device → 已缓存的交互式 shell 会话（长连接复用） */
  private readonly sessions = new Map<string, ShellSession>();
  /** device → 会话建立中的 Promise（避免并发重复建连） */
  private readonly opening = new Map<string, Promise<ShellSession>>();
  /** device → 命令串行队列尾（同一会话同一时刻只跑一条命令） */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(config: WorkerConfig) {
    this.factory = createShellSessionFactory(config);
  }

  /**
   * 取或建某设备的交互式 shell 会话：命中缓存直接复用，未命中则新建并缓存
   * @param device - 调用方传入的设备名（可能 undefined）
   * @returns 已就绪的会话
   */
  private getOrOpenSession(device?: string): Promise<ShellSession> {
    const normalized = device && device.trim() !== '' ? device : 'default';
    // 命中已缓存会话直接复用，避免重复握手
    const cached = this.sessions.get(normalized);
    if (cached) {
      return Promise.resolve(cached);
    }
    // 已有正在建立中的连接则复用该 Promise，避免同一设备并发重复建连
    const inFlight = this.opening.get(normalized);
    if (inFlight) {
      return inFlight;
    }
    const p = this.factory
      .open(normalized)
      .then((session) => {
        this.sessions.set(normalized, session);
        logger.info(`[executor:ssh-shell-exec] shell session cached: device=${normalized} sessionId=${session.sessionId}`);
        // 远端关闭/会话失效时从缓存移除，下次任务自动重连
        session.onClose(() => {
          if (this.sessions.get(normalized) === session) {
            this.sessions.delete(normalized);
            logger.info(`[executor:ssh-shell-exec] shell session evicted: device=${normalized} sessionId=${session.sessionId}`);
          }
        });
        return session;
      })
      .finally(() => {
        // 建连流程结束（成功或失败）即清除 in-flight 记录，允许下次重试
        this.opening.delete(normalized);
      });
    this.opening.set(normalized, p);
    return p;
  }

  /**
   * 按 device 串行化命令：同一设备上的命令排队执行，避免并发写同一 shell 通道导致输出交错
   * @param device - 设备名（normalize 后）
   * @param task - 待执行的任务
   * @returns 任务结果
   */
  private enqueue<T>(device: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(device) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.queues.set(device, next.catch(() => {}));
    return next;
  }

  async execute(cmd: string, timeout_sec: number, device?: string): Promise<CmdResult> {
    const normalized = device && device.trim() !== '' ? device : 'default';
    const session = await this.getOrOpenSession(device);

    return this.enqueue(normalized, () => {
      logger.info(`[executor:ssh-shell-exec] shell-exec on ${session.sessionId} (device=${session.device}): ${cmd}`);
      return new Promise<CmdResult>((resolve) => {
        let stdout = '';
        let stderr = '';
        let settled = false;

        const finish = (result: CmdResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // 移除本次命令注册的会话回调，避免长连接复用时在会话上累积
          session.offStdout(onStdout);
          session.offStderr(onStderr);
          session.offClose(onClose);
          // 长连接复用：命令结束后不关闭会话，仅释放命令级回调
          resolve(result);
        };

        const timer = setTimeout(() => {
          logger.warn(`[executor:ssh-shell-exec] ${session.sessionId} shell-exec timed out after ${timeout_sec}s: ${cmd}`);
          finish({ stdout, stderr, exit_code: null, timed_out: true });
        }, timeout_sec * 1000);

        // 唯一结束标记：随机后缀避免与命令输出中的文本冲突
        const marker = `__MSG_DONE_${Math.random().toString(36).slice(2, 10)}`;
        const markerRe = new RegExp(`${marker}:(\\d+)`);

        const onStdout = (chunk: string) => {
          stdout += chunk;
          const m = stdout.match(markerRe);
          if (!m) return;
          // 匹配到结束标记：从 stdout 中剥离 marker 相关行，解析退出码并立即结束
          stdout = stripMarkerLines(stdout, marker);
          finish({ stdout, stderr, exit_code: Number(m[1]), timed_out: false });
        };
        const onStderr = (chunk: string) => { stderr += chunk; };
        const onClose = () => {
          // 会话提前关闭（远端退出），收集到的输出作为结果返回
          finish({ stdout, stderr, exit_code: null, timed_out: false });
        };
        session.onStdout(onStdout);
        session.onStderr(onStderr);
        session.onClose(onClose);

        // 注入命令并回车执行，随后注入唯一结束标记回显退出码
        session.write(`${cmd}\n`);
        session.write(`echo ${marker}:$?\n`);
      });
    });
  }

  /** 关闭所有底层会话（Worker 优雅退出时调用） */
  async close(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.close().catch(() => {});
    }
    this.sessions.clear();
    this.queues.clear();
    await this.factory.closeAll();
  }
}
