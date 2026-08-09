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

import { HEARTBEAT, ErrorCode } from '@smai-kit/msgferry-shared';

import { readHeartbeat } from '../../queue.js';
import type { Heartbeat } from '../../queue.js';
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
 * @param root - HGFS 共享根目录
 * @returns 心跳内容与在线状态
 */
export async function checkBridgeHealth(root: string): Promise<CheckBridgeHealthResult> {
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
 * @param root - HGFS 共享根目录
 * @returns 工具回调
 */
export function createCheckBridgeHealthHandler(
  root: string,
): () => Promise<CallToolResult> {
  return async () => {
    try {
      const result = await checkBridgeHealth(root);
      return makeSuccessResult(result);
    } catch (e) {
      return makeErrorResult(ErrorCode.Unknown, getErrorMessage(e));
    }
  };
}
