/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : device.ts
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: 设备解析与 SSH 配置查找
 *   收敛「默认设备三层回退」与 findSshConfig 的兼容逻辑，降低认知负担。
 *   对外行为与原 config.ts 逐字节等价，旧 ssh 字段兼容仍保留（是对外契约）。
 * ======================================================
 */

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

/** 设备级 SSH 连接配置的原始（文件）结构 */
export interface DeviceSshFileShape {
  host?: string;
  port?: number | string;
  username?: string;
  private_key_path?: string | null;
  password?: string | null;
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

/**
 * 数值型配置取值，非法值回退到默认值
 * @param fileValue - 配置文件中的原始值
 * @param defaultValue - 内置默认值
 * @returns 解析后的数值
 */
export function pickNumber(fileValue: unknown, defaultValue: number): number {
  if (fileValue === undefined || fileValue === null || fileValue === '') {
    return defaultValue;
  }
  const n = Number(fileValue);
  return Number.isFinite(n) ? n : defaultValue;
}

/**
 * 字符串型配置取值，空串视为未配置
 * @param fileValue - 配置文件中的原始值
 * @param defaultValue - 内置默认值
 * @returns 解析后的字符串
 */
export function pickString(fileValue: unknown, defaultValue?: string): string | undefined {
  if (fileValue !== undefined && fileValue !== null && fileValue !== '') {
    return String(fileValue);
  }
  return defaultValue;
}

/**
 * 解析默认设备（兼容旧 ssh 字段的三层回退）
 * 对 config.ts 原有逻辑的封装，行为逐字节等价。
 *
 * 步骤一：默认设备（default 键或旧 ssh 字段），host/username 完整才构建。
 * 步骤二：兼容旧用法——executor 为 ssh2 且无默认设备时，若配置了旧 ssh 字段，把它作为默认设备。
 *
 * @param rawDevices - 配置文件 devices 字典
 * @param legacySsh - 配置文件旧 ssh 字段（单默认设备）
 * @param executorType - 执行器类型（仅 ssh2 触发旧字段兑底）
 * @returns 默认设备 SshConfig，无法构建时返回 undefined
 */
export function resolveDefaultDevice(
  rawDevices: Record<string, DeviceSshFileShape> | undefined,
  legacySsh: DeviceSshFileShape | undefined,
  executorType: 'mock' | 'ssh2',
): SshConfig | undefined {
  // 共享中间值（与原实现一致，避免分支间取值漂移）
  const defaultHost =
    pickString(rawDevices?.default?.host) ??
    (legacySsh?.host !== undefined ? String(legacySsh.host) : undefined);
  const defaultPort = pickNumber(
    rawDevices?.default?.port ?? legacySsh?.port,
    22,
  );
  const defaultUser =
    pickString(rawDevices?.default?.username) ??
    (legacySsh?.username !== undefined ? String(legacySsh.username) : undefined);
  const defaultKey = pickString(rawDevices?.default?.private_key_path ?? legacySsh?.private_key_path);
  const defaultPassword = pickString(rawDevices?.default?.password ?? legacySsh?.password);

  // 默认设备（default 键或旧 ssh 字段）：host 存在才构建
  if (defaultHost && defaultUser) {
    return {
      host: defaultHost,
      port: defaultPort,
      username: defaultUser,
      private_key_path: defaultKey ?? null,
      password: defaultPassword ?? null,
    };
  }

  // 兼容旧用法：executor 为 ssh2 时，若配置了旧 ssh 字段（无默认设备），把它作为默认设备
  if (executorType === 'ssh2' && legacySsh?.host) {
    return {
      host: String(legacySsh.host),
      port: defaultPort,
      username: String(legacySsh.username ?? ''),
      private_key_path: defaultKey ?? null,
      password: defaultPassword ?? null,
    };
  }

  return undefined;
}

/**
 * 按设备名查找 SSH 连接配置
 * 后续连接 SSH 时可通过设备名查询对应的 ip/host 及账号信息。
 * 查找顺序：devices[设备名] > devices.default（若传入 default 或未命中时回退）> ssh_config（旧兼容）
 * @param config - Worker 配置
 * @param deviceName - 设备名（不传或为空时返回默认设备）
 * @returns SSH 连接配置，未找到返回 undefined
 */
export function findSshConfig(
  config: { devices: DeviceSshMap; ssh_config: SshConfig | null },
  deviceName?: string,
): SshConfig | undefined {
  if (deviceName && isValidDeviceName(deviceName) && config.devices[deviceName]) {
    return config.devices[deviceName];
  }
  return config.devices.default ?? config.ssh_config ?? undefined;
}
