/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : config.ts
 * Author     : MsgFerry
 * Date       : 2026/08/07
 * Version    : 0.0.2
 * Description: Worker 启动配置解析与校验
 *   支持三种来源，优先级：命令行参数 > 环境变量 > 配置文件 > 内置默认值
 *   配置文件默认位于 <hgfs_root>/config/worker.json（相对路径由 shared 常量约定），
 *   也可用 --config-file / MSGFERRY_CONFIG_FILE 显式指定。
 * ======================================================
 */

import { existsSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';

import {
  POLLING,
  HEARTBEAT,
  RETENTION,
  OUTPUT,
  WORKER_CONFIG_FILE,
  resolveUnderRoot,
  readJsonConfigFile,
  pickConfigValue,
  pickConfigNumber,
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

/** Worker 配置文件（<hgfs_root>/config/worker.json）的扁平结构 */
export interface WorkerConfigFileShape {
  hgfs_root?: string;
  executor?: string;
  ssh?: {
    host?: string;
    port?: number | string;
    username?: string;
    private_key_path?: string | null;
    password?: string | null;
  };
  audit_log_dir?: string;
  policy_file?: string;
  polling?: {
    initial_interval_ms?: number | string;
    max_interval_ms?: number | string;
  };
  heartbeat_interval_sec?: number | string;
  result_ttl_sec?: number | string;
  max_inline_bytes?: number | string;
}

/** 默认审计日志目录名 */
const DEFAULT_AUDIT_DIR_NAME = 'logs';
/** 默认策略文件名 */
const DEFAULT_POLICY_FILE_NAME = 'policy.json';
/** 默认策略子目录名 */
const DEFAULT_POLICY_DIR_NAME = 'policy';

/**
 * 解析配置文件路径：--config-file / MSGFERRY_CONFIG_FILE > 共享根目录下的默认约定
 * @param argv - 进程参数数组
 * @param env - 环境变量
 * @param hgfsRoot - HGFS 共享根目录
 * @returns 配置文件绝对路径
 */
function resolveConfigFilePath(
  argv: string[],
  env: NodeJS.ProcessEnv,
  hgfsRoot: string,
): string {
  const explicit = pickConfigValue({
    argv,
    env,
    flag: '--config-file',
    envKey: 'MSGFERRY_CONFIG_FILE',
  });
  if (explicit) {
    return explicit;
  }
  return resolveUnderRoot(hgfsRoot, WORKER_CONFIG_FILE);
}

/**
 * 解析启动参数、环境变量与配置文件，产出 WorkerConfig
 * @param argv - process.argv
 * @param env - process.env
 * @returns WorkerConfig 配置对象
 */
export function parseConfig(argv: string[], env: NodeJS.ProcessEnv): WorkerConfig {
  // hgfs_root 仅来自命令行 / 环境变量（配置文件路径依赖它，存在循环依赖）
  const hgfsRoot = pickConfigValue({
    argv,
    env,
    flag: '--hgfs-root',
    envKey: 'MSGFERRY_HGFS_ROOT',
  }) ?? '';

  // 读取配置文件（存在才生效，否则全部走 CLI/env/默认值）
  const configFilePath = resolveConfigFilePath(argv, env, hgfsRoot);
  const file = readJsonConfigFile<WorkerConfigFileShape>(configFilePath);

  const executorType = (
    pickConfigValue({
      argv,
      env,
      flag: '--executor',
      envKey: 'MSGFERRY_EXECUTOR',
      fileValue: file.executor,
      defaultValue: 'mock',
    }) ?? 'mock'
  ) as 'mock' | 'ssh2';

  const sshHost = pickConfigValue({
    argv,
    env,
    flag: '--ssh-host',
    envKey: 'MSGFERRY_SSH_HOST',
    fileValue: file.ssh?.host,
  });
  const sshPort = pickConfigNumber({
    argv,
    env,
    flag: '--ssh-port',
    envKey: 'MSGFERRY_SSH_PORT',
    fileValue: file.ssh?.port,
    defaultValue: 22,
  });
  const sshUser = pickConfigValue({
    argv,
    env,
    flag: '--ssh-user',
    envKey: 'MSGFERRY_SSH_USER',
    fileValue: file.ssh?.username,
  });
  const sshKey = pickConfigValue({
    argv,
    env,
    flag: '--ssh-key',
    envKey: 'MSGFERRY_SSH_KEY',
    fileValue: file.ssh?.private_key_path,
  });
  const sshPassword = pickConfigValue({
    argv,
    env,
    flag: '--ssh-password',
    envKey: 'MSGFERRY_SSH_PASSWORD',
    fileValue: file.ssh?.password,
  });

  const auditDir = pickConfigValue({
    argv,
    env,
    flag: '--audit-dir',
    envKey: 'MSGFERRY_AUDIT_DIR',
    fileValue: file.audit_log_dir,
  });
  const policyFile = pickConfigValue({
    argv,
    env,
    flag: '--policy-file',
    envKey: 'MSGFERRY_POLICY_FILE',
    fileValue: file.policy_file,
  });
  const pollingInitial = pickConfigNumber({
    argv,
    env,
    flag: '--polling-initial',
    envKey: 'MSGFERRY_POLLING_INITIAL',
    fileValue: file.polling?.initial_interval_ms,
    defaultValue: POLLING.initial_interval_ms,
  });
  const pollingMax = pickConfigNumber({
    argv,
    env,
    flag: '--polling-max',
    envKey: 'MSGFERRY_POLLING_MAX',
    fileValue: file.polling?.max_interval_ms,
    defaultValue: POLLING.max_interval_ms,
  });
  const heartbeatInterval = pickConfigNumber({
    argv,
    env,
    flag: '--heartbeat-interval',
    envKey: 'MSGFERRY_HEARTBEAT_INTERVAL',
    fileValue: file.heartbeat_interval_sec,
    defaultValue: HEARTBEAT.write_interval_sec,
  });
  const resultTtl = pickConfigNumber({
    argv,
    env,
    flag: '--result-ttl',
    envKey: 'MSGFERRY_RESULT_TTL',
    fileValue: file.result_ttl_sec,
    defaultValue: RETENTION.result_ttl_sec,
  });
  const maxInline = pickConfigNumber({
    argv,
    env,
    flag: '--max-inline',
    envKey: 'MSGFERRY_MAX_INLINE',
    fileValue: file.max_inline_bytes,
    defaultValue: OUTPUT.max_inline_bytes,
  });

  // SSH 配置仅在真实模式才有意义：executor 为 mock 时即便配置文件有 ssh 字段也忽略
  const sshConfig: SshConfig | null = executorType === 'ssh2' && sshHost
    ? {
        host: sshHost,
        port: sshPort,
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
      initial_interval_ms: pollingInitial,
      max_interval_ms: pollingMax,
    },
    heartbeat_interval_sec: heartbeatInterval,
    result_ttl_sec: resultTtl,
    max_inline_bytes: maxInline,
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
