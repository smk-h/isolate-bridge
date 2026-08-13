/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : task-runner.ts
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: 任务处理业务流——抢占 → 策略校验 → SSH 执行 → 取消检查 → 回写
 *   从 main.ts 拆出，使编排（组装）与业务流解耦，业务流可独立单测。
 *   队列模式的 shared/exchange 分支收敛到 QueueModeStrategy，此处不再出现 if mode。
 * ======================================================
 */

import type { WorkerConfig } from './config/index.js';
import type { QueueModeStrategy } from './queue/index.js';
import { transitionToProcessing } from './queue/index.js';
import { checkCommand } from './policy/index.js';
import type { PolicyRule, PolicyResult } from './policy/index.js';
import type { CmdExecutor, CmdResult } from './executor/index.js';
import { SshExecExecutor } from './executor/index.js';
import type { AuditLogger } from './log/index.js';
import { formatSystemTime } from './log/index.js';
import type { AuditEntry } from './log/index.js';

import { logger } from './log/index.js';
import { formatBeijingTimestamp } from '@smai-kit/msgferry-shared';
import type { CommandTask } from '@smai-kit/msgferry-shared';

/**
 * 处理单个任务：抢占 → 策略校验 → SSH 执行 → 取消检查 → 回写
 * 队列模式的目录选择 / 结果回写 / 取消方式统一由 strategy 封装，无分支。
 * @param config - Worker 配置
 * @param root - HGFS 共享根目录
 * @param task - 任务结构体（会被原地修改）
 * @param pid - Worker 进程 PID
 * @param policyRule - 安全策略规则
 * @param executor - SSH 执行器
 * @param auditLogger - 审计日志器
 * @param strategy - 队列模式策略（决定领取源 / 回写路径 / 取消检查）
 */
export async function processTask(
  config: WorkerConfig,
  root: string,
  task: CommandTask,
  pid: number,
  policyRule: PolicyRule,
  executor: CmdExecutor,
  auditLogger: AuditLogger,
  strategy: QueueModeStrategy,
): Promise<void> {
  const startTime = Date.now();
  // 按队列模式流转：exchange 从 outbound/ 领取，shared 从 pending/ 领取
  await transitionToProcessing(root, task, pid, strategy.transitionSourceDir());
  logger.info(`[worker] task processing: task_id=${task.task_id} pid=${pid}`);

  // 安全策略校验
  const policyResult = checkCommand(policyRule, task.cmd);
  if (!policyResult.allowed) {
    task.status = 'failed';
    task.policy_blocked = true;
    task.error_msg = 'blocked_by_policy';
    task.end_time = formatBeijingTimestamp(Date.now());
    // 按队列模式回写：exchange 写 inbound/，shared 写 failed/
    await strategy.writeResult(root, task, config.max_inline_bytes);
    await auditLogger.log(makeAuditEntry(task, policyResult, null, startTime, false));
    logger.warn(`[worker] task blocked by policy: task_id=${task.task_id} reason=${policyResult.reason} cmd=${task.cmd}`);
    return;
  }
  logger.info(`[worker] policy check passed: task_id=${task.task_id}`);

  // SSH 执行
  logger.info(`[worker] ssh executing: task_id=${task.task_id} timeout_sec=${task.timeout_sec} cmd=${task.cmd}`);
  let cmdResult: CmdResult;
  try {
    cmdResult = await executor.execute(task.cmd, task.timeout_sec, task.device);
  } catch (err) {
    // 执行异常（如 SSH 建连失败/会话异常）：归一化为失败任务回写，避免任务静默丢失
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[worker] task ${task.task_id} execute error: ${msg}`);
    task.status = 'failed';
    task.exit_code = null;
    task.stderr = msg;
    task.stderr_size = Buffer.byteLength(msg, 'utf-8');
    task.error_msg = msg;
    task.end_time = formatBeijingTimestamp(Date.now());
    await strategy.writeResult(root, task, config.max_inline_bytes);
    await auditLogger.log(makeAuditEntry(task, policyResult, null, startTime, false));
    return;
  }
  // 取已建立会话 id 作为审计 ssh_target（SshExecExecutor 有，MockExecutor 无）
  const sshTarget = executor instanceof SshExecExecutor
    ? (executor.getSessionId(task.device) ?? null)
    : null;
  logger.info(`[worker] ssh executed: task_id=${task.task_id} exit_code=${cmdResult.exit_code} timed_out=${cmdResult.timed_out}`);
  task.stdout = cmdResult.stdout;
  task.stderr = cmdResult.stderr;
  task.stdout_size = Buffer.byteLength(cmdResult.stdout, 'utf-8');
  task.stderr_size = Buffer.byteLength(cmdResult.stderr, 'utf-8');
  task.exit_code = cmdResult.exit_code;
  task.error_msg = cmdResult.stderr || (cmdResult.timed_out ? 'execution_timeout' : null);
  task.end_time = formatBeijingTimestamp(Date.now());

  // 取消检查（exchange 查 outbound/cancel_<id>.marker，shared 查 cancelled/<id>）
  const cancelled = await strategy.checkCancelled(root, task.task_id);
  if (cancelled) {
    task.status = 'cancelled';
    // 按模式回写取消结果：exchange 写 inbound/result_<id>.result
    await strategy.writeCancelledResult(root, task);
    await auditLogger.log(makeAuditEntry(task, policyResult, sshTarget, startTime, true));
    logger.warn(`[worker] task cancelled: task_id=${task.task_id}`);
    return;
  }

  // 正常回写（exchange 写 inbound/，shared 写 completed|failed/）
  task.status = cmdResult.exit_code === 0 ? 'completed' : 'failed';
  await strategy.writeResult(root, task, config.max_inline_bytes);
  await auditLogger.log(makeAuditEntry(task, policyResult, sshTarget, startTime, false));
  logger.info(`[worker] task done: task_id=${task.task_id} status=${task.status} exit_code=${task.exit_code} duration_ms=${Date.now() - startTime}`);
}

/**
 * 构造审计日志条目
 * @param task - 任务结构体（取其 task_id / cmd / exit_code 等字段）
 * @param policyResult - 安全策略校验结果
 * @param sshTarget - 已建立的 SSH 会话 id（无则传 null）
 * @param startTime - 任务开始时间戳（毫秒），用于计算耗时
 * @param cancelled - 任务是否被取消
 * @returns 审计日志条目
 */
function makeAuditEntry(
  task: CommandTask,
  policyResult: PolicyResult,
  sshTarget: string | null,
  startTime: number,
  cancelled: boolean,
): AuditEntry {
  const now = Date.now();
  return {
    task_id: task.task_id,
    cmd_summary: task.cmd.slice(0, 200),
    policy_result: policyResult,
    ssh_target: sshTarget,
    exit_code: task.exit_code,
    duration_ms: now - startTime,
    cancelled,
    timestamp: now,
    system_time: formatSystemTime(now),
  };
}
