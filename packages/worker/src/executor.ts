/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : executor.ts
 * Author     : MsgFerry
 * Date       : 2026/08/07
 * Version    : 0.0.2
 * Description: SSH 执行器接口、Mock 实现与 ssh2 真实实现
 *   - Ssh2Executor：按设备名查 SSH 配置 → 建连接 → 生成 ssh_N 会话 id →
 *     后续同一设备复用该连接发命令；连接失败抛 SshConnectionFailed。
 * ======================================================
 */

import { readFile } from 'node:fs/promises';

import { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';

import type { WorkerConfig } from './config.js';
import { findSshConfig } from './config.js';
import type { SshConfig } from './config.js';
import { logger } from './log.js';

/** 命令执行结果（协议无关） */
export interface CmdResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
}

/** 已建立的 SSH 会话条目（按设备名复用） */
interface SshSession {
  /** 会话 id，形如 ssh_1、ssh_2，全局自增 */
  sessionId: string;
  /** 设备名（normalize 后：显式设备名或 'default'） */
  device: string;
  /** ssh2 Client 实例 */
  client: Client;
}

/** 命令执行器接口（协议无关） */
export interface CmdExecutor {
  /**
   * 执行命令并返回结果
   * @param cmd - 待执行命令
   * @param timeout_sec - 超时秒数
   * @param device - 目标设备名（可选，未指定走默认设备）
   * @returns 执行结果
   */
  execute(cmd: string, timeout_sec: number, device?: string): Promise<CmdResult>;
}

/**
 * 交互式 shell 会话接口（协议无关）
 * 基于 ssh2 shell channel + pty 建立，支持 stdin 注入与 stdout/stderr 订阅，
 * 供交互式 shell 任务做低频 stdin/stdout 文件摆渡。
 */
export interface ShellSession {
  /** 会话 id，形如 ssh_N */
  readonly sessionId: string;
  /** 目标设备名（normalize 后） */
  readonly device: string;
  /** 写入 stdin（交互式 shell 输入） */
  write(data: string): void;
  /** 订阅 stdout 输出（UTF-8 文本，每次回调一个数据块） */
  onStdout(cb: (chunk: string) => void): void;
  /** 订阅 stderr 输出（UTF-8 文本） */
  onStderr(cb: (chunk: string) => void): void;
  /** 订阅会话关闭（远端关闭或本地主动关闭触发） */
  onClose(cb: () => void): void;
  /** 主动关闭会话并回收通道 */
  close(): Promise<void>;
}

/** 会话工厂：按设备打开交互式 shell 会话 */
export interface ShellSessionFactory {
  /**
   * 打开一个交互式 shell 会话
   * @param device - 目标设备名（可选，未指定走默认设备）
   * @returns 已就绪的会话
   */
  open(device?: string): Promise<ShellSession>;
  /** 关闭所有已建立的会话（Worker 优雅退出时调用） */
  closeAll(): Promise<void>;
}

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

// ────────────────────────────────────────────────────────────────
// Mock 交互式 shell 会话（测试用，不真实连网）
// ────────────────────────────────────────────────────────────────

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
  onStderr(cb: (chunk: string) => void): void { this.stderrCbs.push(cb); }
  onClose(cb: () => void): void { this.closeCbs.push(cb); }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.emitStdout('[mock-shell] session closed\n');
    for (const cb of this.closeCbs) cb();
    this.closeCbs.length = 0;
    return Promise.resolve();
  }

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

/**
 * ssh2 真实执行器
 *
 * 按 device 查 SSH 配置；首次命中某设备时建连接并生成 ssh_N 形式的会话 id，
 * 后续同一设备复用已建连接发命令，避免每条命令重新握手。
 * 连接失败抛 Error（调用方据此回写 failed 结果）。
 */
export class Ssh2Executor implements CmdExecutor {
  /** 设备名 → 会话条目（含已建立的 ssh2 Client） */
  private readonly sessions = new Map<string, SshSession>();
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
    logger.info(`[executor] execute on ${session.sessionId} (device=${session.device}): ${cmd}`);

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
  private async getOrCreateSession(device?: string): Promise<SshSession> {
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
    logger.info(`[executor] connecting ${sessionId}: device=${normalized} host=${sshConfig.host}:${sshConfig.port} user=${sshConfig.username}`);

    const client = await this.connect(sshConfig, sessionId);
    const session: SshSession = { sessionId, device: normalized, client };
    this.sessions.set(normalized, session);
    logger.info(`[executor] ${sessionId} connected`);
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

      // 认证：优先私钥，其次密码
      if (sshConfig.private_key_path) {
        readFile(sshConfig.private_key_path, 'utf-8')
          .then((keyContent) => {
            connectCfg.privateKey = keyContent;
            if (sshConfig.password) {
              connectCfg.passphrase = sshConfig.password;
            }
            client.connect(connectCfg);
          })
          .catch((err) => {
            reject(new Error(`[executor] ${sessionId} read private key failed: ${err.message}`));
          });
      } else if (sshConfig.password) {
        connectCfg.password = sshConfig.password;
        client.connect(connectCfg);
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

  /**
   * 在已建立的会话上执行一条命令，超时或异常时回收通道
   */
  private runCommand(session: SshSession, cmd: string, timeout_sec: number): Promise<CmdResult> {
    return new Promise<CmdResult>((resolve) => {
      const timeoutMs = timeout_sec * 1000;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        logger.warn(`[executor] ${session.sessionId} command timed out after ${timeout_sec}s: ${cmd}`);
        // 超时直接回退结果，通道由 ssh2 内部在 close 事件后回收
        resolve({
          stdout: '',
          stderr: '',
          exit_code: null,
          timed_out: true,
        });
      }, timeoutMs);

      session.client.exec(cmd, (err, s) => {
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

        s.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
        s.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
        s.on('exit', (code: number | null) => {
          exitCode = code;
        });
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
  private closeSession(session: SshSession): Promise<void> {
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

// ────────────────────────────────────────────────────────────────
// ssh2 真实交互式 shell 会话与工厂
// ────────────────────────────────────────────────────────────────

/** ssh2 shell channel + pty 的交互式会话封装 */
class Ssh2ShellSession implements ShellSession {
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

  write(data: string): void {
    this.stream.write(data, 'utf-8');
  }

  onStdout(cb: (chunk: string) => void): void { this.stdoutCbs.push(cb); }
  onStderr(cb: (chunk: string) => void): void { this.stderrCbs.push(cb); }
  onClose(cb: () => void): void { this.closeCbs.push(cb); }

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
 * 与一次性命令执行器（Ssh2Executor）解耦，会话生命周期由调用方（session.ts）管理。
 */
export class Ssh2ShellSessionFactory implements ShellSessionFactory {
  private readonly sessions = new Set<Ssh2ShellSession>();
  private readonly clients = new Set<import('ssh2').Client>();
  private counter = 0;
  private readonly connectTimeoutMs = 10000;

  constructor(private readonly config: WorkerConfig) {}

  async open(device?: string): Promise<ShellSession> {
    const normalized = device && device.trim() !== '' ? device : 'default';
    const sshConfig = findSshConfig(this.config, normalized === 'default' ? undefined : normalized);
    if (!sshConfig) {
      throw new Error(`no ssh config for device "${normalized}"`);
    }

    const sessionId = `ssh_${++this.counter}`;
    logger.info(`[executor] opening shell ${sessionId}: device=${normalized} host=${sshConfig.host}:${sshConfig.port} user=${sshConfig.username}`);

    const client = await this.connect(sshConfig, sessionId);
    this.clients.add(client);

    const stream = await this.openShellChannel(client, sessionId);
    const session = new Ssh2ShellSession(sessionId, normalized, stream);
    this.sessions.add(session);
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

// ────────────────────────────────────────────────────────────────
// 交互式 shell 通道命令执行器（exec_mode: shell）
// ────────────────────────────────────────────────────────────────

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
 * 适用于目标设备不支持 exec 通道、仅支持交互式 shell（如部分 Dropbear/受限登录 shell）
 * 的场景：打开 shell channel + pty，把 cmd 作为输入注入，收集 stdout 到超时或会话关闭。
 * 复用 ShellSessionFactory 建立连接，执行完后关闭会话回收通道。
 *
 * 结束标记检测：交互式 shell 执行完命令不会关闭通道，仅靠超时兜底会白白等待。
 * 因此在命令后注入唯一 marker（echo <marker>:$?），在 stdout 中匹配到 marker 即判定命令
 * 已结束并解析退出码，无需等到超时。
 */
export class ShellCmdExecutor implements CmdExecutor {
  private readonly factory: ShellSessionFactory;

  constructor(config: WorkerConfig) {
    this.factory = createShellSessionFactory(config);
  }

  async execute(cmd: string, timeout_sec: number, device?: string): Promise<CmdResult> {
    const session = await this.factory.open(device);
    logger.info(`[executor] shell-exec on ${session.sessionId} (device=${session.device}): ${cmd}`);

    return new Promise<CmdResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (result: CmdResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void session.close().finally(() => resolve(result));
      };

      const timer = setTimeout(() => {
        logger.warn(`[executor] ${session.sessionId} shell-exec timed out after ${timeout_sec}s: ${cmd}`);
        finish({ stdout, stderr, exit_code: null, timed_out: true });
      }, timeout_sec * 1000);

      // 唯一结束标记：随机后缀避免与命令输出中的文本冲突
      const marker = `__MSG_DONE_${Math.random().toString(36).slice(2, 10)}`;
      const markerRe = new RegExp(`${marker}:(\\d+)`);

      session.onStdout((chunk) => {
        stdout += chunk;
        const m = stdout.match(markerRe);
        if (!m) return;
        // 匹配到结束标记：从 stdout 中剥离 marker 相关行，解析退出码并立即结束
        stdout = stripMarkerLines(stdout, marker);
        finish({ stdout, stderr, exit_code: Number(m[1]), timed_out: false });
      });
      session.onStderr((chunk) => { stderr += chunk; });
      session.onClose(() => {
        // 会话提前关闭（远端退出），收集到的输出作为结果返回
        finish({ stdout, stderr, exit_code: null, timed_out: false });
      });

      // 注入命令并回车执行，随后注入唯一结束标记回显退出码
      session.write(`${cmd}\n`);
      session.write(`echo ${marker}:$?\n`);
    });
  }

  /** 关闭所有底层会话（Worker 优雅退出时调用） */
  async close(): Promise<void> {
    await this.factory.closeAll();
  }
}

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
