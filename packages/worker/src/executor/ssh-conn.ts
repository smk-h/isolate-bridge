/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : ssh-conn.ts
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: ssh2 公共连接层
 *   - connectClient：统一建连（认证 / 超时 / keepalive），收敛 command 与 shell 两份重复逻辑
 *   - closeClient：统一优雅断连（含兜底）
 *   - SshClientCache：按设备缓存 client 的连接级失效检测 + 惰性重连 + 建连去重
 *     —— 监听 client 的 close/error，失效即从缓存驱逐，下次任务自动重建连接。
 * ======================================================
 */

import { readFile } from 'node:fs/promises';

import { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';

import type { SshConfig } from '../config/index.js';
import { logger } from '../log/index.js';

/** 默认连接超时（毫秒） */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
/** keepalive 间隔（毫秒）：仅维持连接，不用于发现设备离线 */
const KEEPALIVE_INTERVAL_MS = 15000;
/** 超时兜底额外余量（毫秒），在 connectTimeoutMs 基础上再放宽一点等待握手 */
const TIMEOUT_GRACE_MS = 5000;

/**
 * 建立 ssh2 连接，握手成功返回 Client，失败抛错
 * 收敛 command / shell 两份几乎逐行重复的建连逻辑：认证（私钥优先 + password 作 passphrase，
 * 其次纯密码，两者皆无报错）、超时兜底、keepalive。
 * @param sshConfig - SSH 连接配置
 * @param sessionId - 会话 id，用于日志与错误信息定位
 * @param connectTimeoutMs - 连接超时（毫秒）
 * @returns 已就绪的 ssh2 Client
 */
export function connectClient(sshConfig: SshConfig, sessionId: string, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<Client> {
  return new Promise<Client>((resolve, reject) => {
    const client = new Client();
    const connectCfg: ConnectConfig = {
      host: sshConfig.host,
      port: sshConfig.port,
      username: sshConfig.username,
      readyTimeout: connectTimeoutMs,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
    };

    const doConnect = () => client.connect(connectCfg);
    if (sshConfig.private_key_path) {
      readFile(sshConfig.private_key_path, 'utf-8')
        .then((keyContent) => {
          connectCfg.privateKey = keyContent;
          // 私钥场景下 password 作为私钥 passphrase（若配置了）
          if (sshConfig.password) {
            connectCfg.passphrase = sshConfig.password;
          }
          doConnect();
        })
        .catch((err) => {
          reject(new Error(`[executor:ssh-conn] ${sessionId} read private key failed: ${err.message}`));
        });
    } else if (sshConfig.password) {
      connectCfg.password = sshConfig.password;
      doConnect();
    } else {
      reject(new Error(`[executor:ssh-conn] ${sessionId} no auth: neither private_key_path nor password`));
      return;
    }

    // 连接超时兜底：超时强制断连并拒绝
    const timer = setTimeout(() => {
      client.end();
      reject(new Error(`[executor:ssh-conn] ${sessionId} connect timeout after ${connectTimeoutMs}ms`));
    }, connectTimeoutMs + TIMEOUT_GRACE_MS);

    client.once('ready', () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`[executor:ssh-conn] ${sessionId} connect error: ${err.message}`));
    });
  });
}

/**
 * 关闭 ssh2 Client：end() 触发优雅断连，收到 close/end 或 1s 兜底后视为完成
 * @param client - ssh2 Client
 * @returns Promise，断连完成时 resolve
 */
export function closeClient(client: Client): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    client.once('close', finish);
    client.once('end', finish);
    try {
      client.end();
    } catch {
      finish();
    }
    // 兜底：1s 内未收到 close/end 事件也强行结束
    setTimeout(finish, 1000);
  });
}

/** 已缓存的 client 会话条目（command 侧按设备名复用） */
export interface CachedClientSession {
  /** 会话 id，形如 ssh_1、ssh_2，全局自增 */
  sessionId: string;
  /** 设备名（normalize 后：显式设备名或 'default'） */
  device: string;
  /** ssh2 Client 实例 */
  client: Client;
}

/**
 * command 侧 client 连接缓存
 *
 * 连接级失效检测 + 惰性重连 + 建连去重：
 * - 按设备缓存 Client，命中直接复用，避免每条命令重新握手；
 * - 给缓存里的 Client 挂 close/error 监听，连接一旦失效立即从缓存驱逐，
 *   下一次 getOrCreate 未命中缓存 → 自动走新建连接路径（即惰性重连）；
 * - 同一设备并发建连时复用 in-flight Promise，避免重复握手。
 */
export class SshClientCache {
  /** 设备名 → 会话条目（含已建立的 ssh2 Client） */
  private readonly sessions = new Map<string, CachedClientSession>();
  /** 设备名 → 建连中的 Promise（并发去重） */
  private readonly opening = new Map<string, Promise<CachedClientSession>>();
  /** 全局会话自增计数器，生成 ssh_1、ssh_2… */
  private sessionCounter = 0;

  /**
   * 取已缓存的会话条目（未连接或已失效返回 undefined）
   * @param device - 归一化后的设备名
   */
  get(device: string): CachedClientSession | undefined {
    return this.sessions.get(device);
  }

  /**
   * 取某设备已建立的会话 id（未连接返回 undefined）
   * 供审计等外部模块读取 ssh_target 用。
   * @param device - 归一化后的设备名
   */
  getSessionId(device: string): string | undefined {
    return this.sessions.get(device)?.sessionId;
  }

  /**
   * 取或建某设备的 client 会话
   * - 已缓存且未失效则直接复用
   * - 未命中或已失效则用 connectFn 新建连接，成功后入缓存并挂失效检测监听
   * - 并发建连去重：同一设备同时请求时复用同一个 in-flight Promise
   * @param device - 归一化后的设备名
   * @param sshConfig - 该设备的 SSH 配置
   * @param connectFn - 建连函数（由调用方注入，通常为 connectClient）
   * @returns 会话条目
   */
  async getOrCreate(device: string, sshConfig: SshConfig, connectFn: (cfg: SshConfig, sessionId: string) => Promise<Client>): Promise<CachedClientSession> {
    // 命中已缓存连接直接复用
    const existing = this.sessions.get(device);
    if (existing) {
      return existing;
    }
    // 已有正在建立中的连接则复用该 Promise，避免同一设备并发重复握手
    const inFlight = this.opening.get(device);
    if (inFlight) {
      return inFlight;
    }

    const p = this.open(device, sshConfig, connectFn).finally(() => {
      // 建连流程结束（成功或失败）即清除 in-flight 记录，允许下次重试
      this.opening.delete(device);
    });
    this.opening.set(device, p);
    return p;
  }

  /**
   * 关闭所有已建立的连接（Worker 优雅退出时调用）
   */
  async closeAll(): Promise<void> {
    const closes: Promise<void>[] = [];
    for (const [, session] of this.sessions) {
      closes.push(closeClient(session.client));
    }
    this.sessions.clear();
    await Promise.all(closes);
  }

  // ── 内部实现 ──

  /**
   * 建连并入缓存，挂载连接级失效检测监听
   * @param device - 归一化后的设备名
   * @param sshConfig - SSH 配置
   * @param connectFn - 建连函数
   * @returns 会话条目
   */
  private async open(device: string, sshConfig: SshConfig, connectFn: (cfg: SshConfig, sessionId: string) => Promise<Client>): Promise<CachedClientSession> {
    const sessionId = `ssh_${++this.sessionCounter}`;
    logger.info(`[executor:ssh-conn] connecting ${sessionId}: device=${device} host=${sshConfig.host}:${sshConfig.port} user=${sshConfig.username}`);

    const client = await connectFn(sshConfig, sessionId);
    const session: CachedClientSession = { sessionId, device, client };
    this.sessions.set(device, session);
    logger.info(`[executor:ssh-conn] ${sessionId} connected`);

    // 连接级失效检测：client 关闭或出错即从缓存驱逐，下次任务惰性重连
    const evict = () => {
      if (this.sessions.get(device) === session) {
        this.sessions.delete(device);
        logger.info(`[executor:ssh-conn] ${sessionId} client evicted: device=${device}`);
      }
    };
    client.once('close', evict);
    client.once('error', evict);
    return session;
  }
}
