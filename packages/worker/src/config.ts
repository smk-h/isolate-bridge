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
import { isAbsolute, join } from 'node:path';

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

/** 设备名 → SSH 连接配置 的字典（多设备） */
export type DeviceSshMap = Record<string, SshConfig>;

/** Worker 启动配置 */
export interface WorkerConfig {
  hgfs_root: string;                    // HGFS 共享根目录绝对路径
  executor_type: 'mock' | 'ssh2';       // SSH 执行器选择
  devices: DeviceSshMap;                // 多设备：设备名 → SSH 连接信息（设备名仅字母/数字/下划线/连字符）
  ssh_config: SshConfig | null;          // 默认/兼容设备（旧 ssh 字段或 CLI/env 指定），真实模式必填，mock 模式 null
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

/** 设备级 SSH 连接配置的原始（文件）结构 */
export interface DeviceSshFileShape {
  host?: string;
  port?: number | string;
  username?: string;
  private_key_path?: string | null;
  password?: string | null;
}

/** Worker 配置文件（<hgfs_root>/config/worker.json）的扁平结构 */
export interface WorkerConfigFileShape {
  hgfs_root?: string;
  executor?: string;
  devices?: Record<string, DeviceSshFileShape>;  // 多设备（推荐）：设备名 → SSH 连接信息
  ssh?: DeviceSshFileShape;                      // 兼容旧字段：单默认设备
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

/** 设备名合法性正则：仅允许字母、数字、下划线、连字符，不允许特殊符号 */
const DEVICE_NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * 校验设备名是否合法
 * 约定推荐使用 board-xxx，但不强制校验前缀；仅约束字符集：
 * 字母、数字、下划线、连字符，不允许空格与任何特殊符号。
 * @param name - 设备名
 * @returns 是否合法
 */
export function isValidDeviceName(name: string): boolean {
  return DEVICE_NAME_RE.test(name);
}

/** 默认审计日志目录名（相对共享根目录） */
const DEFAULT_AUDIT_DIR_NAME = 'logs';
/** 默认策略文件名 */
const DEFAULT_POLICY_FILE_NAME = 'policy.json';
/** 默认策略子目录名（相对共享根目录） */
const DEFAULT_POLICY_DIR_NAME = 'policy';

/**
 * 将配置来源的路径值解析为最终绝对路径
 * - 来源值缺省时：相对共享根目录的内置默认值（<root>/logs、<root>/policy/policy.json）
 * - 来源值为相对路径时：基于共享根目录解析为绝对路径
 * - 来源值为绝对路径时：原样使用（保留 CLI/环境变量/配置文件的显式指定能力）
 * @param value - 配置来源值（CLI/env/配置文件，可能为 undefined）
 * @param hgfsRoot - HGFS 共享根目录绝对路径
 * @param defaultRel - 内置默认相对路径（如 logs、policy/policy.json）
 * @returns 解析后的绝对路径
 */
function resolvePathUnderRoot(
  value: string | undefined,
  hgfsRoot: string,
  defaultRel: string,
): string {
  if (value !== undefined && value !== '') {
    return isAbsolute(value) ? value : join(hgfsRoot, value);
  }
  return join(hgfsRoot, defaultRel);
}

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

  // 多设备解析：设备名 → SSH 连接信息
  // 1. 默认设备（兼容旧用法）：CLI/env > 配置文件旧 ssh 字段 > 配置文件 devices.default > 无
  const devices: DeviceSshMap = {};
  const rawDevices = file.devices ?? {};
  for (const [name, dev] of Object.entries(rawDevices)) {
    if (name === 'default' || !isValidDeviceName(name)) {
      continue;
    }
    if (!dev || typeof dev !== 'object') {
      continue;
    }
    const host = pickConfigValue({ argv, env, fileValue: dev.host });
    const port = pickConfigNumber({
      argv,
      env,
      fileValue: dev.port,
      defaultValue: 22,
    });
    const username = pickConfigValue({ argv, env, fileValue: dev.username });
    const key = pickConfigValue({ argv, env, fileValue: dev.private_key_path });
    const password = pickConfigValue({ argv, env, fileValue: dev.password });
    if (!host || !username) {
      continue;
    }
    devices[name] = {
      host,
      port,
      username,
      private_key_path: key ?? null,
      password: password ?? null,
    };
  }

  // 2. 默认设备（default 键或旧 ssh 字段 / CLI / env）：host 存在才构建
  const defaultHost =
    pickConfigValue({
      argv,
      env,
      flag: '--ssh-host',
      envKey: 'MSGFERRY_SSH_HOST',
      fileValue: rawDevices.default?.host ?? file.ssh?.host,
    }) ??
    (rawDevices.default?.host !== undefined
      ? String(rawDevices.default.host)
      : file.ssh?.host !== undefined
        ? String(file.ssh.host)
        : undefined);
  const defaultPort = pickConfigNumber({
    argv,
    env,
    flag: '--ssh-port',
    envKey: 'MSGFERRY_SSH_PORT',
    fileValue: rawDevices.default?.port ?? file.ssh?.port,
    defaultValue: 22,
  });
  const defaultUser =
    pickConfigValue({
      argv,
      env,
      flag: '--ssh-user',
      envKey: 'MSGFERRY_SSH_USER',
      fileValue: rawDevices.default?.username ?? file.ssh?.username,
    }) ??
    (rawDevices.default?.username !== undefined
      ? String(rawDevices.default.username)
      : file.ssh?.username !== undefined
        ? String(file.ssh.username)
        : undefined);
  const defaultKey = pickConfigValue({
    argv,
    env,
    flag: '--ssh-key',
    envKey: 'MSGFERRY_SSH_KEY',
    fileValue: rawDevices.default?.private_key_path ?? file.ssh?.private_key_path,
  });
  const defaultPassword = pickConfigValue({
    argv,
    env,
    flag: '--ssh-password',
    envKey: 'MSGFERRY_SSH_PASSWORD',
    fileValue: rawDevices.default?.password ?? file.ssh?.password,
  });

  // 多设备场景下也允许同时提供“默认设备”，与旧 ssh 字段/CLI/env 一致
  if (defaultHost && defaultUser) {
    devices.default = {
      host: defaultHost,
      port: defaultPort,
      username: defaultUser,
      private_key_path: defaultKey ?? null,
      password: defaultPassword ?? null,
    };
  }

  // 兼容旧用法：executor 为 ssh2 时，若配置了旧 ssh 字段（无 devices），把它作为默认设备
  if (executorType === 'ssh2' && !devices.default && file.ssh?.host) {
    devices.default = {
      host: String(file.ssh.host),
      port: defaultPort,
      username: String(file.ssh.username ?? ''),
      private_key_path: defaultKey ?? null,
      password: defaultPassword ?? null,
    };
  }

  // SSH 配置仅在真实模式才有意义：executor 为 mock 时即便配置文件有 ssh 字段也忽略
  const sshConfig: SshConfig | null = executorType === 'ssh2' && devices.default
    ? devices.default
    : null;

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

  return {
    hgfs_root: hgfsRoot,
    executor_type: executorType,
    devices,
    ssh_config: sshConfig,
    // audit_log_dir / policy_file 默认依据共享根目录相对定位：
    // 显式传入绝对路径则原样使用；相对路径或未传则解析为 <hgfs_root>/logs、<hgfs_root>/policy/policy.json
    audit_log_dir: resolvePathUnderRoot(auditDir, hgfsRoot, DEFAULT_AUDIT_DIR_NAME),
    policy_file: resolvePathUnderRoot(policyFile, hgfsRoot, join(DEFAULT_POLICY_DIR_NAME, DEFAULT_POLICY_FILE_NAME)),
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
 * 按设备名查找 SSH 连接配置
 * 后续连接 SSH 时可通过设备名查询对应的 ip/host 及账号信息。
 * 查找顺序：devices[设备名] > devices.default（若传入 default 或未命中时回退）> ssh_config（旧兼容）
 * @param config - Worker 配置
 * @param deviceName - 设备名（不传或为空时返回默认设备）
 * @returns SSH 连接配置，未找到返回 undefined
 */
export function findSshConfig(config: WorkerConfig, deviceName?: string): SshConfig | undefined {
  if (deviceName && isValidDeviceName(deviceName) && config.devices[deviceName]) {
    return config.devices[deviceName];
  }
  return config.devices.default ?? config.ssh_config ?? undefined;
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
    if (Object.keys(config.devices).length === 0 && !config.ssh_config) {
      throw new Error('ssh_config is required when executor_type is ssh2');
    }
    // 多设备：校验设备名合法性与每个设备的 host/username 完整性
    for (const [name, dev] of Object.entries(config.devices)) {
      if (!isValidDeviceName(name)) {
        throw new Error(`invalid device name "${name}": only letters, digits, underscore and hyphen are allowed`);
      }
      if (!dev.host || !dev.username) {
        throw new Error(`device "${name}" requires host and username`);
      }
    }
    // 兼容旧用法：仅提供 ssh_config（无 devices）时校验默认设备完整性
    if (config.ssh_config && Object.keys(config.devices).length === 0) {
      if (!config.ssh_config.host || !config.ssh_config.username) {
        throw new Error('ssh_config.host and ssh_config.username are required for ssh2 mode');
      }
    }
  }
}
