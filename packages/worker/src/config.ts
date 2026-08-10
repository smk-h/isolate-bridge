/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : config.ts
 * Author     : MsgFerry
 * Date       : 2026/08/07
 * Version    : 0.0.3
 * Description: Worker 启动配置解析与校验
 *   配置来源收敛为三类：
 *     1. 命令行参数：仅 --hgfs-root（必填）、--log-save、--log-dir（日志两个字段）
 *     2. 配置文件：<hgfs_root>/config/worker.yaml（其余全部可配置项）
 *     3. 内置默认值：配置文件未定义的项兜底
 *   不再支持任何环境变量配置（含 MSGFERRY_* 与日志 LOG_SAVE / LOG_DIR）。
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
  readYamlConfigFile,
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
  queue_mode: 'shared' | 'exchange';    // 队列模式：shared=共享目录 / exchange=文件交换服务器
  executor_type: 'mock' | 'ssh2';       // SSH 执行器选择
  devices: DeviceSshMap;                // 多设备：设备名 → SSH 连接信息（设备名仅字母/数字/下划线/连字符）
  ssh_config: SshConfig | null;          // 默认/兼容设备（旧 ssh 字段），真实模式必填，mock 模式 null
  audit_log_dir: string;                // 审计日志目录（当前固定与 log_dir 一致：<hgfs_root>/logs/worker）
  policy_file: string;                  // 策略文件路径
  polling: {
    initial_interval_ms: number;
    max_interval_ms: number;
  };
  heartbeat_interval_sec: number;
  result_ttl_sec: number;
  max_inline_bytes: number;
  log_save: boolean;                    // 业务日志使能（命令行 --log-save）
  log_dir: string;                      // 业务日志目录（命令行 --log-dir，默认 <hgfs_root>/logs/worker）
}

/** 设备级 SSH 连接配置的原始（文件）结构 */
export interface DeviceSshFileShape {
  host?: string;
  port?: number | string;
  username?: string;
  private_key_path?: string | null;
  password?: string | null;
}

/** Worker 配置文件（<hgfs_root>/config/worker.yaml）的扁平结构 */
export interface WorkerConfigFileShape {
  queue_mode?: string;
  executor?: string;
  devices?: Record<string, DeviceSshFileShape>;  // 多设备（推荐）：设备名 → SSH 连接信息
  ssh?: DeviceSshFileShape;                      // 兼容旧字段：单默认设备
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

/** 默认日志/审计目录名（相对共享根目录） */
const DEFAULT_LOG_DIR_NAME = join('logs', 'worker');
/** 默认策略文件名 */
const DEFAULT_POLICY_FILE_NAME = 'policy.json';
/** 默认策略子目录名（相对共享根目录） */
const DEFAULT_POLICY_DIR_NAME = 'policy';

/**
 * 将配置来源的路径值解析为最终绝对路径
 * - 来源值缺省时：相对共享根目录的内置默认值（<root>/logs/worker、<root>/policy/policy.json）
 * - 来源值为相对路径时：基于共享根目录解析为绝对路径
 * - 来源值为绝对路径时：原样使用（保留命令行/配置文件的显式指定能力）
 * @param value - 配置来源值（命令行/配置文件，可能为 undefined）
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
 * 从命令行参数中取指定 flag 的下一个值
 * @param argv - 进程参数数组
 * @param flag - 形如 '--hgfs-root'
 * @returns 命中时返回 flag 后的值，否则 undefined
 */
function pickArg(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < argv.length) {
    return argv[idx + 1];
  }
  return undefined;
}

/**
 * 数值型配置取值（仅配置文件 + 默认值），非法值回退到默认值
 * @param fileValue - 配置文件中的原始值
 * @param defaultValue - 内置默认值
 * @returns 解析后的数值
 */
function pickNumber(fileValue: unknown, defaultValue: number): number {
  if (fileValue === undefined || fileValue === null || fileValue === '') {
    return defaultValue;
  }
  const n = Number(fileValue);
  return Number.isFinite(n) ? n : defaultValue;
}

/**
 * 字符串型配置取值（仅配置文件 + 默认值），空串视为未配置
 * @param fileValue - 配置文件中的原始值
 * @param defaultValue - 内置默认值
 * @returns 解析后的字符串
 */
function pickString(fileValue: unknown, defaultValue?: string): string | undefined {
  if (fileValue !== undefined && fileValue !== null && fileValue !== '') {
    return String(fileValue);
  }
  return defaultValue;
}

/**
 * 解析命令行参数与配置文件，产出 WorkerConfig
 * - 命令行仅支持 --hgfs-root / --log-save / --log-dir
 * - 其余全部从 <hgfs_root>/config/worker.yaml 读取，未定义项走内置默认值
 * - 不再支持任何环境变量配置
 * @param argv - process.argv
 * @returns WorkerConfig 配置对象
 */
export function parseConfig(argv: string[]): WorkerConfig {
  // hgfs_root 仅来自命令行（配置文件路径依赖它，存在循环依赖）
  const hgfsRoot = pickArg(argv, '--hgfs-root') ?? '';

  // 读取配置文件（存在才生效，否则全部走 CLI/默认值）
  const configFilePath = resolveUnderRoot(hgfsRoot, WORKER_CONFIG_FILE);
  const file = readYamlConfigFile<WorkerConfigFileShape>(configFilePath);

  const executorType = (
    pickString(file.executor, 'mock') ?? 'mock'
  ) as 'mock' | 'ssh2';

  // 队列模式：shared（共享目录，默认）| exchange（文件交换服务器单向信箱）
  const queueMode = (
    pickString(file.queue_mode, 'shared') ?? 'shared'
  ) as 'shared' | 'exchange';
  if (queueMode !== 'shared' && queueMode !== 'exchange') {
    throw new Error(`invalid queue_mode "${queueMode}": must be shared or exchange`);
  }

  // 多设备解析：设备名 → SSH 连接信息
  // 1. 默认设备（兼容旧用法）：配置文件旧 ssh 字段 > 配置文件 devices.default > 无
  const devices: DeviceSshMap = {};
  const rawDevices = file.devices ?? {};
  for (const [name, dev] of Object.entries(rawDevices)) {
    if (name === 'default' || !isValidDeviceName(name)) {
      continue;
    }
    if (!dev || typeof dev !== 'object') {
      continue;
    }
    const host = pickString(dev.host);
    const port = pickNumber(dev.port, 22);
    const username = pickString(dev.username);
    const key = pickString(dev.private_key_path);
    const password = pickString(dev.password);
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

  // 2. 默认设备（default 键或旧 ssh 字段）：host 存在才构建
  const defaultHost =
    pickString(rawDevices.default?.host) ??
    (file.ssh?.host !== undefined ? String(file.ssh.host) : undefined);
  const defaultPort = pickNumber(
    rawDevices.default?.port ?? file.ssh?.port,
    22,
  );
  const defaultUser =
    pickString(rawDevices.default?.username) ??
    (file.ssh?.username !== undefined ? String(file.ssh.username) : undefined);
  const defaultKey = pickString(rawDevices.default?.private_key_path ?? file.ssh?.private_key_path);
  const defaultPassword = pickString(rawDevices.default?.password ?? file.ssh?.password);

  // 多设备场景下也允许同时提供“默认设备”，与旧 ssh 字段一致
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

  // 业务日志：使能与目录来自命令行（--log-save / --log-dir），配置文件不体现。
  // 为保证日志模块能正常初始化和及时写入日志，日志配置必须在命令行就绪，
  // 且由 main 在创建 Logger 前注入环境变量供共享 Logger 延迟初始化读取。
  const logSaveRaw = pickArg(argv, '--log-save');
  const logSave = logSaveRaw === '1' || logSaveRaw === 'true';
  const logDir = resolvePathUnderRoot(
    pickArg(argv, '--log-dir'),
    hgfsRoot,
    DEFAULT_LOG_DIR_NAME,
  );

  // 策略文件：仅配置文件读取，未定义走内置默认 <hgfs_root>/policy/policy.json
  const policyFile = resolvePathUnderRoot(
    pickString(file.policy_file),
    hgfsRoot,
    join(DEFAULT_POLICY_DIR_NAME, DEFAULT_POLICY_FILE_NAME),
  );

  const pollingInitial = pickNumber(
    file.polling?.initial_interval_ms,
    POLLING.initial_interval_ms,
  );
  const pollingMax = pickNumber(
    file.polling?.max_interval_ms,
    POLLING.max_interval_ms,
  );
  const heartbeatInterval = pickNumber(
    file.heartbeat_interval_sec,
    HEARTBEAT.write_interval_sec,
  );
  const resultTtl = pickNumber(
    file.result_ttl_sec,
    RETENTION.result_ttl_sec,
  );
  const maxInline = pickNumber(
    file.max_inline_bytes,
    OUTPUT.max_inline_bytes,
  );

  return {
    hgfs_root: hgfsRoot,
    queue_mode: queueMode,
    executor_type: executorType,
    devices,
    ssh_config: sshConfig,
    // audit_log_dir 保留但暂不与配置文件耦合：固定与业务日志目录一致（<hgfs_root>/logs/worker），
    // 以后有需要再放开配置
    audit_log_dir: logDir,
    policy_file: policyFile,
    polling: {
      initial_interval_ms: pollingInitial,
      max_interval_ms: pollingMax,
    },
    heartbeat_interval_sec: heartbeatInterval,
    result_ttl_sec: resultTtl,
    max_inline_bytes: maxInline,
    log_save: logSave,
    log_dir: logDir,
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
