/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : check.ts
 * Author     : MsgFerry
 * Date       : 2026/08/09
 * Version    : 0.0.1
 * Description: check_bridge_health 工具——检查外网 Worker 存活状态
 * ======================================================
 */

import { fromJsonSchema } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';

import { HEARTBEAT, ErrorCode, logger } from '@smai-kit/msgferry-shared';

import type { McpServerConfig } from '../../config.js';
import { readHeartbeat, readHeartbeatExchange } from '../../queue.js';
import type { Heartbeat } from '../../queue.js';
import { isExchangeMode, syncPull } from '../../sync.js';
import {
  mcpToolConfig,
  makeSuccessResult,
  makeErrorResult,
  getErrorMessage,
} from '../../tool-registry.js';

/** check_bridge_health 工具返回结果 */
export interface CheckBridgeHealthResult {
  online: boolean;
  reason?: 'no_heartbeat' | 'heartbeat_expired' | 'worker_shutdown';
  heartbeat?: Heartbeat;
  age_sec?: number;
}

/**
 * 检查外网 Worker 存活状态（核心业务逻辑）
 * - shared 模式：直接读本地心跳，按 last_beat 15s 实时判定；
 * - exchange 模式：先 syncPull 拉回心跳再判定，判定 = 拉取成功 && 心跳存在 &&
 *   shutdown_at==null（放弃 last_beat 实时判定，Worker 刚挂最长一个同步周期才能感知）。
 * @param config - MCP Server 配置
 * @param root - HGFS 共享根目录
 * @returns 心跳内容与在线状态
 */
export async function checkBridgeHealth(
  config: McpServerConfig,
  root: string,
): Promise<CheckBridgeHealthResult> {
  // 交换服务器模式：先拉取服务器 inbound/（含心跳）到本地镜像
  if (isExchangeMode(config)) {
    try {
      await syncPull(config);
    } catch (err) {
      // 拉取失败 = 文件服务器不可达 = 判定离线
      logger.warn(`[check_bridge_health] syncPull failed: ${(err as Error).message}`);
      return {
        online: false,
        reason: 'no_heartbeat',
      };
    }

    const heartbeat = await readHeartbeatExchange(root);
    if (heartbeat === null) {
      return {
        online: false,
        reason: 'no_heartbeat',
      };
    }
    if (heartbeat.shutdown_at !== null) {
      return {
        online: false,
        reason: 'worker_shutdown',
        heartbeat,
      };
    }
    // exchange 模式放弃 last_beat 实时判定：文件服务器可达 + 心跳存在 + 未 shutdown 即在线
    return {
      online: true,
      heartbeat,
    };
  }

  // ── 共享目录模式（现状，免同步） ──
  const heartbeat = await readHeartbeat(root);

  if (heartbeat === null) {
    return {
      online: false,
      reason: 'no_heartbeat',
    };
  }

  // shutdown_at 非空说明 Worker 已优雅退出
  if (heartbeat.shutdown_at !== null) {
    return {
      online: false,
      reason: 'worker_shutdown',
      heartbeat,
    };
  }

  const ageSec = (Date.now() - heartbeat.last_beat) / 1000;

  // 心跳过期
  if (ageSec > HEARTBEAT.expiry_sec) {
    return {
      online: false,
      reason: 'heartbeat_expired',
      heartbeat,
      age_sec: Math.floor(ageSec),
    };
  }

  return {
    online: true,
    heartbeat,
    age_sec: Math.floor(ageSec),
  };
}

// ── 声明 ──

/** check_bridge_health 工具配置 */
export const checkBridgeHealthConfig: mcpToolConfig = {
  title: 'Check Bridge Health',
  description: '检查外网 Worker 存活状态，读取心跳判断是否在线',
  inputSchema: fromJsonSchema({
    type: 'object',
    properties: {},
  }),
};

// ── 实现 ──

/**
 * 创建 check_bridge_health 工具回调
 * @param config - MCP Server 配置
 * @param root - HGFS 共享根目录
 * @returns 工具回调
 */
export function createCheckBridgeHealthHandler(
  config: McpServerConfig,
  root: string,
): () => Promise<CallToolResult> {
  return async () => {
    try {
      const result = await checkBridgeHealth(config, root);
      return makeSuccessResult(result);
    } catch (e) {
      return makeErrorResult(ErrorCode.Unknown, getErrorMessage(e));
    }
  };
}
