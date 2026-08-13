/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : session.ts
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: 交互式 shell 会话管理——基于文件队列做 stdin/stdout 双向摆渡
 *
 *   职责边界（与 executor/ 解耦）：
 *     - 本模块（session/index.ts）：**长生命周期**会话管理——负责对每个 running
 *       会话建立 shell、轮询 stdin 注入、将输出落盘、处理关闭与空闲超时，
 *       会话生命周期全程由本模块驱动（tick）。
 *     - executor/ssh-shell-exec.ts：**短生命周期**单命令执行——在 shell 通道上跑单条命令，
 *       用完即走，长连接复用由它自己管理。
 *   两者共享 executor/ 的 ShellSession 接口，职责清晰无重复。
 *
 *   会话目录约定（<hgfs_root>/sessions/<session_id>/）：
 *     - session.json  会话元信息（SessionTask，status=running）
 *     - stdin/        内网写入的输入文件（<seq>.input），Worker 轮询读取后注入 shell
 *     - stdout/       Worker 回写的输出文件（<seq>.output），供内网轮询读取
 *     - close.marker  内网写入的关闭标记，触发会话关闭
 *   受限于 HGFS 轮询延迟，仅适合低频交互，不适合 vim 等全屏 TUI。
 * ======================================================
 */

import { join } from 'node:path';
import {
  readdir,
  readFile,
  writeFile,
  mkdir,
  stat,
  unlink,
  rename,
} from 'node:fs/promises';

import {
  SESSIONS_DIR,
  SESSION,
  SessionStatus,
  formatBeijingTimestamp,
} from '@smai-kit/msgferry-shared';
import type { SessionTask } from '@smai-kit/msgferry-shared';

// 仅依赖 executor/ 的 ShellSession 协议接口，不耦合具体 ssh2/mock 实现
import type { ShellSession, ShellSessionFactory } from '../executor/index.js';
import { logger } from '../log/index.js';

const TMP_SUFFIX = '.tmp';
const INPUT_SUFFIX = '.input';
const OUTPUT_SUFFIX = '.output';

/**
 * 初始化会话根目录（<root>/sessions）
 * @param root - HGFS 共享根目录
 */
export async function initSessionsDir(root: string): Promise<void> {
  await mkdir(join(root, SESSIONS_DIR), { recursive: true });
}

/**
 * 解析会话目录完整路径
 * @param root - HGFS 共享根目录
 * @param sessionId - 会话唯一标识
 * @returns 会话根目录绝对路径
 */
function sessionDir(root: string, sessionId: string): string {
  return join(root, SESSIONS_DIR, sessionId);
}

/**
 * 列出会话根目录下所有会话 id（过滤 .tmp 半成品与非目录）
 * @param root - HGFS 共享根目录
 * @returns session_id 列表
 */
export async function listSessions(root: string): Promise<string[]> {
  const dir = join(root, SESSIONS_DIR);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of entries) {
    if (name.endsWith(TMP_SUFFIX)) continue;
    const full = join(dir, name);
    try {
      const s = await stat(full);
      if (s.isDirectory()) {
        ids.push(name);
      }
    } catch {
      // 忽略无法访问的条目
    }
  }
  return ids;
}

/**
 * 读取会话元信息（<root>/sessions/<id>/session.json）
 * @param root - HGFS 共享根目录
 * @param sessionId - 会话唯一标识
 * @returns 会话结构体，读取失败返回 null
 */
export async function readSessionMeta(root: string, sessionId: string): Promise<SessionTask | null> {
  const metaPath = join(sessionDir(root, sessionId), SESSION.meta);
  try {
    const content = await readFile(metaPath, 'utf-8');
    return JSON.parse(content) as SessionTask;
  } catch {
    return null;
  }
}

/**
 * 回写会话元信息（原子写）
 * @param root - HGFS 共享根目录
 * @param session - 会话结构体
 */
export async function writeSessionMeta(root: string, session: SessionTask): Promise<void> {
  const dir = sessionDir(root, session.session_id);
  await mkdir(dir, { recursive: true });
  const metaPath = join(dir, SESSION.meta);
  const tmpPath = `${metaPath}${TMP_SUFFIX}`;
  await writeFile(tmpPath, JSON.stringify(session), 'utf-8');
  await rename(tmpPath, metaPath);
}

/**
 * 列出 stdin 目录下待注入的输入序号（<seq>.input，过滤 .tmp 半成品）
 * @param root - HGFS 共享根目录
 * @param sessionId - 会话唯一标识
 * @returns 输入序号升序列表
 */
export async function listStdinInputs(root: string, sessionId: string): Promise<number[]> {
  const stdinDir = join(sessionDir(root, sessionId), SESSION.stdin);
  let entries: string[];
  try {
    entries = await readdir(stdinDir);
  } catch {
    return [];
  }
  const seqs: number[] = [];
  for (const name of entries) {
    if (!name.endsWith(INPUT_SUFFIX) || name.startsWith(TMP_SUFFIX)) continue;
    const base = name.slice(0, -INPUT_SUFFIX.length);
    const seq = Number(base);
    if (Number.isFinite(seq)) {
      seqs.push(seq);
    }
  }
  return seqs.sort((a, b) => a - b);
}

/**
 * 读取并删除一个 stdin 输入文件，返回其内容
 * @param root - HGFS 共享根目录
 * @param sessionId - 会话唯一标识
 * @param seq - 输入序号
 * @returns 输入内容
 */
export async function readAndRemoveStdinInput(
  root: string,
  sessionId: string,
  seq: number,
): Promise<string> {
  const filePath = join(sessionDir(root, sessionId), SESSION.stdin, `${seq}${INPUT_SUFFIX}`);
  const content = await readFile(filePath, 'utf-8');
  await unlink(filePath).catch(() => {
    // 已被其他流程删除时忽略
  });
  return content;
}

/**
 * 写一个 stdout 输出文件（<root>/sessions/<id>/stdout/<seq>.output，原子写）
 * @param root - HGFS 共享根目录
 * @param sessionId - 会话唯一标识
 * @param seq - 输出序号
 * @param chunk - 输出内容
 */
export async function writeStdoutOutput(
  root: string,
  sessionId: string,
  seq: number,
  chunk: string,
): Promise<void> {
  const stdoutDir = join(sessionDir(root, sessionId), SESSION.stdout);
  await mkdir(stdoutDir, { recursive: true });
  const filePath = join(stdoutDir, `${seq}${OUTPUT_SUFFIX}`);
  const tmpPath = `${filePath}${TMP_SUFFIX}`;
  await writeFile(tmpPath, chunk, 'utf-8');
  await rename(tmpPath, filePath);
}

/**
 * 检查会话关闭标记是否存在
 * @param root - HGFS 共享根目录
 * @param sessionId - 会话唯一标识
 * @returns 存在返回 true
 */
export async function checkSessionCloseMarker(root: string, sessionId: string): Promise<boolean> {
  try {
    const markerPath = join(sessionDir(root, sessionId), SESSION.close_marker);
    await stat(markerPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 原子写会话关闭标记（供关闭流程落盘留痕；通常由内网写入触发关闭）
 * @param root - HGFS 共享根目录
 * @param sessionId - 会话唯一标识
 */
export async function writeSessionCloseMarker(root: string, sessionId: string): Promise<void> {
  const dir = sessionDir(root, sessionId);
  await mkdir(dir, { recursive: true });
  const markerPath = join(dir, SESSION.close_marker);
  const tmpPath = `${markerPath}${TMP_SUFFIX}`;
  await writeFile(tmpPath, '', 'utf-8');
  await rename(tmpPath, markerPath);
}

/**
 * 交互式会话管理器
 * 负责对每个 running 会话建立 shell、轮询 stdin 注入输入、将输出落盘、处理关闭。
 * 主循环由 Worker 驱动（tick），或由会话自己持有工厂独立轮询。
 */
export class SessionManager {
  private readonly factories = new Map<string, ShellSession>();
  private readonly stdoutSeq = new Map<string, number>();
  private readonly lastActive = new Map<string, number>();
  /** 已进入关闭流程的会话 id（防并发重复 finalize） */
  private readonly closing = new Set<string>();
  /** 会话级写队列：串行化元信息写，避免并发 rename 竞态 */
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(
    private readonly root: string,
    private readonly factory: ShellSessionFactory,
  ) {}

  /**
   * 打开一个交互式会话（建立 shell，注入初始命令）
   * @param session - 会话结构体（status 应为 running）
   */
  async open(session: SessionTask): Promise<void> {
    if (this.factories.has(session.session_id)) {
      logger.warn(`[session] ${session.session_id} already open, skip`);
      return;
    }
    logger.info(`[session] opening ${session.session_id} device=${session.device ?? 'default'}`);
    const shell = await this.factory.open(session.device);
    this.factories.set(session.session_id, shell);
    // 输出序号与最后活跃时间随会话初始化，供后续落盘与空闲判定使用
    this.stdoutSeq.set(session.session_id, session.stdout_seq ?? 0);
    this.lastActive.set(session.session_id, Date.now());

    // 订阅输出 → 落盘 stdout/<seq>.output
    shell.onStdout((chunk) => {
      this.appendStdout(session, chunk);
    });
    shell.onStderr((chunk) => {
      this.appendStdout(session, chunk, /*stderr=*/true);
    });
    shell.onClose(() => {
      logger.info(`[session] ${session.session_id} closed by remote`);
      this.finalize(session, SessionStatus.Closed, 'remote_closed').catch((err) => {
        logger.error(`[session] ${session.session_id} finalize on remote close failed: ${(err as Error).message}`);
      });
    });


    // 注入初始命令（若存在）
    if (session.cmd && session.cmd.trim() !== '') {
      shell.write(session.cmd + '\n');
    }
    logger.info(`[session] ${session.session_id} ready`);
  }

  /**
   * 单轮 tick：扫描所有 open 会话，注入新 stdin、处理关闭与空闲超时
   * @param idleTimeoutMs - 空闲超时（从最后活跃起算，<=0 表示不启用）
   * @returns 关闭的会话数量
   */
  async tick(idleTimeoutMs: number): Promise<number> {
    let closed = 0;
    const ids = [...this.factories.keys()];
    for (const id of ids) {
      const session = await readSessionMeta(this.root, id);
      if (!session) {
        // 元信息缺失 → 直接关闭会话
        await this.closeShell(id);
        closed++;
        continue;
      }

      // 1. 注入新 stdin 输入
      try {
        const inputs = await listStdinInputs(this.root, id);
        const shell = this.factories.get(id)!;
        for (const seq of inputs) {
          const content = await readAndRemoveStdinInput(this.root, id, seq);
          shell.write(content);
          this.lastActive.set(id, Date.now());
        }
      } catch (err) {
        logger.error(`[session] ${id} inject stdin failed: ${(err as Error).message}`);
      }

      // 2. 关闭标记检查
      let closeRequested = false;
      try {
        closeRequested = await checkSessionCloseMarker(this.root, id);
      } catch {
        closeRequested = false;
      }
      if (closeRequested) {
        logger.info(`[session] ${id} close marker seen, closing`);
        // 先置终态再关 shell，避免 onClose 回调以 remote_closed 覆盖
        await this.finalize(session, SessionStatus.Closed, 'close_marker');
        await this.closeShell(id);
        closed++;
        continue;
      }

      // 3. 空闲超时检查
      if (idleTimeoutMs > 0) {
        const last = this.lastActive.get(id) ?? 0;
        if (Date.now() - last > idleTimeoutMs) {
          logger.info(`[session] ${id} idle timeout, closing`);
          // 先置终态再关 shell
          await this.finalize(session, SessionStatus.Aborted, 'idle_timeout');
          await this.closeShell(id);
          closed++;
          continue;
        }
      }
    }
    return closed;
  }

  /** 当前维护的会话数量 */
  get size(): number {
    return this.factories.size;
  }

  /**
   * 关闭所有会话并回收（Worker 优雅退出时调用）
   */
  async closeAll(): Promise<void> {
    const ids = [...this.factories.keys()];
    for (const id of ids) {
      const session = await readSessionMeta(this.root, id);
      if (session) {
        await this.finalize(session, SessionStatus.Aborted, 'worker_shutdown');
      }
      await this.closeShell(id);
    }
    await this.factory.closeAll();
  }

  // ── 内部 ──

  /**
   * 把一段 shell 输出落盘到 stdout/<seq>.output（stderr 合并进同一输出流）
   * 异步落盘后推进 seq，并更新最后活跃时间
   * @param session - 会话结构体
   * @param chunk - 输出文本块
   * @param stderr - 是否为 stderr 输出（用于打日志，落盘仍并入 stdout）
   */
  private appendStdout(session: SessionTask, chunk: string, stderr = false): void {
    const seq = this.stdoutSeq.get(session.session_id) ?? 0;
    // stderr 也并入 stdout 输出流（交互式 shell 场景 stderr 极少单独使用）
    void writeStdoutOutput(this.root, session.session_id, seq, chunk).then(() => {
      this.stdoutSeq.set(session.session_id, seq + 1);
    }).catch((err) => {
      logger.error(`[session] ${session.session_id} write stdout failed: ${(err as Error).message}`);
    });
    this.lastActive.set(session.session_id, Date.now());
    if (stderr) {
      logger.info(`[session] ${session.session_id} stderr chunk (${chunk.length} bytes)`);
    }
  }

  /**
   * 关闭并移除指定会话的底层 shell（不存在时静默跳过）
   * @param id - 会话 id
   */
  private async closeShell(id: string): Promise<void> {
    const shell = this.factories.get(id);
    if (shell) {
      await shell.close().catch(() => {});
      this.factories.delete(id);
    }
  }

  /**
   * 串行化某个会话的元信息写操作，避免并发 rename 竞态
   * @param id - 会话 id
   * @param task - 写操作
   */
  private enqueueWrite(id: string, task: () => Promise<void>): Promise<void> {
    const prev = this.writeChains.get(id) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.writeChains.set(
      id,
      next.catch(() => {}),
    );
    return next;
  }

  /**
   * 会话收尾：置终态并回写元信息。
   * 幂等：同一会话已进入关闭流程（closing 集合）时重复调用直接跳过，
   * 避免「close_marker / idle_timeout」与 shell onClose 的 remote_closed 并发覆盖。
   * @param session - 会话结构体
   * @param status - 终态（closed / aborted）
   * @param reason - 关闭原因
   */
  private finalize(
    session: SessionTask,
    status: SessionStatus,
    reason: string,
  ): Promise<void> {
    const id = session.session_id;
    if (this.closing.has(id)) {
      return Promise.resolve();
    }
    this.closing.add(id);
    return this.enqueueWrite(id, async () => {
      try {
        session.status = status;
        session.end_time = formatBeijingTimestamp(Date.now());
        session.error_msg = reason;
        await writeSessionMeta(this.root, session);
        logger.info(`[session] ${session.session_id} finalized status=${status} reason=${reason}`);
      } catch (err) {
        logger.error(`[session] ${session.session_id} finalize failed: ${(err as Error).message}`);
      }
    }).finally(() => {
      this.closing.delete(id);
    });
  }
}

