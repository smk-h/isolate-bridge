/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : shared.ts
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: 共享目录队列模式（shared）——pending/ processing/ completed/
 *              failed/ cancelled/ outputs/ 目录操作
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
  taskFileName,
  taskFileBaseName,
  parseTaskIdFromFileName,
  formatBeijingTimestamp,
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

/**
 * 初始化 HGFS 共享根目录下的全部共享队列子目录
 * @param root - HGFS 共享根目录绝对路径
 */
export async function initQueueDirs(root: string): Promise<void> {
  const dirs = Object.values(QUEUE_DIRS);
  for (const dir of dirs) {
    await mkdir(join(root, dir), { recursive: true });
  }
}

/**
 * 在指定目录中按完整 task_id 匹配任务文件名
 * 由于任务文件名只保留 task_id 前 8 位，读取时需扫描目录并校验内容中的完整 task_id。
 * @param root - HGFS 共享根目录
 * @param dir - 队列目录名
 * @param taskId - 完整任务唯一标识
 * @param suffix - 文件后缀（如 .json / .result）
 * @returns 匹配的文件完整路径，未找到返回 null
 */
async function findTaskFileByTaskId(
  root: string,
  dir: string,
  taskId: string,
  suffix: string = JSON_SUFFIX,
): Promise<string | null> {
  const fullDir = join(root, dir);
  let entries: string[];
  try {
    entries = await readdir(fullDir);
  } catch {
    return null;
  }
  const shortId = taskId.slice(0, 8).toUpperCase();
  for (const name of entries) {
    if (!name.endsWith(suffix) || name.endsWith(TMP_SUFFIX)) {
      continue;
    }
    // 文件名时间段后的 uuid 前 8 位必须匹配，再读内容校验完整 task_id
    if (parseTaskIdFromFileName(name).toUpperCase() !== shortId) {
      continue;
    }
    try {
      const content = await readFile(join(fullDir, name), 'utf-8');
      const parsed = JSON.parse(content) as { task_id?: string };
      if (parsed.task_id === taskId) {
        return join(fullDir, name);
      }
    } catch {
      // 单个文件解析失败跳过，继续下一个
    }
  }
  return null;
}

/**
 * 列出 pending/ 目录下的待执行任务（返回完整 task_id，过滤 .tmp 文件）
 * @param root - HGFS 共享根目录
 * @returns task_id 列表（完整 UUID）
 */
export async function listPending(root: string): Promise<string[]> {
  const pendingDir = join(root, QUEUE_DIRS.pending);
  let entries: string[];
  try {
    entries = await readdir(pendingDir);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(JSON_SUFFIX) || name.endsWith(TMP_SUFFIX)) {
      continue;
    }
    try {
      const content = await readFile(join(pendingDir, name), 'utf-8');
      const parsed = JSON.parse(content) as { task_id?: string };
      if (parsed.task_id) {
        ids.push(parsed.task_id);
      }
    } catch {
      // 单个文件解析失败跳过，继续下一个
    }
  }
  return ids;
}

/**
 * 从 pending/ 读取任务 JSON
 * @param root - HGFS 共享根目录
 * @param taskId - 任务唯一标识
 * @returns 任务结构体
 */
export async function readTask(root: string, taskId: string): Promise<CommandTask> {
  const filePath = await findTaskFileByTaskId(root, QUEUE_DIRS.pending, taskId);
  if (filePath === null) {
    throw new Error(`task not found in pending: ${taskId}`);
  }
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
  task.start_time = formatBeijingTimestamp(Date.now());

  const processingPath = join(root, QUEUE_DIRS.processing, taskFileName(task.submit_time, task.task_id));
  const tmpPath = `${processingPath}${TMP_SUFFIX}`;
  await writeFile(tmpPath, JSON.stringify(task), 'utf-8');
  await rename(tmpPath, processingPath);

  // 删除源任务文件：shared 从 pending/，exchange 从 outbound/
  const sourceDirName = sourceDir === 'outbound' ? 'outbound' : QUEUE_DIRS.pending;
  const sourcePath = join(root, sourceDirName, taskFileName(task.submit_time, task.task_id));
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
  task: CommandTask,
): Promise<{ stdoutPath: string; stderrPath: string }> {
  // 相对路径统一用 posix 分隔符，确保 Windows 写入的路径可被 Linux 侧读取
  const base = taskFileBaseName(task.submit_time, task.task_id);
  const stdoutPath = `${QUEUE_DIRS.outputs}/${base}.stdout`;
  const stderrPath = `${QUEUE_DIRS.outputs}/${base}.stderr`;
  const stdoutFull = join(root, stdoutPath);
  const stderrFull = join(root, stderrPath);

  // stdout 分包：先写临时文件再 rename，保证原子性（读者不会读到半成品）
  const stdoutTmp = `${stdoutFull}${TMP_SUFFIX}`;
  await writeFile(stdoutTmp, task.stdout, 'utf-8');
  await rename(stdoutTmp, stdoutFull);

  // stderr 分包：同样原子写入
  const stderrTmp = `${stderrFull}${TMP_SUFFIX}`;
  await writeFile(stderrTmp, task.stderr, 'utf-8');
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
      task,
    );
    task.truncated = true;
    task.stdout_overflow_path = stdoutPath;
    task.stderr_overflow_path = stderrPath;
    task.stdout = task.stdout.slice(0, maxInline);
    task.stderr = task.stderr.slice(0, maxInline);
  }

  const targetDir = task.status === 'completed' ? QUEUE_DIRS.completed : QUEUE_DIRS.failed;
  const targetPath = join(root, targetDir, taskFileName(task.submit_time, task.task_id));
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
 * 回写取消结果到 cancelled/ 下（文件名带任务时间戳，后缀 .result）
 * @param root - HGFS 共享根目录
 * @param task - 任务结构体
 */
export async function writeCancelledResult(
  root: string,
  task: CommandTask,
): Promise<void> {
  const resultPath = join(root, QUEUE_DIRS.cancelled, `${taskFileBaseName(task.submit_time, task.task_id)}${CANCELLED_RESULT_SUFFIX}`);
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

/**
 * 释放已消费任务的 processing 记录：删除处理锁与 processing json
 * 任务无论成功/失败/取消，终态回写完成后调用，避免 processing/ 无限累积；
 * 删除采用幂等（不存在即忽略），可安全重复调用。
 * @param root - HGFS 共享根目录
 * @param taskId - 任务唯一标识
 */
export async function releaseProcessing(root: string, taskId: string): Promise<void> {
  const lockPath = join(root, QUEUE_DIRS.processing, `${taskId}${LOCK_SUFFIX}`);
  const jsonPath = await findTaskFileByTaskId(root, QUEUE_DIRS.processing, taskId);
  await unlink(lockPath).catch(() => {});
  if (jsonPath) {
    await unlink(jsonPath).catch(() => {});
  }
}

/**
 * 清理 processing/ 下超保留期的孤儿锁定与任务记录（崩溃残留兜底）
 * 正常完成的 worker 会主动删除 processing 记录，此处仅处理进程崩溃后遗留
 * 的锁：超龄锁会永久阻塞该任务重入（acquireLock 遇 EEXIST 跳过），据此判龄回收。
 * @param root - HGFS 共享根目录
 * @param ttlSec - 保留期（秒）
 * @returns 清理的任务数
 */
export async function gcProcessing(root: string, ttlSec: number): Promise<number> {
  const processingDir = join(root, QUEUE_DIRS.processing);
  const now = Date.now();
  const ttlMs = ttlSec * 1000;
  let cleaned = 0;
  let entries: string[];
  try {
    entries = await readdir(processingDir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.endsWith(LOCK_SUFFIX)) {
      continue;
    }
    const lockPath = join(processingDir, name);
    try {
      const fileStat = await stat(lockPath);
      if (now - fileStat.mtimeMs <= ttlMs) {
        continue;
      }
      // 超龄锁：连同同 id 的处理记录一并删除（lock 用完整 task_id 命名，json 用带时间戳命名需扫描匹配）
      const taskId = name.slice(0, -LOCK_SUFFIX.length);
      const jsonPath = await findTaskFileByTaskId(root, QUEUE_DIRS.processing, taskId);
      await unlink(lockPath);
      if (jsonPath) {
        await unlink(jsonPath).catch(() => {});
      }
      cleaned++;
    } catch {
      // 单文件清理失败忽略，继续下一个
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
  // 分别扫描 completed/ 与 failed/ 两个结果目录
  const dirs = [QUEUE_DIRS.completed, QUEUE_DIRS.failed];
  for (const dir of dirs) {
    const fullDir = join(root, dir);
    let entries: string[];
    try {
      entries = await readdir(fullDir);
    } catch {
      // 目录不存在/不可读时跳过该目录
      continue;
    }
    for (const name of entries) {
      const filePath = join(fullDir, name);
      try {
        // 超保留期的结果文件直接删除
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
