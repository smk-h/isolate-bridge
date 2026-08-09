/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : cancel.ts
 * Author     : MsgFerry
 * Date       : 2026/08/09
 * Version    : 0.0.1
 * Description: cancel_task 工具——取消任务，写入取消标记触发 Worker 孤儿结果回收
 * ======================================================
 */

import { fromJsonSchema } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';

import { ErrorCode } from '@smai-kit/msgferry-shared';

import { writeCancelMarker } from '../../queue.js';
import { queryTaskStatus } from './query.js';
import {
  mcpToolConfig,
  makeSuccessResult,
  makeErrorResult,
  getErrorMessage,
} from '../../tool-registry.js';

/** cancel_task 工具参数 */
export interface CancelTaskParams {
  task_id: string;
}

/** cancel_task 工具返回结果 */
export interface CancelTaskResult {
  task_id: string;
  cancelled: boolean;
  error_code?: 'not_found';
}

/**
 * 取消任务——写入取消标记（核心业务逻辑）
 * @param root - HGFS 共享根目录
 * @param taskId - 任务唯一标识
 * @returns 取消结果
 */
export async function cancelTask(
  root: string,
  taskId: string,
): Promise<CancelTaskResult> {
  // 先检查任务是否存在
  const statusResult = await queryTaskStatus(root, taskId);
  if (statusResult.error_code === 'not_found') {
    return {
      task_id: taskId,
      cancelled: false,
      error_code: 'not_found',
    };
  }

  // 写入取消标记
  await writeCancelMarker(root, taskId);

  return {
    task_id: taskId,
    cancelled: true,
  };
}

// ── 声明 ──

/** cancel_task 工具配置 */
export const cancelTaskConfig: mcpToolConfig = {
  title: 'Cancel Task',
  description: '取消任务，写入取消标记触发 Worker 孤儿结果回收',
  inputSchema: fromJsonSchema<CancelTaskParams>({
    type: 'object',
    properties: {
      task_id: { type: 'string', description: '任务唯一标识' },
    },
    required: ['task_id'],
  }),
};

// ── 实现 ──

/**
 * 创建 cancel_task 工具回调
 * @param root - HGFS 共享根目录
 * @returns 工具回调
 */
export function createCancelTaskHandler(
  root: string,
): (args: CancelTaskParams) => Promise<CallToolResult> {
  return async (args: CancelTaskParams) => {
    try {
      const result = await cancelTask(root, args.task_id);
      return makeSuccessResult(result);
    } catch (e) {
      return makeErrorResult(ErrorCode.Unknown, getErrorMessage(e));
    }
  };
}
