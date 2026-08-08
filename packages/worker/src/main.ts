/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : main.ts
 * Author     : MsgFerry
 * Date       : 2026/08/07
 * Version    : 0.0.1
 * Description: Worker 主进程入口——组装模块、主循环、信号处理、优雅退出
 * ======================================================
 */

import { parseConfig, validateConfig } from './config.js';
import type { WorkerConfig } from './config.js';
import { ensureSharedTemplates } from './bootstrap.js';
import { createBackoff } from './backoff.js';
import { pathToFileURL } from 'node:url';
import {
  initQueueDirs,
  listPending,
  readTask,
  acquireLock,
  transitionToProcessing,
  writeResult,
  checkCancelled,
  writeCancelledResult,
  writeHeartbeat,
} from './queue.js';
import { loadPolicy, checkCommand, createPolicyWatcher } from './policy.js';
import type { PolicyRule, PolicyResult } from './policy.js';
import { createExecutor } from './executor.js';
import type { SshExecutor } from './executor.js';
import { AuditLogger, formatSystemTime } from './audit.js';
import type { AuditEntry } from './audit.js';
import { startHeartbeatLoop, startGcLoop } from './housekeeping.js';

import type { CommandTask } from '@smai-kit/msgferry-shared';

/**
 * 处理单个任务：抢占 → 策略校验 → SSH 执行 → 取消检查 → 回写
 * @param config - Worker 配置
 * @param root - HGFS 共享根目录
 * @param task - 任务结构体（会被原地修改）
 * @param pid - Worker 进程 PID
 * @param policyRule - 安全策略规则
 * @param executor - SSH 执行器
 * @param auditLogger - 审计日志器
 */
async function processTask(
  config: WorkerConfig,
  root: string,
  task: CommandTask,
  pid: number,
  policyRule: PolicyRule,
  executor: SshExecutor,
  auditLogger: AuditLogger,
): Promise<void> {
  const startTime = Date.now();
  await transitionToProcessing(root, task, pid);

  // 安全策略校验
  const policyResult = checkCommand(policyRule, task.cmd);
  if (!policyResult.allowed) {
    task.status = 'failed';
    task.policy_blocked = true;
    task.error_msg = 'blocked_by_policy';
    task.end_time = Date.now();
    await writeResult(root, task, config.max_inline_bytes);
    await auditLogger.log(makeAuditEntry(task, policyResult, null, startTime, false));
    return;
  }

  // SSH 执行
  const sshResult = await executor.execute(task.cmd, task.timeout_sec);
  task.stdout = sshResult.stdout;
  task.stderr = sshResult.stderr;
  task.stdout_size = Buffer.byteLength(sshResult.stdout, 'utf-8');
  task.stderr_size = Buffer.byteLength(sshResult.stderr, 'utf-8');
  task.exit_code = sshResult.exit_code;
  task.error_msg = sshResult.stderr || (sshResult.timed_out ? 'execution_timeout' : null);
  task.end_time = Date.now();

  // 取消检查与孤儿回收
  const cancelled = await checkCancelled(root, task.task_id);
  if (cancelled) {
    task.status = 'cancelled';
    await writeCancelledResult(root, task);
    await auditLogger.log(makeAuditEntry(task, policyResult, null, startTime, true));
    return;
  }

  // 正常回写
  task.status = sshResult.exit_code === 0 ? 'completed' : 'failed';
  await writeResult(root, task, config.max_inline_bytes);
  await auditLogger.log(makeAuditEntry(task, policyResult, null, startTime, false));
}

/**
 * 构造审计日志条目
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

/** 主函数占位，下一步追加实现 */
export async function main(): Promise<void> {
  const config = parseConfig(process.argv, process.env);
  validateConfig(config);
  const root = config.hgfs_root;

  // 启动引导：自动补齐共享目录的 config/ 与 policy/ 目录及模板文件（已存在则跳过）
  await ensureSharedTemplates(root);

  await initQueueDirs(root);
  let policyRule = await loadPolicy(config.policy_file);
  const watcher = createPolicyWatcher(config.policy_file, 10000, (r) => {
    policyRule = r;
  });
  const executor = createExecutor(config);
  const auditLogger = new AuditLogger(config.audit_log_dir);

  let processedCount = 0;
  const getStats = () => ({ processedCount, queueDepth: 0 });
  const heartbeatLoop = startHeartbeatLoop(root, config.heartbeat_interval_sec, getStats);
  const gcLoop = startGcLoop(root, config.result_ttl_sec, 60);

  let shuttingDown = false;
  process.on('SIGINT', () => { shuttingDown = true; });
  process.on('SIGTERM', () => { shuttingDown = true; });

  const backoff = createBackoff(config.polling.initial_interval_ms, config.polling.max_interval_ms);

  // 主循环
  while (!shuttingDown) {
    try {
      const tasks = await listPending(root);
      if (tasks.length === 0) {
        await sleep(backoff.next());
        continue;
      }
      backoff.reset();

      for (const taskId of tasks) {
        if (shuttingDown) {
          break;
        }
        try {
          const locked = await acquireLock(root, taskId, process.pid);
          if (!locked) {
            continue;
          }
          const task = await readTask(root, taskId);
          await processTask(config, root, task, process.pid, policyRule, executor, auditLogger);
          processedCount++;
        } catch (err) {
          console.error(`[main] task ${taskId} failed:`, err);
        }
      }
    } catch (err) {
      console.error('[main] loop error:', err);
      await sleep(backoff.next());
    }
  }

  // 优雅退出
  await heartbeatLoop.stop();
  await gcLoop.stop();
  watcher.stop();
  await writeHeartbeat(root, {
    pid: process.pid,
    last_beat: Date.now(),
    processed_count: processedCount,
    queue_depth: 0,
    shutdown_at: Date.now(),
  });
  await auditLogger.flush();
  await auditLogger.close();
  process.exit(0);
}

/** 延时工具 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 作为主模块运行时自动调用 main
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[main] fatal:', err);
    process.exit(1);
  });
}
