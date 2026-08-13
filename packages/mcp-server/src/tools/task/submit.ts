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
  logger,
  formatBeijingTimestamp,
} from '@smai-kit/msgferry-shared';

import type { McpServerConfig } from '../../config.js';
import {
  submitTask,
  taskExists,
  readResult,
  checkCancelMarker,
  writeCancelMarker,
  readHeartbeat,
  writeOutboundTask,
  archiveSentTask,
  writeOutboundCancelMarker,
  readResultExchange,
  readHeartbeatExchange,
  exchangeTaskPending,
} from '../../queue.js';
import { createBackoff } from '../../backoff.js';
import { isExchangeMode, syncPush, syncPull } from '../../sync.js';
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
  device?: string;                   // 目标设备名（未指定走默认设备）
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
 * @param device - 目标设备名（可选，未指定走默认设备）
 * @returns 初始化的 CommandTask（status=pending）
 */
function makeCommandTask(taskId: string, cmd: string, timeoutSec: number, device?: string): CommandTask {
  return {
    kind: 'command',
    task_id: taskId,
    batch_id: null,
    depends_on: [],
    cmd,
    device,
    timeout_sec: timeoutSec,
    submit_time: formatBeijingTimestamp(Date.now()),
    start_time: '',
    end_time: '',
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

  // 交换服务器模式：提交前先拉回心跳/结果，随后走 outbound 单文件上传 + inbound 整目录拉回
  if (isExchangeMode(config)) {
    return submitSshTaskExchange(config, root, params, taskId, timeoutSec, submitTime, baseResult);
  }

  // ── 共享目录模式（现状，免同步） ──

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
  const task = makeCommandTask(taskId, params.cmd, timeoutSec, params.device);
  await submitTask(root, task);
  logger.info(`[submit_ssh_task] task submitted: task_id=${taskId} timeout_sec=${timeoutSec} cmd=${params.cmd}`);

  // 阻塞轮询等待结果
  const backoff = createBackoff(config.polling.initial_interval_ms, config.polling.max_interval_ms);
  const deadline = Date.now() + config.max_wait_ms;
  logger.info(`[submit_ssh_task] waiting for result: task_id=${taskId} max_wait_ms=${config.max_wait_ms}`);

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
    logger.warn(`[submit_ssh_task] timed out: task_id=${taskId} max_wait_ms=${config.max_wait_ms}`);
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
    logger.warn(`[submit_ssh_task] cancelled: task_id=${taskId}`);
    return {
      ...baseResult,
      status: TaskStatus.Cancelled,
      duration_ms: durationMs,
      error_msg: 'task cancelled',
    };
  }

  // 拼回大输出
  const overflowResult = await readOverflowIfTruncated(root, result);
  logger.info(`[submit_ssh_task] result read: task_id=${taskId} status=${result.status} duration_ms=${durationMs}`);

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

// ────────────────────────────────────────────────────────────────
// 文件交换服务器模式（exchange）：阻塞同步轮询实现
// 时序：syncPull(拉心跳) → 写 outbound 单文件 → syncPush(上传) →
//       阻塞循环 { syncPull(拉回 inbound) → 查结果 → 超时检查 → sleep }
// 超时后写 cancel marker 并 syncPush，只返回 timeout（不再误标 cancelled）
// ────────────────────────────────────────────────────────────────

/**
 * 交换服务器模式下的任务提交（核心业务逻辑）
 * @param config - MCP Server 配置
 * @param root - HGFS 共享根目录
 * @param params - 工具参数
 * @param taskId - 任务唯一标识
 * @param timeoutSec - 命令超时秒数
 * @param submitTime - 提交时间戳
 * @param baseResult - 基础返回结构
 * @returns 任务执行结果
 */
async function submitSshTaskExchange(
  config: McpServerConfig,
  root: string,
  params: SubmitSshTaskParams,
  taskId: string,
  timeoutSec: number,
  submitTime: number,
  baseResult: SubmitSshTaskResult,
): Promise<SubmitSshTaskResult> {
  // 拉取失败不算 Worker 离线，仅记录告警后继续（提交仍可进行）
  try {
    await syncPull(config);
  } catch (err) {
    logger.warn(`[submit_ssh_task] initial syncPull failed (will retry in loop): ${(err as Error).message}`);
  }

  // 心跳判定（exchange 模式放宽）：文件服务器可达 + 心跳存在 + shutdown_at==null 即在线
  const heartbeat = await readHeartbeatExchange(root);
  if (heartbeat === null) {
    return {
      ...baseResult,
      error_code: ErrorCode.WorkerOffline,
      error_msg: 'no heartbeat found in inbound/ after syncPull',
    };
  }
  if (heartbeat.shutdown_at !== null) {
    return {
      ...baseResult,
      error_code: ErrorCode.WorkerOffline,
      error_msg: 'worker has shut down',
    };
  }

  // 幂等检查：任务仍在本地上传区（outbound/ 或 sent/）则拒绝重复提交
  if (await exchangeTaskPending(root, taskId)) {
    return {
      ...baseResult,
      status: TaskStatus.Pending,
      error_code: ErrorCode.DuplicateSubmit,
      error_msg: 'task already exists in outbound/',
    };
  }

  // 组装任务 → 原子写 outbound/<id>.json → 单文件 push 上传
  const task = makeCommandTask(taskId, params.cmd, timeoutSec, params.device);
  const localTaskPath = await writeOutboundTask(root, task);
  logger.info(`[submit_ssh_task] task written to outbound: task_id=${taskId} timeout_sec=${timeoutSec} cmd=${params.cmd}`);

  try {
    await syncPush(config, localTaskPath);
    // push 成功后单文件移入 outbound/sent/ 留痕（同步范围之外，绝无二次上行）
    await archiveSentTask(root, taskId);
  } catch (err) {
    logger.error(`[submit_ssh_task] syncPush failed: task_id=${taskId} err=${(err as Error).message}`);
    return {
      ...baseResult,
      duration_ms: Date.now() - submitTime,
      error_code: ErrorCode.SyncFailed,
      error_msg: `syncPush failed: ${(err as Error).message}`,
    };
  }

  // 阻塞轮询等待结果：每轮先 syncPull 拉回 inbound/ 再查本地结果
  const backoff = createBackoff(config.polling.initial_interval_ms, config.polling.max_interval_ms);
  const deadline = Date.now() + config.max_wait_ms;
  logger.info(`[submit_ssh_task] waiting for result: task_id=${taskId} max_wait_ms=${config.max_wait_ms}`);

  let result: CommandTask | null = null;
  let timedOut = false;

  while (true) {
    // 每轮先拉取服务器 inbound/ 到本地镜像，再按 task_id 匹配结果
    try {
      await syncPull(config);
    } catch (err) {
      // 拉取失败不算 Worker 离线，重试到 max_wait_ms 封顶
      logger.warn(`[submit_ssh_task] syncPull failed: ${(err as Error).message}`);
    }

    result = await readResultExchange(root, taskId);
    if (result !== null) {
      break;
    }

    // 超时检查
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }

    // 退避等待后进入下一轮同步
    await sleep(backoff.next());
  }

  const durationMs = Date.now() - submitTime;

  // 超时：写 cancel marker 并 push 上传（尽力取消），只返回 timeout
  if (timedOut) {
    logger.warn(`[submit_ssh_task] timed out: task_id=${taskId} max_wait_ms=${config.max_wait_ms}`);
    try {
      const markerPath = await writeOutboundCancelMarker(root, taskId);
      await syncPush(config, markerPath);
      await archiveSentTask(root, taskId);
    } catch (err) {
      logger.warn(`[submit_ssh_task] cancel marker push failed: ${(err as Error).message}`);
    }
    return {
      ...baseResult,
      duration_ms: durationMs,
      error_code: ErrorCode.ExecutionTimeout,
      error_msg: `timed out after ${config.max_wait_ms}ms`,
    };
  }

  // 结果为 null 但非超时（理论不可达，兜底）
  if (result === null) {
    return {
      ...baseResult,
      status: TaskStatus.Pending,
      duration_ms: durationMs,
      error_msg: 'result not found after syncPull',
    };
  }

  // 拼回大输出（overflow 文件随结果批次同目录被 -g 拉回本地 inbound/）
  const overflowResult = await readOverflowIfTruncated(root, result);
  logger.info(`[submit_ssh_task] result read: task_id=${taskId} status=${result.status} duration_ms=${durationMs}`);

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
      device: { type: 'string', description: '目标设备名（未指定走默认设备）' },
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
