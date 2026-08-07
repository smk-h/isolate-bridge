/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : config.ts
 * Author     : MsgFerry
 * Date       : 2026/08/07
 * Version    : 0.0.1
 * Description: Worker 启动配置解析与校验
 * ======================================================
 */

import { existsSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';

import {
  POLLING,
  HEARTBEAT,
  RETENTION,
  OUTPUT,
} from '@smai-kit/msgferry-shared';

/** SSH 连接配置（真实模式必填） */
export interface SshConfig {
  host: string;
  port: number;
  username: string;
  private_key_path: string | null;
  password: string | null;
}

/** Worker 启动配置 */
export interface WorkerConfig {
  hgfs_root: string;                    // HGFS 共享根目录绝对路径
  executor_type: 'mock' | 'ssh2';       // SSH 执行器选择
  ssh_config: SshConfig | null;          // 真实模式必填，mock 模式 null
  audit_log_dir: string;                // 审计日志目录
  policy_file: string;                  // 策略文件路径
  polling: {
    initial_interval_ms: number;
    max_interval_ms: number;
  };
  heartbeat_interval_sec: number;
  result_ttl_sec: number;
  max_inline_bytes: number;
}

/** 默认审计日志目录名 */
const DEFAULT_AUDIT_DIR_NAME = 'logs';
/** 默认策略文件名 */
const DEFAULT_POLICY_FILE_NAME = 'policy.json';
/** 默认策略子目录名 */
const DEFAULT_POLICY_DIR_NAME = 'policy';

/**
 * 从 argv 解析单个参数值
 * @param argv - 进程参数数组
 * @param flag - 参数标志（如 '--hgfs-root'）
 * @param envKey - 环境变量名（备选）
 * @returns 参数值，未提供返回 undefined
 */
function getArg(argv: string[], flag: string, envKey?: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < argv.length) {
    return argv[idx + 1];
  }
  if (envKey && process.env[envKey]) {
    return process.env[envKey];
  }
  return undefined;
}

/**
 * 解析启动参数与环境变量，产出 WorkerConfig
 * @param argv - process.argv
 * @param env - process.env（当前实现直接读 process.env）
 * @returns WorkerConfig 配置对象
 */
export function parseConfig(argv: string[], _env: NodeJS.ProcessEnv): WorkerConfig {
  const hgfsRoot = getArg(argv, '--hgfs-root', 'MSGFERRY_HGFS_ROOT') ?? '';
  const executorType = (getArg(argv, '--executor', 'MSGFERRY_EXECUTOR') ?? 'mock') as 'mock' | 'ssh2';
  const sshHost = getArg(argv, '--ssh-host', 'MSGFERRY_SSH_HOST');
  const sshPort = getArg(argv, '--ssh-port', 'MSGFERRY_SSH_PORT');
  const sshUser = getArg(argv, '--ssh-user', 'MSGFERRY_SSH_USER');
  const sshKey = getArg(argv, '--ssh-key', 'MSGFERRY_SSH_KEY');
  const sshPassword = getArg(argv, '--ssh-password', 'MSGFERRY_SSH_PASSWORD');
  const auditDir = getArg(argv, '--audit-dir', 'MSGFERRY_AUDIT_DIR');
  const policyFile = getArg(argv, '--policy-file', 'MSGFERRY_POLICY_FILE');
  const pollingInitial = getArg(argv, '--polling-initial', 'MSGFERRY_POLLING_INITIAL');
  const pollingMax = getArg(argv, '--polling-max', 'MSGFERRY_POLLING_MAX');
  const heartbeatInterval = getArg(argv, '--heartbeat-interval', 'MSGFERRY_HEARTBEAT_INTERVAL');
  const resultTtl = getArg(argv, '--result-ttl', 'MSGFERRY_RESULT_TTL');
  const maxInline = getArg(argv, '--max-inline', 'MSGFERRY_MAX_INLINE');

  // SSH 配置仅在真实模式才有意义
  const sshConfig: SshConfig | null = sshHost
    ? {
        host: sshHost,
        port: sshPort ? parseInt(sshPort, 10) : 22,
        username: sshUser ?? '',
        private_key_path: sshKey ?? null,
        password: sshPassword ?? null,
      }
    : null;

  return {
    hgfs_root: hgfsRoot,
    executor_type: executorType,
    ssh_config: sshConfig,
    audit_log_dir: auditDir ?? join(hgfsRoot, DEFAULT_AUDIT_DIR_NAME),
    policy_file: policyFile ?? join(hgfsRoot, DEFAULT_POLICY_DIR_NAME, DEFAULT_POLICY_FILE_NAME),
    polling: {
      initial_interval_ms: pollingInitial ? parseInt(pollingInitial, 10) : POLLING.initial_interval_ms,
      max_interval_ms: pollingMax ? parseInt(pollingMax, 10) : POLLING.max_interval_ms,
    },
    heartbeat_interval_sec: heartbeatInterval ? parseInt(heartbeatInterval, 10) : HEARTBEAT.write_interval_sec,
    result_ttl_sec: resultTtl ? parseInt(resultTtl, 10) : RETENTION.result_ttl_sec,
    max_inline_bytes: maxInline ? parseInt(maxInline, 10) : OUTPUT.max_inline_bytes,
  };
}

/**
 * 校验配置完整性，校验失败抛错
 * @param config - WorkerConfig 配置对象
 * @throws {Error} hgfs_root 不存在或不可读写时抛错；ssh2 模式缺配置时抛错
 */
export function validateConfig(config: WorkerConfig): void {
  if (!config.hgfs_root) {
    throw new Error('hgfs_root is required');
  }
  if (!existsSync(config.hgfs_root)) {
    throw new Error(`hgfs_root does not exist: ${config.hgfs_root}`);
  }
  try {
    accessSync(config.hgfs_root, constants.R_OK | constants.W_OK);
  } catch {
    throw new Error(`hgfs_root is not readable/writable: ${config.hgfs_root}`);
  }
  if (config.executor_type === 'ssh2') {
    if (!config.ssh_config) {
      throw new Error('ssh_config is required when executor_type is ssh2');
    }
    if (!config.ssh_config.host || !config.ssh_config.username) {
      throw new Error('ssh_config.host and ssh_config.username are required for ssh2 mode');
    }
  }
}
