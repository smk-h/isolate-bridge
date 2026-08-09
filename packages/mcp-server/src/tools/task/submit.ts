/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : submit.ts
 * Author     : MsgFerry
 * Date       : 2026/08/09
 * Version    : 0.0.1
 * Description: submit_ssh_task 工具——提交 SSH 命令到外网 Worker 执行，阻塞等待结果
 * ======================================================
 */

import { randomUUID } from 'node:crypto';

import { fromJsonSchema } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';

import {
  CommandTask,
  TaskStatus,
  ErrorCode,
  HEARTBEAT,
  OUTPUT,
} from '@smai-kit/msgferry-shared';

import type { McpServerConfig } from '../../config.js';
import {
  submitTask,
  taskExists,
  readResult,
  checkCancelMarker,
  writeCancelMarker,
  readHeartbeat,
} from '../../queue.js';
import { createBackoff } from '../../backoff.js';
import {
  readOverflowIfTruncated,
} from '../../shared/task-result.js';
import {
  mcpToolConfig,
  makeSuccessResult,
  makeErrorResult,
  getErrorMessage,
} from '../../tool-registry.js';

/** submit_ssh_task 工具参数 */
export interface SubmitSshTaskParams {
  cmd: string;
  timeout_sec?: number;              // 默认 30
  task_id?: string;                  // 默认自动生成 UUID
}

/** submit_ssh_task 工具返回结果 */
export interface SubmitSshTaskResult {
  task_id: string;
  status: TaskStatus | 'timeout';
  exit_code: number | null;
  stdout: string;
  stderr: string;
  error_msg: string | null;
  truncated: boolean;
  stdout_size: number;
  stderr_size: number;
  duration_ms: number;
  error_code?: ErrorCode;            // 前置检查失败时填充
}

/** 默认命令超时秒数 */
const DEFAULT_TIMEOUT_SEC = 30;

/**
 * 延时工具
 * @param ms - 毫秒
 * @returns 延时后 resolve 的 Promise
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 组装初始 CommandTask 结构体
 * @param taskId - 任务唯一标识
 * @param cmd - 待执行命令
 * @param timeoutSec - 超时秒数
 * @returns 初始化的 CommandTask（status=pending）
 */
function makeCommandTask(taskId: string, cmd: string, timeoutSec: number): CommandTask {
  return {
    kind: 'command',
    task_id: taskId,
    batch_id: null,
    depends_on: [],
    cmd,
    timeout_sec: timeoutSec,
    submit_time: Date.now(),
    start_time: 0,
    end_time: 0,
    stdout: '',
    stderr: '',
    stdout_size: 0,
    stderr_size: 0,
    truncated: false,
    stdout_overflow_path: null,
    stderr_overflow_path: null,
    max_inline_bytes: OUTPUT.max_inline_bytes,
    exit_code: null,
    error_msg: null,
    status: TaskStatus.Pending,
    worker_pid: null,
    policy_blocked: false,
  };
}

/**
 * 提交 SSH 任务并阻塞等待结果（核心业务逻辑）
 * @param config - MCP Server 配置
 * @param root - HGFS 共享根目录
 * @param params - 工具参数
 * @returns 任务执行结果
 */
export async function submitSshTask(
  config: McpServerConfig,
  root: string,
  params: SubmitSshTaskParams,
): Promise<SubmitSshTaskResult> {
  const taskId = params.task_id ?? randomUUID();
  const timeoutSec = params.timeout_sec ?? DEFAULT_TIMEOUT_SEC;
  const submitTime = Date.now();

  // 基础返回结构
  const baseResult: SubmitSshTaskResult = {
    task_id: taskId,
    status: 'timeout',
    exit_code: null,
    stdout: '',
    stderr: '',
    error_msg: null,
    truncated: false,
    stdout_size: 0,
    stderr_size: 0,
    duration_ms: 0,
  };

  // 幂等检查：pending/processing 已存在同 task_id 则拒绝
  const existing = await taskExists(root, taskId);
  if (existing !== null) {
    return {
      ...baseResult,
      status: existing,
      error_code: ErrorCode.DuplicateSubmit,
      error_msg: `task already exists in ${existing}`,
    };
  }

  // Worker 存活检查：心跳不存在或过期或已 shutdown 则拒绝
  const heartbeat = await readHeartbeat(root);
  if (heartbeat === null) {
    return {
      ...baseResult,
      error_code: ErrorCode.WorkerOffline,
      error_msg: 'no heartbeat file found',
    };
  }
  if (heartbeat.shutdown_at !== null) {
    return {
      ...baseResult,
      error_code: ErrorCode.WorkerOffline,
      error_msg: 'worker has shut down',
    };
  }
  const heartbeatAgeMs = Date.now() - heartbeat.last_beat;
  if (heartbeatAgeMs > HEARTBEAT.expiry_sec * 1000) {
    return {
      ...baseResult,
      error_code: ErrorCode.WorkerOffline,
      error_msg: `heartbeat expired: ${Math.floor(heartbeatAgeMs / 1000)}s ago`,
    };
  }

  // 组装任务并原子提交
  const task = makeCommandTask(taskId, params.cmd, timeoutSec);
  await submitTask(root, task);

  // 阻塞轮询等待结果
  const backoff = createBackoff(config.polling.initial_interval_ms, config.polling.max_interval_ms);
  const deadline = Date.now() + config.max_wait_ms;

  let result: CommandTask | null = null;
  let timedOut = false;

  while (true) {
    // 检查结果文件
    result = await readResult(root, taskId);
    if (result !== null) {
      break;
    }

    // 检查取消标记（内网自己写的取消标记，理论上不会出现在 submit 流程中，但兜底）
    const cancelled = await checkCancelMarker(root, taskId);
    if (cancelled) {
      break;
    }

    // 超时检查
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }

    // 退避等待
    await sleep(backoff.next());
  }

  const durationMs = Date.now() - submitTime;

  // 超时兜底：写取消标记并返回 execution_timeout
  if (timedOut) {
    await writeCancelMarker(root, taskId);
    return {
      ...baseResult,
      duration_ms: durationMs,
      error_code: ErrorCode.ExecutionTimeout,
      error_msg: `timed out after ${config.max_wait_ms}ms`,
    };
  }

  // 结果为 null 但非超时（被取消标记命中）
  if (result === null) {
    return {
      ...baseResult,
      status: TaskStatus.Cancelled,
      duration_ms: durationMs,
      error_msg: 'task cancelled',
    };
  }

  // 拼回大输出
  const overflowResult = await readOverflowIfTruncated(root, result);

  return {
    task_id: taskId,
    status: result.status,
    exit_code: result.exit_code,
    stdout: overflowResult.stdout,
    stderr: overflowResult.stderr,
    error_msg: overflowResult.error_msg,
    truncated: overflowResult.truncated,
    stdout_size: result.stdout_size,
    stderr_size: result.stderr_size,
    duration_ms: durationMs,
  };
}

// ── 声明 ──

/** submit_ssh_task 工具配置 */
export const submitSshTaskConfig: mcpToolConfig = {
  title: 'Submit SSH Task',
  description: '提交 SSH 命令到外网 Worker 执行，阻塞等待结果返回',
  inputSchema: fromJsonSchema<SubmitSshTaskParams>({
    type: 'object',
    properties: {
      cmd: { type: 'string', description: '待执行 SSH 命令' },
      timeout_sec: { type: 'number', description: '命令超时秒数，默认 30' },
      task_id: { type: 'string', description: '自定义任务标识，未提供则自动生成' },
    },
    required: ['cmd'],
  }),
};

// ── 实现 ──

/**
 * 创建 submit_ssh_task 工具回调
 * @param config - MCP Server 配置
 * @param root - HGFS 共享根目录
 * @returns 工具回调
 */
export function createSubmitSshTaskHandler(
  config: McpServerConfig,
  root: string,
): (args: SubmitSshTaskParams) => Promise<CallToolResult> {
  return async (args: SubmitSshTaskParams) => {
    try {
      const result = await submitSshTask(config, root, args);
      return makeSuccessResult(result);
    } catch (e) {
      return makeErrorResult(ErrorCode.Unknown, getErrorMessage(e));
    }
  };
}
