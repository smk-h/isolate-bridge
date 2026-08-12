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
import { statSync } from 'node:fs';
import { spawn } from 'node:child_process';
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
  writeHeartbeatExchange,
  initExchangeDirs,
  listOutbound,
  readOutboundTask,
  writeResultExchange,
  checkCancelledExchange,
  writeCancelledResultExchange,
  removeCancelMarker,
} from './queue.js';
import { loadPolicy, checkCommand, createPolicyWatcher } from './policy.js';
import type { PolicyRule, PolicyResult } from './policy.js';
import { createExecutor } from './executor.js';
import { Ssh2Executor } from './executor.js';
import type { CmdExecutor } from './executor.js';
import { AuditLogger, formatSystemTime } from './audit.js';
import type { AuditEntry } from './audit.js';
import { startHeartbeatLoop, startGcLoop } from './housekeeping.js';

import { logger } from './log.js';
import { WORKER_CONFIG_FILE, resolveUnderRoot } from '@smai-kit/msgferry-shared';
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
  executor: CmdExecutor,
  auditLogger: AuditLogger,
): Promise<void> {
  const startTime = Date.now();
  // 按队列模式流转：exchange 从 outbound/ 领取，shared 从 pending/ 领取
  await transitionToProcessing(root, task, pid, config.queue_mode === 'exchange' ? 'outbound' : 'pending');
  logger.info(`[worker] task processing: task_id=${task.task_id} pid=${pid}`);

  // 安全策略校验
  const policyResult = checkCommand(policyRule, task.cmd);
  if (!policyResult.allowed) {
    task.status = 'failed';
    task.policy_blocked = true;
    task.error_msg = 'blocked_by_policy';
    task.end_time = Date.now();
    // 按队列模式回写：exchange 写 inbound/，shared 写 failed/
    if (config.queue_mode === 'exchange') {
      await writeResultExchange(root, task, config.max_inline_bytes);
    } else {
      await writeResult(root, task, config.max_inline_bytes);
    }
    await auditLogger.log(makeAuditEntry(task, policyResult, null, startTime, false));
    logger.warn(`[worker] task blocked by policy: task_id=${task.task_id} reason=${policyResult.reason} cmd=${task.cmd}`);
    return;
  }
  logger.info(`[worker] policy check passed: task_id=${task.task_id}`);

  // SSH 执行
  logger.info(`[worker] ssh executing: task_id=${task.task_id} timeout_sec=${task.timeout_sec} cmd=${task.cmd}`);
  const cmdResult = await executor.execute(task.cmd, task.timeout_sec, task.device);
  // 取已建立会话 id 作为审计 ssh_target（Ssh2Executor 有，MockExecutor 无）
  const sshTarget = executor instanceof Ssh2Executor
    ? (executor.getSessionId(task.device) ?? null)
    : null;
  logger.info(`[worker] ssh executed: task_id=${task.task_id} exit_code=${cmdResult.exit_code} timed_out=${cmdResult.timed_out}`);
  task.stdout = cmdResult.stdout;
  task.stderr = cmdResult.stderr;
  task.stdout_size = Buffer.byteLength(cmdResult.stdout, 'utf-8');
  task.stderr_size = Buffer.byteLength(cmdResult.stderr, 'utf-8');
  task.exit_code = cmdResult.exit_code;
  task.error_msg = cmdResult.stderr || (cmdResult.timed_out ? 'execution_timeout' : null);
  task.end_time = Date.now();

  // 取消检查与孤儿回收（按队列模式：exchange 查 outbound/cancel_<id>.marker）
  const cancelled = config.queue_mode === 'exchange'
    ? await checkCancelledExchange(root, task.task_id)
    : await checkCancelled(root, task.task_id);
  if (cancelled) {
    task.status = 'cancelled';
    // 按模式回写取消结果：exchange 写 inbound/result_<id>.result
    if (config.queue_mode === 'exchange') {
      await writeCancelledResultExchange(root, task);
    } else {
      await writeCancelledResult(root, task);
    }
    await auditLogger.log(makeAuditEntry(task, policyResult, sshTarget, startTime, true));
    logger.warn(`[worker] task cancelled: task_id=${task.task_id}`);
    return;
  }

  // 正常回写（按队列模式：exchange 写 inbound/，shared 写 completed|failed/）
  task.status = cmdResult.exit_code === 0 ? 'completed' : 'failed';
  if (config.queue_mode === 'exchange') {
    await writeResultExchange(root, task, config.max_inline_bytes);
  } else {
    await writeResult(root, task, config.max_inline_bytes);
  }
  await auditLogger.log(makeAuditEntry(task, policyResult, sshTarget, startTime, false));
  logger.info(`[worker] task done: task_id=${task.task_id} status=${task.status} exit_code=${task.exit_code} duration_ms=${Date.now() - startTime}`);
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

/** 配置文件变更检测间隔（毫秒） */
const CONFIG_WATCH_INTERVAL_MS = 2000;

/**
 * 读取配置文件 mtime（毫秒），文件不存在返回 null
 * @param file - 配置文件的绝对路径
 * @returns 修改时间（毫秒），文件不存在时返回 null
 */
function configMtimeMs(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 重新拉起当前 Worker 进程并退出旧进程，用于配置文件变更后立即生效
 * - 先拉起新进程再退出旧进程，避免 STDOUT/STDERR 与 SSH 会话被同时占用两份
 * - Windows 要点（已实测）：
 *   1) 父进程 process.exit() 会销毁其控制台窗口，连带杀死 stdio:inherit 的
 *      子进程 → 必须 detached:true（新进程独立进程组）
 *   2) 即便 detached，若子进程仍继承控制台句柄（stdio inherit），关闭终端
 *      窗口（CTRL_CLOSE_EVENT 广播到控制台所有附属进程）同样会杀死它
 *      → stdio:'ignore' 让新进程彻底脱离控制台，关闭启动终端也不受影响，
 *        日志改走 --log-save 落盘（新进程继承父进程的 LOG_SAVE/LOG_DIR 环境变量）
 * - 不写 shutdown_at 心跳：新进程数秒内会覆盖为正常心跳，避免短暂被判离线
 * @param cwd - 当前工作目录（透传给新进程）
 * @param argv - 当前进程 argv（新进程沿用相同启动参数）
 */
function restartSelf(cwd: string, argv: string[]): void {
  logger.warn('[worker] config file changed, restarting to apply new config...');
  const child = spawn(process.execPath, argv.slice(1), {
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  child.on('error', (err) => {
    logger.error(`[worker] restart spawn failed: ${err.message}`);
    process.exit(1);
  });
  // 短暂等待新进程接管后退出旧进程
  setTimeout(() => process.exit(0), 800);
}

/**
 * 启动配置文件变更检测：mtime 变化即预校验新配置并热重启
 * - 需在 ensureSharedTemplates 之后再调用，确保 baseline 取的是「已就位」的配置
 * - 新配置解析失败时不重启，仅告警并更新 baseline，避免对非法配置反复告警
 * @param root - HGFS 共享根目录
 */
function startConfigWatcher(root: string): void {
  const configFile = resolveUnderRoot(root, WORKER_CONFIG_FILE);
  let baseline = configMtimeMs(configFile);
  const timer = setInterval(() => {
    const current = configMtimeMs(configFile);
    if (current === null || current === baseline) {
      return;
    }
    baseline = current;
    try {
      parseConfig(process.argv);
    } catch (err) {
      logger.error(`[worker] new config is invalid, keep running: ${(err as Error).message}`);
      return;
    }
    restartSelf(process.cwd(), process.argv);
  }, CONFIG_WATCH_INTERVAL_MS);
  timer.unref?.();
}

/** 主函数占位，下一步追加实现 */
export async function main(): Promise<void> {
  const config = parseConfig(process.argv);
  validateConfig(config);
  const root = config.hgfs_root;
  // 注入业务日志相关环境变量，供共享 Logger 延迟初始化读取（仅 worker 进程内生效，不改 mcp）：
  // - MSGFERRY_LOCAL_ROOT：相对日志目录基于共享根目录解析的基准
  // - LOG_SAVE：业务日志使能开关（来自 --log-save）
  // - LOG_DIR：业务日志目录（来自 --log-dir，默认 <hgfs_root>/logs/worker）
  process.env.MSGFERRY_LOCAL_ROOT = root;
  process.env.LOG_SAVE = config.log_save ? '1' : '0';
  process.env.LOG_DIR = config.log_dir;

  logger.info(`[worker] starting... cwd: ${process.cwd()}`);
  logger.info(`[worker] hgfs_root: ${root}`);
  logger.info(`[worker] queue_mode: ${config.queue_mode}`);
  logger.info(`[worker] executor: ${config.executor_type}`);
  logger.info(`[worker] audit_log_dir: ${config.audit_log_dir}`);
  logger.info(`[worker] policy_file: ${config.policy_file}`);
  logger.info(`[worker] heartbeat_interval_sec: ${config.heartbeat_interval_sec}`);
  logger.info(`[worker] result_ttl_sec: ${config.result_ttl_sec}`);

  // 启动引导：自动补齐共享目录的 config/ 与 policy/ 目录及模板文件（已存在则跳过）
  await ensureSharedTemplates(root);

  // 配置文件变更检测：mtime 变化即预校验新配置并热重启（须在 ensureSharedTemplates 之后）
  startConfigWatcher(root);

  await initQueueDirs(root);
  // exchange 模式额外初始化 outbound/inbound 单向信箱目录
  if (config.queue_mode === 'exchange') {
    await initExchangeDirs(root);
  }
  let policyRule = await loadPolicy(config.policy_file);
  const watcher = createPolicyWatcher(config.policy_file, 10000, (r) => {
    policyRule = r;
  });
  const executor = createExecutor(config);
  const auditLogger = new AuditLogger(config.audit_log_dir);

  let processedCount = 0;
  const getStats = () => ({ processedCount, queueDepth: 0 });
  const heartbeatLoop = startHeartbeatLoop(root, config.heartbeat_interval_sec, getStats, config.queue_mode);
  const gcLoop = startGcLoop(root, config.result_ttl_sec, 60, config.queue_mode);

  let shuttingDown = false;
  process.on('SIGINT', () => { shuttingDown = true; });
  process.on('SIGTERM', () => { shuttingDown = true; });

  const backoff = createBackoff(config.polling.initial_interval_ms, config.polling.max_interval_ms);

  // 主循环：按队列模式分支（shared=扫 pending/，exchange=扫 outbound/）
  while (!shuttingDown) {
    try {
      const tasks = config.queue_mode === 'exchange'
        ? await listOutbound(root)
        : await listPending(root);
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
          logger.info(`[worker] task acquired: task_id=${taskId}`);
          // 按模式读取任务：exchange 读 outbound/，shared 读 pending/
          const task = config.queue_mode === 'exchange'
            ? await readOutboundTask(root, taskId)
            : await readTask(root, taskId);
          await processTask(config, root, task, process.pid, policyRule, executor, auditLogger);
          // exchange 模式：任务消费后清理其取消标记（避免残留被下次整目录同步再看到）
          if (config.queue_mode === 'exchange') {
            await removeCancelMarker(root, taskId);
          }
          processedCount++;
        } catch (err) {
          logger.error(`[worker] task ${taskId} failed:`, err);
        }
      }
    } catch (err) {
      logger.error('[worker] loop error:', err);
      await sleep(backoff.next());
    }
  }

  // 优雅退出
  logger.info(`[worker] shutting down... processed=${processedCount}`);
  await heartbeatLoop.stop();
  await gcLoop.stop();
  watcher.stop();
  // 关闭所有已建立的 SSH 会话（仅 Ssh2Executor 有 close 能力）
  if (executor instanceof Ssh2Executor) {
    await executor.close();
  }
  await writeHeartbeat(root, {
    pid: process.pid,
    last_beat: Date.now(),
    processed_count: processedCount,
    queue_depth: 0,
    shutdown_at: Date.now(),
  });
  // exchange 模式：退出心跳也落一份到 inbound/
  if (config.queue_mode === 'exchange') {
    await writeHeartbeatExchange(root, {
      pid: process.pid,
      last_beat: Date.now(),
      processed_count: processedCount,
      queue_depth: 0,
      shutdown_at: Date.now(),
    });
  }
  await auditLogger.flush();
  await auditLogger.close();
  logger.info('[worker] shutdown complete');
  process.exit(0);
}

/** 延时工具 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 作为主模块运行时自动调用 main
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    logger.error('[worker] fatal:', err);
    process.exit(1);
  });
}
