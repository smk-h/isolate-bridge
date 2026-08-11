/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : config.ts
 * Author     : MsgFerry
 * Date       : 2026/08/08
 * Version    : 0.0.2
 * Description: MCP Server 启动配置解析与校验
 *   配置来源收敛：全部由环境变量注入，不再支持任何命令行参数；
 *   环境变量未定义时回退内置默认值。
 * ======================================================
 */

import { existsSync, accessSync, constants, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

import { WAIT, POLLING, SYNC } from '@smai-kit/msgferry-shared';

/** 同步模式：shared = 共享目录（免同步）；exchange = 文件交换服务器（手动同步） */
export type SyncMode = 'shared' | 'exchange';

/** MCP Server 启动配置 */
export interface McpServerConfig {
  hgfs_root: string;                    // HGFS 共享根目录绝对路径
  max_wait_ms: number;                  // 提交后阻塞等待结果的最大时长
  polling: {
    initial_interval_ms: number;        // 轮询起步间隔
    max_interval_ms: number;            // 轮询退避上限
  };
  sync_mode: SyncMode;                  // 同步模式：共享目录 / 文件交换服务器
  sync_push_cmd?: string;               // push 模板命令（含 {src}/{dst} 占位符），exchange 模式必填
  sync_pull_cmd?: string;               // pull 静态命令（整目录拉回），exchange 模式必填
  sync_timeout_ms: number;              // 单次同步命令超时（毫秒）
  sync_retries: number;                 // 同步失败退避重试次数
}

/**
 * 展开路径中的家目录占位符（`~` 与 `$HOME`）为真实家目录路径
 *
 * 跨平台说明：
 * - Windows 原生环境的 `$HOME` 变量通常不存在（用的是 `USERPROFILE`），
 *   因此这里不依赖 `process.env.HOME`，而是统一用 `node:os` 的 `homedir()`，
 *   它在 Windows 优先取 `USERPROFILE`、在 Linux/macOS 取 `HOME`，跨平台可靠。
 * - 支持两种写法：
 *   - `~/.msgferry/vm_share`      → `${homedir}/.msgferry/vm_share`
 *   - `$HOME/.msgferry/vm_share`  → `${homedir}/.msgferry/vm_share`
 *   兼容 `/$HOME/...`（用户可能多写一个前导 `/`）的写法。
 * - 不含占位符时原样返回。
 *
 * @param raw - 配置原始值（如 `$HOME/.msgferry/vm_share`）
 * @returns 展开后的绝对路径
 */
export function expandHomeDir(raw: string): string {
  if (!raw) {
    return raw;
  }
  const home = homedir();
  if (!home) {
    return raw;
  }
  // 先处理 `~` 前缀，再处理 `$HOME`（兼容可选的前导 `/`）
  let expanded = raw;
  if (expanded === '~' || expanded.startsWith('~/')) {
    expanded = home + expanded.slice(1);
  }
  expanded = expanded.replace(/^\/?\$HOME\//, `${home}/`).replace(/^\$HOME$/, home);
  return expanded;
}

/**
 * 从环境变量读取单个配置值（空串视为未配置）
 * @param env - 进程环境变量
 * @param key - 环境变量名（如 'MSGFERRY_HGFS_ROOT'）
 * @returns 环境变量值，未设置返回 undefined
 */
function getEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value !== undefined && value !== '' ? value : undefined;
}

/**
 * 从环境变量读取数值型配置，非法值回退内置默认值
 * @param env - 进程环境变量
 * @param key - 环境变量名
 * @param defaultValue - 内置默认值
 * @returns 解析后的数值
 */
function getEnvNumber(env: NodeJS.ProcessEnv, key: string, defaultValue: number): number {
  const raw = getEnv(env, key);
  if (raw === undefined) {
    return defaultValue;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaultValue;
}

/**
 * 解析环境变量，产出 McpServerConfig
 * - 仅读取 MSGFERRY_HGFS_ROOT / MSGFERRY_MAX_WAIT_MS /
 *   MSGFERRY_POLLING_INITIAL / MSGFERRY_POLLING_MAX /
 *   MSGFERRY_SYNC_PUSH_CMD / MSGFERRY_SYNC_PULL_CMD /
 *   MSGFERRY_SYNC_TIMEOUT_MS / MSGFERRY_SYNC_RETRIES，不解析任何命令行参数；
 * - 配置了任一同步命令 → sync_mode='exchange'（文件交换服务器模式）；
 * - 未配置任何同步命令 → sync_mode='shared'（共享目录模式，同步全部短路）。
 * @param _argv - process.argv（保留签名，忽略命令行参数）
 * @param env - process.env
 * @returns McpServerConfig 配置对象
 */
export function parseConfig(_argv: string[], env: NodeJS.ProcessEnv): McpServerConfig {
  // MSGFERRY_HGFS_ROOT 支持 `$HOME`/`~` 占位符，启动时自动展开为家目录绝对路径
  const hgfsRoot = expandHomeDir(getEnv(env, 'MSGFERRY_HGFS_ROOT') ?? '');
  const maxWait = getEnvNumber(env, 'MSGFERRY_MAX_WAIT_MS', WAIT.default_max_wait_ms);
  const pollingInitial = getEnvNumber(env, 'MSGFERRY_POLLING_INITIAL', POLLING.initial_interval_ms);
  const pollingMax = getEnvNumber(env, 'MSGFERRY_POLLING_MAX', POLLING.max_interval_ms);

  // 文件交换服务器模式：任一同步命令被配置即进入 exchange，共享目录模式全部短路
  const syncPushCmd = getEnv(env, 'MSGFERRY_SYNC_PUSH_CMD');
  const syncPullCmd = getEnv(env, 'MSGFERRY_SYNC_PULL_CMD');
  const syncMode: SyncMode =
    syncPushCmd !== undefined || syncPullCmd !== undefined ? 'exchange' : 'shared';
  const syncTimeout = getEnvNumber(env, 'MSGFERRY_SYNC_TIMEOUT_MS', SYNC.timeout_ms);
  const syncRetries = getEnvNumber(env, 'MSGFERRY_SYNC_RETRIES', SYNC.retries);

  return {
    hgfs_root: hgfsRoot,
    max_wait_ms: maxWait,
    polling: {
      initial_interval_ms: pollingInitial,
      max_interval_ms: pollingMax,
    },
    sync_mode: syncMode,
    sync_push_cmd: syncPushCmd,
    sync_pull_cmd: syncPullCmd,
    sync_timeout_ms: syncTimeout,
    sync_retries: syncRetries,
  };
}

/**
 * 校验配置完整性，校验失败抛错
 * @param config - McpServerConfig 配置对象
 * @throws {Error} hgfs_root 不存在或不可读写时抛错
 */
export function validateConfig(config: McpServerConfig): void {
  if (!config.hgfs_root) {
    throw new Error('hgfs_root is required');
  }
  // 目录不存在时自动创建（幂等，递归创建父级），避免手动 mkdir
  if (!existsSync(config.hgfs_root)) {
    mkdirSync(config.hgfs_root, { recursive: true });
  }
  try {
    accessSync(config.hgfs_root, constants.R_OK | constants.W_OK);
  } catch {
    throw new Error(`hgfs_root is not readable/writable: ${config.hgfs_root}`);
  }
}
