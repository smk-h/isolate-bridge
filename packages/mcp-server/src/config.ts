/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : config.ts
 * Author     : MsgFerry
 * Date       : 2026/08/08
 * Version    : 0.0.1
 * Description: MCP Server 启动配置解析与校验
 * ======================================================
 */

import { existsSync, accessSync, constants } from 'node:fs';

import { WAIT, POLLING } from '@smai-kit/msgferry-shared';

/** MCP Server 启动配置 */
export interface McpServerConfig {
  hgfs_root: string;                    // HGFS 共享根目录绝对路径
  max_wait_ms: number;                  // 提交后阻塞等待结果的最大时长
  polling: {
    initial_interval_ms: number;        // 轮询起步间隔
    max_interval_ms: number;            // 轮询退避上限
  };
}

/**
 * 从 argv 解析单个参数值，未提供则查环境变量
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
 * 解析启动参数与环境变量，产出 McpServerConfig
 * @param argv - process.argv
 * @param env - process.env
 * @returns McpServerConfig 配置对象
 */
export function parseConfig(argv: string[], _env: NodeJS.ProcessEnv): McpServerConfig {
  const hgfsRoot = getArg(argv, '--hgfs-root', 'MSGFERRY_HGFS_ROOT') ?? '';
  const maxWait = getArg(argv, '--max-wait', 'MSGFERRY_MAX_WAIT_MS');
  const pollingInitial = getArg(argv, '--polling-initial', 'MSGFERRY_POLLING_INITIAL');
  const pollingMax = getArg(argv, '--polling-max', 'MSGFERRY_POLLING_MAX');

  return {
    hgfs_root: hgfsRoot,
    max_wait_ms: maxWait ? parseInt(maxWait, 10) : WAIT.default_max_wait_ms,
    polling: {
      initial_interval_ms: pollingInitial ? parseInt(pollingInitial, 10) : POLLING.initial_interval_ms,
      max_interval_ms: pollingMax ? parseInt(pollingMax, 10) : POLLING.max_interval_ms,
    },
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
  if (!existsSync(config.hgfs_root)) {
    throw new Error(`hgfs_root does not exist: ${config.hgfs_root}`);
  }
  try {
    accessSync(config.hgfs_root, constants.R_OK | constants.W_OK);
  } catch {
    throw new Error(`hgfs_root is not readable/writable: ${config.hgfs_root}`);
  }
}
