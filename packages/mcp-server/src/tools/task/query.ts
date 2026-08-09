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

import { TaskStatus, ErrorCode } from '@smai-kit/msgferry-shared';

import {
  readResult,
  checkCancelMarker,
  readTaskFromDir,
} from '../../queue.js';
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
 * @param root - HGFS 共享根目录
 * @param taskId - 任务唯一标识
 * @returns 任务状态与已有结果字段
 */
export async function queryTaskStatus(
  root: string,
  taskId: string,
): Promise<QueryTaskStatusResult> {
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
 * @param root - HGFS 共享根目录
 * @returns 工具回调
 */
export function createQueryTaskStatusHandler(
  root: string,
): (args: QueryTaskStatusParams) => Promise<CallToolResult> {
  return async (args: QueryTaskStatusParams) => {
    try {
      const result = await queryTaskStatus(root, args.task_id);
      return makeSuccessResult(result);
    } catch (e) {
      return makeErrorResult(ErrorCode.Unknown, getErrorMessage(e));
    }
  };
}
