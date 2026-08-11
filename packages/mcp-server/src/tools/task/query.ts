/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : query.ts
 * Author     : MsgFerry
 * Date       : 2026/08/09
 * Version    : 0.0.1
 * Description: query_task_status 工具——按 task_id 查询任务当前状态与已有结果
 * ======================================================
 */

import { fromJsonSchema } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';

import { TaskStatus, ErrorCode, logger } from '@smai-kit/msgferry-shared';

import type { McpServerConfig } from '../../config.js';
import {
  readResult,
  checkCancelMarker,
  readTaskFromDir,
  readResultExchange,
  exchangeTaskPending,
} from '../../queue.js';
import { isExchangeMode, syncPull } from '../../sync.js';
import { readOverflowIfTruncated } from '../../shared/task-result.js';
import {
  mcpToolConfig,
  makeSuccessResult,
  makeErrorResult,
  getErrorMessage,
} from '../../tool-registry.js';

/** query_task_status 工具参数 */
export interface QueryTaskStatusParams {
  task_id: string;
}

/** query_task_status 工具返回结果 */
export interface QueryTaskStatusResult {
  task_id: string;
  status: TaskStatus;
  exit_code?: number | null;
  stdout?: string;
  stderr?: string;
  error_msg?: string | null;
  truncated?: boolean;
  error_code?: 'not_found';
}

/**
 * 查询任务当前状态（核心业务逻辑）
 * - shared 模式：直接查本地目录；
 * - exchange 模式：先 syncPull 拉回服务器 inbound/ 再查本地镜像；
 *   任务在本地 outbound/+sent/ 仍可找到 → pending（不再误报 not_found/Cancelled）。
 * @param config - MCP Server 配置
 * @param root - HGFS 共享根目录
 * @param taskId - 任务唯一标识
 * @returns 任务状态与已有结果字段
 */
export async function queryTaskStatus(
  config: McpServerConfig,
  root: string,
  taskId: string,
): Promise<QueryTaskStatusResult> {
  // 交换服务器模式：先拉取服务器 inbound/ 到本地镜像再查询
  if (isExchangeMode(config)) {
    try {
      await syncPull(config);
    } catch (err) {
      logger.warn(`[query_task_status] syncPull failed: ${(err as Error).message}`);
    }

    // 优先检查 inbound/ 镜像中的结果
    const result = await readResultExchange(root, taskId);
    if (result !== null) {
      const overflow = await readOverflowIfTruncated(root, result);
      return {
        task_id: taskId,
        status: result.status,
        exit_code: result.exit_code,
        stdout: overflow.stdout,
        stderr: overflow.stderr,
        error_msg: overflow.error_msg,
        truncated: overflow.truncated,
      };
    }

    // 任务仍在本地上传区（outbound/ 或 sent/ 留痕）→ 尚未被 Worker 领取，判定 pending
    if (await exchangeTaskPending(root, taskId)) {
      return {
        task_id: taskId,
        status: TaskStatus.Pending,
      };
    }

    // 本地无结果、无上传痕迹 → 可能已执行但结果尚未拉回，返回 pending 而非误报 not_found
    return {
      task_id: taskId,
      status: TaskStatus.Pending,
    };
  }

  // ── 共享目录模式（现状，免同步） ──

  // 优先检查终态结果文件（completed/failed/cancelled.result）
  const result = await readResult(root, taskId);
  if (result !== null) {
    const overflow = await readOverflowIfTruncated(root, result);
    return {
      task_id: taskId,
      status: result.status,
      exit_code: result.exit_code,
      stdout: overflow.stdout,
      stderr: overflow.stderr,
      error_msg: overflow.error_msg,
      truncated: overflow.truncated,
    };
  }

  // 检查取消标记（已取消但 Worker 尚未回写 .result）
  const cancelMarker = await checkCancelMarker(root, taskId);
  if (cancelMarker) {
    return {
      task_id: taskId,
      status: TaskStatus.Cancelled,
    };
  }

  // 检查 processing 目录
  const processing = await readTaskFromDir(root, 'processing', taskId);
  if (processing !== null) {
    return {
      task_id: taskId,
      status: TaskStatus.Processing,
    };
  }

  // 检查 pending 目录
  const pending = await readTaskFromDir(root, 'pending', taskId);
  if (pending !== null) {
    return {
      task_id: taskId,
      status: TaskStatus.Pending,
    };
  }

  // 全部目录均未找到
  return {
    task_id: taskId,
    status: TaskStatus.Cancelled,
    error_code: 'not_found',
  };
}

// ── 声明 ──

/** query_task_status 工具配置 */
export const queryTaskStatusConfig: mcpToolConfig = {
  title: 'Query Task Status',
  description: '按 task_id 查询任务当前状态与已有结果',
  inputSchema: fromJsonSchema<QueryTaskStatusParams>({
    type: 'object',
    properties: {
      task_id: { type: 'string', description: '任务唯一标识' },
    },
    required: ['task_id'],
  }),
};

// ── 实现 ──

/**
 * 创建 query_task_status 工具回调
 * @param config - MCP Server 配置
 * @param root - HGFS 共享根目录
 * @returns 工具回调
 */
export function createQueryTaskStatusHandler(
  config: McpServerConfig,
  root: string,
): (args: QueryTaskStatusParams) => Promise<CallToolResult> {
  return async (args: QueryTaskStatusParams) => {
    try {
      const result = await queryTaskStatus(config, root, args.task_id);
      return makeSuccessResult(result);
    } catch (e) {
      return makeErrorResult(ErrorCode.Unknown, getErrorMessage(e));
    }
  };
}
