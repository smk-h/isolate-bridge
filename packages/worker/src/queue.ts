/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : queue.ts
 * Author     : MsgFerry
 * Date       : 2026/08/07
 * Version    : 0.0.1
 * Description: HGFS 队列文件操作封装——原子提交、锁抢占、轮询、结果回写、大输出分流
 * ======================================================
 */

import { join } from 'node:path';
import {
  open,
  readFile,
  writeFile,
  readdir,
  mkdir,
  unlink,
  stat,
  rename,
} from 'node:fs/promises';

import {
  QUEUE_DIRS,
  HEARTBEAT_FILE,
  EXCHANGE_DIRS,
} from '@smai-kit/msgferry-shared';
import type { CommandTask } from '@smai-kit/msgferry-shared';

/** 锁文件内容 */
export interface LockFile {
  worker_pid: number;
  lock_time: number;  // ms epoch
}

/** 心跳内容 */
export interface Heartbeat {
  pid: number;
  last_beat: number;
  processed_count: number;
  queue_depth: number;
  shutdown_at: number | null;
}

const TMP_SUFFIX = '.tmp';
const JSON_SUFFIX = '.json';
const LOCK_SUFFIX = '.lock';
const CANCELLED_RESULT_SUFFIX = '.result';
const CANCEL_MARKER_SUFFIX = '.marker';
const EXCHANGE_RESULT_PREFIX = 'result_';

/**
 * 初始化 HGFS 共享根目录下的全部队列子目录
 * @param root - HGFS 共享根目录绝对路径
 */
export async function initQueueDirs(root: string): Promise<void> {
  const dirs = Object.values(QUEUE_DIRS);
  for (const dir of dirs) {
    await mkdir(join(root, dir), { recursive: true });
  }
}

/**
 * 列出 pending/ 目录下的待执行任务 ID（过滤 .tmp 文件）
 * @param root - HGFS 共享根目录
 * @returns task_id 列表（不含 .json 后缀）
 */
export async function listPending(root: string): Promise<string[]> {
  const pendingDir = join(root, QUEUE_DIRS.pending);
  const entries = await readdir(pendingDir);
  return entries
    .filter((name) => name.endsWith(JSON_SUFFIX))
    .map((name) => name.slice(0, -JSON_SUFFIX.length));
}

/**
 * 从 pending/ 读取任务 JSON
 * @param root - HGFS 共享根目录
 * @param taskId - 任务唯一标识
 * @returns 任务结构体
 */
export async function readTask(root: string, taskId: string): Promise<CommandTask> {
  const filePath = join(root, QUEUE_DIRS.pending, `${taskId}${JSON_SUFFIX}`);
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as CommandTask;
}

/**
 * 原子抢占任务锁（O_CREAT|O_EXCL 等价）
 * @param root - HGFS 共享根目录
 * @param taskId - 任务唯一标识
 * @param pid - Worker 进程 PID
 * @returns 抢占成功返回 true，已被其他 Worker 抢占返回 false
 */
export async function acquireLock(root: string, taskId: string, pid: number): Promise<boolean> {
  const lockPath = join(root, QUEUE_DIRS.processing, `${taskId}${LOCK_SUFFIX}`);
  const lockContent: LockFile = { worker_pid: pid, lock_time: Date.now() };
  let fd;
  try {
    fd = await open(lockPath, 'wx');
    await fd.writeFile(JSON.stringify(lockContent), 'utf-8');
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      return false;
    }
    throw err;
  } finally {
    if (fd) {
      await fd.close();
    }
  }
}

/**
 * 任务状态流转到 processing
 * @param root - HGFS 共享根目录
 * @param task - 任务结构体（原地修改 status/worker_pid/start_time）
 * @param pid - Worker 进程 PID
 * @param sourceDir - 源任务文件所在目录：shared 用 pending，exchange 用 outbound
 */
export async function transitionToProcessing(
  root: string,
  task: CommandTask,
  pid: number,
  sourceDir: 'pending' | 'outbound' = 'pending',
): Promise<void> {
  task.status = 'processing';
  task.worker_pid = pid;
  task.start_time = Date.now();

  const processingPath = join(root, QUEUE_DIRS.processing, `${task.task_id}${JSON_SUFFIX}`);
  const tmpPath = `${processingPath}${TMP_SUFFIX}`;
  await writeFile(tmpPath, JSON.stringify(task), 'utf-8');
  await rename(tmpPath, processingPath);

  // 删除源任务文件：shared 从 pending/，exchange 从 outbound/
  const sourceDirName = sourceDir === 'outbound' ? EXCHANGE_DIRS.outbound : QUEUE_DIRS.pending;
  const sourcePath = join(root, sourceDirName, `${task.task_id}${JSON_SUFFIX}`);
  await unlink(sourcePath).catch(() => {
    // 删除失败忽略：可能已被其他流程清理
  });
}

/**
 * 将大输出写入 outputs/ 分包文件
 * @param root - HGFS 共享根目录
 * @param taskId - 任务唯一标识
 * @param stdout - stdout 全文
 * @param stderr - stderr 全文
 * @returns 分包文件相对路径
 */
export async function writeOverflowOutput(
  root: string,
  taskId: string,
  stdout: string,
  stderr: string,
): Promise<{ stdoutPath: string; stderrPath: string }> {
  // 相对路径统一用 posix 分隔符，确保 Windows 写入的路径可被 Linux 侧读取
  const stdoutPath = `${QUEUE_DIRS.outputs}/${taskId}.stdout`;
  const stderrPath = `${QUEUE_DIRS.outputs}/${taskId}.stderr`;
  const stdoutFull = join(root, stdoutPath);
  const stderrFull = join(root, stderrPath);

  const stdoutTmp = `${stdoutFull}${TMP_SUFFIX}`;
  await writeFile(stdoutTmp, stdout, 'utf-8');
  await rename(stdoutTmp, stdoutFull);

  const stderrTmp = `${stderrFull}${TMP_SUFFIX}`;
  await writeFile(stderrTmp, stderr, 'utf-8');
  await rename(stderrTmp, stderrFull);

  return { stdoutPath, stderrPath };
}

/**
 * 回写任务结果：大输出分流 + 原子写入 completed/ 或 failed/
 * @param root - HGFS 共享根目录
 * @param task - 任务结构体
 * @param maxInline - 内联字节数上限
 */
export async function writeResult(
  root: string,
  task: CommandTask,
  maxInline: number,
): Promise<void> {
  if (task.stdout_size > maxInline) {
    const { stdoutPath, stderrPath } = await writeOverflowOutput(
      root,
      task.task_id,
      task.stdout,
      task.stderr,
    );
    task.truncated = true;
    task.stdout_overflow_path = stdoutPath;
    task.stderr_overflow_path = stderrPath;
    task.stdout = task.stdout.slice(0, maxInline);
    task.stderr = task.stderr.slice(0, maxInline);
  }

  const targetDir = task.status === 'completed' ? QUEUE_DIRS.completed : QUEUE_DIRS.failed;
  const targetPath = join(root, targetDir, `${task.task_id}${JSON_SUFFIX}`);
  const tmpPath = `${targetPath}${TMP_SUFFIX}`;
  await writeFile(tmpPath, JSON.stringify(task), 'utf-8');
  await rename(tmpPath, targetPath);
}

/**
 * 检查 cancelled/<taskId> 取消标记是否存在
 * @param root - HGFS 共享根目录
 * @param taskId - 任务唯一标识
 * @returns 存在返回 true
 */
export async function checkCancelled(root: string, taskId: string): Promise<boolean> {
  try {
    const cancelPath = join(root, QUEUE_DIRS.cancelled, taskId);
    await stat(cancelPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 回写取消结果到 cancelled/<taskId>.result
 * @param root - HGFS 共享根目录
 * @param task - 任务结构体
 */
export async function writeCancelledResult(
  root: string,
  task: CommandTask,
): Promise<void> {
  const resultPath = join(root, QUEUE_DIRS.cancelled, `${task.task_id}${CANCELLED_RESULT_SUFFIX}`);
  const tmpPath = `${resultPath}${TMP_SUFFIX}`;
  await writeFile(tmpPath, JSON.stringify(task), 'utf-8');
  await rename(tmpPath, resultPath);
}

/**
 * 原子写入心跳文件
 * @param root - HGFS 共享根目录
 * @param hb - 心跳内容
 */
export async function writeHeartbeat(root: string, hb: Heartbeat): Promise<void> {
  const hbPath = join(root, HEARTBEAT_FILE);
  const tmpPath = `${hbPath}${TMP_SUFFIX}`;
  await writeFile(tmpPath, JSON.stringify(hb), 'utf-8');
  await rename(tmpPath, hbPath);
}

/**
 * 读取心跳文件
 * @param root - HGFS 共享根目录
 * @returns 心跳内容，文件不存在返回 null
 */
export async function readHeartbeat(root: string): Promise<Heartbeat | null> {
  try {
    const hbPath = join(root, HEARTBEAT_FILE);
    const content = await readFile(hbPath, 'utf-8');
    return JSON.parse(content) as Heartbeat;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// 文件交换服务器模式（exchange）：单向信箱目录操作
// outbound/ 内网只写（worker 只读），inbound/ worker 只写（内网只读）
// ────────────────────────────────────────────────────────────────

/**
 * 初始化交换模式的单向信箱目录：outbound/ 与 inbound/
 * @param root - HGFS 共享根目录绝对路径
 */
export async function initExchangeDirs(root: string): Promise<void> {
  await mkdir(join(root, EXCHANGE_DIRS.outbound), { recursive: true });
  await mkdir(join(root, EXCHANGE_DIRS.inbound), { recursive: true });
}

/**
 * 列出 outbound/ 目录下的待执行任务 ID（仅 .json，过滤 .tmp 半成品与取消标记）
 * @param root - HGFS 共享根目录
 * @returns task_id 列表（不含 .json 后缀）
 */
export async function listOutbound(root: string): Promise<string[]> {
  const outboundDir = join(root, EXCHANGE_DIRS.outbound);
  let entries: string[];
  try {
    entries = await readdir(outboundDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(JSON_SUFFIX))
    .map((name) => name.slice(0, -JSON_SUFFIX.length));
}

/**
 * 从 outbound/ 读取任务 JSON
 * @param root - HGFS 共享根目录
 * @param taskId - 任务唯一标识
 * @returns 任务结构体
 */
export async function readOutboundTask(root: string, taskId: string): Promise<CommandTask> {
  const filePath = join(root, EXCHANGE_DIRS.outbound, `${taskId}${JSON_SUFFIX}`);
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as CommandTask;
}

/**
 * 回写任务结果到 inbound/（大输出分流 + 原子写 result_<id>.json）
 * exchange 模式下大输出随结果同目录（<id>.stdout / <id>.stderr），不写 outputs/
 * @param root - HGFS 共享根目录
 * @param task - 任务结构体
 * @param maxInline - 内联字节数上限
 * @param resultDir - 回写目录（inbound/ 或共享结果目录），默认 inbound
 */
export async function writeResultExchange(
  root: string,
  task: CommandTask,
  maxInline: number,
): Promise<void> {
  if (task.stdout_size > maxInline) {
    await writeInboundOverflow(root, task.task_id, task.stdout, task.stderr);
    task.truncated = true;
    task.stdout_overflow_path = `${EXCHANGE_DIRS.inbound}/${task.task_id}.stdout`;
    task.stderr_overflow_path = `${EXCHANGE_DIRS.inbound}/${task.task_id}.stderr`;
    task.stdout = task.stdout.slice(0, maxInline);
    task.stderr = task.stderr.slice(0, maxInline);
  }

  const targetPath = join(root, EXCHANGE_DIRS.inbound, `${EXCHANGE_RESULT_PREFIX}${task.task_id}${JSON_SUFFIX}`);
  const tmpPath = `${targetPath}${TMP_SUFFIX}`;
  await writeFile(tmpPath, JSON.stringify(task), 'utf-8');
  await rename(tmpPath, targetPath);
}

/**
 * 将大输出写入 inbound/ 分包文件（随结果批次同目录，内网 -g 整目录拉回）
 * @param root - HGFS 共享根目录
 * @param taskId - 任务唯一标识
 * @param stdout - stdout 全文
 * @param stderr - stderr 全文
 */
async function writeInboundOverflow(
  root: string,
  taskId: string,
  stdout: string,
  stderr: string,
): Promise<void> {
  const stdoutFull = join(root, EXCHANGE_DIRS.inbound, `${taskId}.stdout`);
  const stderrFull = join(root, EXCHANGE_DIRS.inbound, `${taskId}.stderr`);

  const stdoutTmp = `${stdoutFull}${TMP_SUFFIX}`;
  await writeFile(stdoutTmp, stdout, 'utf-8');
  await rename(stdoutTmp, stdoutFull);

  const stderrTmp = `${stderrFull}${TMP_SUFFIX}`;
  await writeFile(stderrTmp, stderr, 'utf-8');
  await rename(stderrTmp, stderrFull);
}

/**
 * 回写取消结果到 inbound/result_<id>.result
 * @param root - HGFS 共享根目录
 * @param task - 任务结构体
 */
export async function writeCancelledResultExchange(
  root: string,
  task: CommandTask,
): Promise<void> {
  const resultPath = join(root, EXCHANGE_DIRS.inbound, `${EXCHANGE_RESULT_PREFIX}${task.task_id}${CANCELLED_RESULT_SUFFIX}`);
  const tmpPath = `${resultPath}${TMP_SUFFIX}`;
  await writeFile(tmpPath, JSON.stringify(task), 'utf-8');
  await rename(tmpPath, resultPath);
}

/**
 * 检查 outbound/cancel_<id>.marker 取消标记是否存在（exchange 模式）
 * @param root - HGFS 共享根目录
 * @param taskId - 任务唯一标识
 * @returns 存在返回 true
 */
export async function checkCancelledExchange(root: string, taskId: string): Promise<boolean> {
  try {
    const markerPath = join(root, EXCHANGE_DIRS.outbound, `cancel_${taskId}${CANCEL_MARKER_SUFFIX}`);
    await stat(markerPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 原子写心跳到 inbound/heartbeat.json（exchange 模式额外落一份，随结果批次被 -g 拉回）
 * @param root - HGFS 共享根目录
 * @param hb - 心跳内容
 */
export async function writeHeartbeatExchange(root: string, hb: Heartbeat): Promise<void> {
  const hbPath = join(root, EXCHANGE_DIRS.inbound, HEARTBEAT_FILE);
  const tmpPath = `${hbPath}${TMP_SUFFIX}`;
  await writeFile(tmpPath, JSON.stringify(hb), 'utf-8');
  await rename(tmpPath, hbPath);
}

/**
 * 清理 outbound/ 中已被领取（任务文件已消失）的孤立取消标记
 * 由 worker 在消费到对应任务后顺手删除，避免下次整目录 pull 时被内网再次看到
 * @param root - HGFS 共享根目录
 * @param taskId - 任务唯一标识
 */
export async function removeCancelMarker(root: string, taskId: string): Promise<void> {
  const markerPath = join(root, EXCHANGE_DIRS.outbound, `cancel_${taskId}${CANCEL_MARKER_SUFFIX}`);
  await unlink(markerPath).catch(() => {
    // 标记不存在时忽略（幂等）
  });
}

/**
 * 清理 inbound/ 下超过保留期的结果文件（含大输出分包与心跳不清理）
 * @param root - HGFS 共享根目录
 * @param ttlSec - 保留期（秒）
 * @returns 清理的文件数
 */
export async function gcInboundResults(root: string, ttlSec: number): Promise<number> {
  const inboundDir = join(root, EXCHANGE_DIRS.inbound);
  const now = Date.now();
  const ttlMs = ttlSec * 1000;
  let cleaned = 0;
  let entries: string[];
  try {
    entries = await readdir(inboundDir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (name.endsWith(TMP_SUFFIX)) {
      continue;
    }
    // 心跳文件不参与结果 GC（内网健康检查依赖它）
    if (name === HEARTBEAT_FILE) {
      continue;
    }
    const filePath = join(inboundDir, name);
    try {
      const fileStat = await stat(filePath);
      if (now - fileStat.mtimeMs > ttlMs) {
        await unlink(filePath);
        cleaned++;
      }
    } catch {
      // 单文件清理失败忽略
    }
  }
  return cleaned;
}

/**
 * 清理 completed/ 与 failed/ 下超过保留期的结果文件
 * @param root - HGFS 共享根目录
 * @param ttlSec - 保留期（秒）
 * @returns 清理的文件数
 */
export async function gcResults(root: string, ttlSec: number): Promise<number> {
  const now = Date.now();
  const ttlMs = ttlSec * 1000;
  let cleaned = 0;
  const dirs = [QUEUE_DIRS.completed, QUEUE_DIRS.failed];
  for (const dir of dirs) {
    const fullDir = join(root, dir);
    let entries: string[];
    try {
      entries = await readdir(fullDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const filePath = join(fullDir, name);
      try {
        const fileStat = await stat(filePath);
        if (now - fileStat.mtimeMs > ttlMs) {
          await unlink(filePath);
          cleaned++;
        }
      } catch {
        // 单文件清理失败忽略，继续下一个
      }
    }
  }
  return cleaned;
}
