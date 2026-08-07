/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : tools.ts
 * Author     : MsgFerry
 * Date       : 2026/08/08
 * Version    : 0.0.1
 * Description: 四个 MCP 工具的核心业务逻辑——提交任务、查询状态、取消任务、健康检查
 * ======================================================
 */

import { randomUUID } from 'node:crypto';

import {
  CommandTask,
  TaskStatus,
  ErrorCode,
  HEARTBEAT,
  OUTPUT,
} from '@smai-kit/msgferry-shared';

import type { McpServerConfig } from './config.js';
import {
  submitTask,
  taskExists,
  readResult,
  readTaskFromDir,
  checkCancelMarker,
  writeCancelMarker,
  readHeartbeat,
  readOverflowOutput,
} from './queue.js';
import type { Heartbeat } from './queue.js';
import { createBackoff } from './backoff.js';

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

/** cancel_task 工具返回结果 */
export interface CancelTaskResult {
  task_id: string;
  cancelled: boolean;
  error_code?: 'not_found';
}

/** check_bridge_health 工具返回结果 */
export interface CheckBridgeHealthResult {
  online: boolean;
  reason?: 'no_heartbeat' | 'heartbeat_expired' | 'worker_shutdown';
  heartbeat?: Heartbeat;
  age_sec?: number;
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
 * 若任务 truncated=true 则按指针读取大输出拼回
 * @param root - HGFS 共享根目录
 * @param task - 任务结构体
 * @returns 拼回后的 stdout/stderr/truncated/error_msg
 */
async function readOverflowIfTruncated(
  root: string,
  task: CommandTask,
): Promise<{
  stdout: string;
  stderr: string;
  truncated: boolean;
  error_msg: string | null;
}> {
  if (!task.truncated) {
    return {
      stdout: task.stdout,
      stderr: task.stderr,
      truncated: false,
      error_msg: task.error_msg,
    };
  }

  let stdout = task.stdout;
  let stderr = task.stderr;
  let errorMsg = task.error_msg;

  // 按指针路径读取完整 stdout
  if (task.stdout_overflow_path) {
    const fullStdout = await readOverflowOutput(root, task.stdout_overflow_path);
    if (fullStdout !== null) {
      stdout = fullStdout;
    } else {
      errorMsg = ErrorCode.OverflowReadFailed;
    }
  }

  // 按指针路径读取完整 stderr
  if (task.stderr_overflow_path) {
    const fullStderr = await readOverflowOutput(root, task.stderr_overflow_path);
    if (fullStderr !== null) {
      stderr = fullStderr;
    } else {
      errorMsg = ErrorCode.OverflowReadFailed;
    }
  }

  return {
    stdout,
    stderr,
    truncated: false,
    error_msg: errorMsg,
  };
}

/**
 * 提交 SSH 任务并阻塞等待结果
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

/**
 * 查询任务当前状态
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

/**
 * 取消任务——写入取消标记
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

/**
 * 检查外网 Worker 存活状态
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
