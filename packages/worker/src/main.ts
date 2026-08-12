/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : main.ts
 * Author     : MsgFerry
 * Date       : 2026/08/07
 * Version    : 0.0.2
 * Description: Worker 主进程入口——组装模块、主循环、信号处理、优雅退出
 * ======================================================
 */

import { parseConfig, validateConfig } from './config/index.js';
import { ensureSharedTemplates } from './bootstrap.js';
import { createBackoff } from './backoff.js';
import { statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  acquireLock,
  createQueueStrategy,
} from './queue/index.js';
import type { QueueModeStrategy } from './queue/index.js';
import { loadPolicy, createPolicyWatcher } from './policy.js';
import {
  createExecutor,
  createShellSessionFactory,
  SshExecExecutor,
  SshShellExecExecutor,
} from './executor/index.js';
import {
  initSessionsDir,
  listSessions,
  readSessionMeta,
  SessionManager,
} from './session/index.js';
import { AuditLogger } from './audit.js';
import { startHeartbeatLoop, startGcLoop } from './housekeeping.js';
import { processTask } from './task-runner.js';

import { logger } from './log.js';
import { WORKER_CONFIG_FILE, resolveUnderRoot, SessionStatus } from '@smai-kit/msgferry-shared';

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

/**
 * 恢复 exec_mode=shell 时遗留的 running 会话
 * @param root - HGFS 共享根目录
 * @param sessionManager - 会话管理器
 */
async function resumeSessions(root: string, sessionManager: SessionManager): Promise<void> {
  const resume = await listSessions(root);
  for (const sid of resume) {
    const meta = await readSessionMeta(root, sid);
    if (meta && meta.status === SessionStatus.Running) {
      try {
        await sessionManager.open(meta);
      } catch (err) {
        logger.error(`[worker] resume session ${sid} failed: ${(err as Error).message}`);
      }
    }
  }
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
  logger.info(`[worker] exec_mode: ${config.exec_mode}`);
  logger.info(`[worker] audit_log_dir: ${config.audit_log_dir}`);
  logger.info(`[worker] policy_file: ${config.policy_file}`);
  logger.info(`[worker] heartbeat_interval_sec: ${config.heartbeat_interval_sec}`);
  logger.info(`[worker] result_ttl_sec: ${config.result_ttl_sec}`);

  // 队列策略：收敛 shared/exchange 分支（选目录、回写、取消、心跳、GC）
  const strategy: QueueModeStrategy = createQueueStrategy(config.queue_mode);

  // 启动引导：自动补齐共享目录的 config/ 与 policy/ 目录及模板文件（已存在则跳过）
  await ensureSharedTemplates(root);

  // 配置文件变更检测：mtime 变化即预校验新配置并热重启（须在 ensureSharedTemplates 之后）
  startConfigWatcher(root);

  // 按队列模式初始化目录（exchange 额外建 outbound/inbound 信箱）
  await strategy.initDirs(root);

  let policyRule = await loadPolicy(config.policy_file);
  const watcher = createPolicyWatcher(config.policy_file, 10000, (r) => {
    policyRule = r;
  });
  const executor = createExecutor(config);
  const auditLogger = new AuditLogger(config.audit_log_dir);

  // 交互式 shell 会话管理器（仅 exec_mode=shell 时启用）：
  // - 初始化 sessions/ 目录
  // - 启动时恢复遗留的 running 会话
  // - 主循环每轮驱动 tick（注入 stdin、处理关闭/空闲超时）
  let sessionManager: SessionManager | null = null;
  if (config.exec_mode === 'shell') {
    await initSessionsDir(root);
    sessionManager = new SessionManager(root, createShellSessionFactory(config));
    await resumeSessions(root, sessionManager);
  }
  // 会话空闲超时（毫秒）：exec_mode=shell 时以任务超时为基准做保护
  const sessionIdleTimeoutMs = config.exec_mode === 'shell' ? config.result_ttl_sec * 1000 : 0;

  let processedCount = 0;
  const getStats = () => ({ processedCount, queueDepth: 0 });
  const heartbeatLoop = startHeartbeatLoop(root, config.heartbeat_interval_sec, getStats, strategy);
  const gcLoop = startGcLoop(root, config.result_ttl_sec, 60, strategy);

  let shuttingDown = false;
  process.on('SIGINT', () => { shuttingDown = true; });
  process.on('SIGTERM', () => { shuttingDown = true; });

  const backoff = createBackoff(config.polling.initial_interval_ms, config.polling.max_interval_ms);

  // 主循环：任务领取 → 处理 → 消费后清理
  while (!shuttingDown) {
    // 交互式会话驱动（exec_mode=shell）：注入 stdin、处理关闭/空闲超时
    if (sessionManager && sessionManager.size > 0) {
      try {
        await sessionManager.tick(sessionIdleTimeoutMs);
      } catch (err) {
        logger.error(`[worker] session tick error: ${(err as Error).message}`);
      }
    }

    try {
      const tasks = await strategy.listTasks(root);
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
          const task = await strategy.readTask(root, taskId);
          await processTask(config, root, task, process.pid, policyRule, executor, auditLogger, strategy);
          // 消费后清理取消残留（exchange 删除 outbound 取消标记，shared 无操作）
          await strategy.afterConsumed(root, taskId);
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
  // 关闭所有已建立的交互式会话（exec_mode=shell）
  if (sessionManager) {
    await sessionManager.closeAll();
  }
  // 关闭所有已建立的 SSH 会话
  if (executor instanceof SshExecExecutor) {
    await executor.close();
  } else if (executor instanceof SshShellExecExecutor) {
    await executor.close();
  }
  // 退出心跳（策略决定落盘位置）
  await strategy.writeHeartbeat(root, {
    pid: process.pid,
    last_beat: Date.now(),
    processed_count: processedCount,
    queue_depth: 0,
    shutdown_at: Date.now(),
  });
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
