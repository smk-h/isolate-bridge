/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : queue.ts
 * Author     : MsgFerry
 * Date       : 2026/08/08
 * Version    : 0.0.1
 * Description: 内网侧 HGFS 队列文件操作封装——原子提交、存在性检查、结果读取、取消标记、心跳读取、大输出读取
 * ======================================================
 */

import { join } from 'node:path';
import {
  writeFile,
  readFile,
  mkdir,
  stat,
  rename,
  readdir,
  unlink,
} from 'node:fs/promises';

import { QUEUE_DIRS, HEARTBEAT_FILE, EXCHANGE_DIRS, taskFileName, parseTaskIdFromFileName } from '@smai-kit/msgferry-shared';
import type { CommandTask } from '@smai-kit/msgferry-shared';

/** 心跳内容（与 worker 同构，mcp-server 不依赖 worker 包） */
export interface Heartbeat {
  pid: number;
  last_beat: number;                  // ms epoch
  processed_count: number;
  queue_depth: number;
  shutdown_at: number | null;         // Worker 优雅退出时写入
}

const TMP_SUFFIX = '.tmp';
const JSON_SUFFIX = '.json';
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
 * 原子提交任务到 pending/ 目录（.tmp → rename）
 * @param root - HGFS 共享根目录
 * @param task - 任务结构体
 */
export async function submitTask(root: string, task: CommandTask): Promise<void> {
  const targetPath = join(root, QUEUE_DIRS.pending, taskFileName(task.submit_time, task.task_id));
  const tmpPath = `${targetPath}${TMP_SUFFIX}`;
  await writeFile(tmpPath, JSON.stringify(task), 'utf-8');
  await rename(tmpPath, targetPath);
}

/**
 * 检查任务是否已存在于 pending/ 或 processing/
 * @param root - HGFS 共享根目录
 * @param taskId - 任务唯一标识
 * @returns 存在返回 'pending' 或 'processing'，不存在返回 null
 */
export async function taskExists(
  root: string,
  taskId: string,
): Promise<'pending' | 'processing' | null> {
  if (await findTaskFileByTaskId(root, QUEUE_DIRS.pending, taskId)) {
    return 'pending';
  }
  if (await findTaskFileByTaskId(root, QUEUE_DIRS.processing, taskId)) {
    return 'processing';
  }
  return null;
}

/**
 * 从 completed/failed/cancelled 读取结果文件
 * @param root - HGFS 共享根目录
 * @param taskId - 任务唯一标识
 * @returns 找到则返回 CommandTask，全部不存在返回 null
 */
export async function readResult(root: string, taskId: string): Promise<CommandTask | null> {
  const completedPath = await findTaskFileByTaskId(root, QUEUE_DIRS.completed, taskId);
  if (completedPath) {
    try {
      return JSON.parse(await readFile(completedPath, 'utf-8')) as CommandTask;
    } catch {
      // 解析失败继续
    }
  }
  const failedPath = await findTaskFileByTaskId(root, QUEUE_DIRS.failed, taskId);
  if (failedPath) {
    try {
      return JSON.parse(await readFile(failedPath, 'utf-8')) as CommandTask;
    } catch {
      // 解析失败继续
    }
  }
  const cancelledPath = await findTaskFileByTaskId(root, QUEUE_DIRS.cancelled, taskId, CANCELLED_RESULT_SUFFIX);
  if (cancelledPath) {
    try {
      return JSON.parse(await readFile(cancelledPath, 'utf-8')) as CommandTask;
    } catch {
      // 解析失败继续
    }
  }
  return null;
}

/**
 * 从指定目录读取任务文件
 * @param root - HGFS 共享根目录
 * @param dir - 队列目录名（pending 或 processing）
 * @param taskId - 任务唯一标识
 * @returns 找到返回 CommandTask，不存在返回 null
 */
export async function readTaskFromDir(
  root: string,
  dir: 'pending' | 'processing',
  taskId: string,
): Promise<CommandTask | null> {
  const filePath = await findTaskFileByTaskId(root, dir, taskId);
  if (filePath === null) {
    return null;
  }
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as CommandTask;
  } catch {
    return null;
  }
}

/**
 * 检查 cancelled/<taskId> 取消标记是否存在
 * @param root - HGFS 共享根目录
 * @param taskId - 任务唯一标识
 * @returns 存在返回 true
 */
export async function checkCancelMarker(root: string, taskId: string): Promise<boolean> {
  const cancelPath = join(root, QUEUE_DIRS.cancelled, taskId);
  try {
    await stat(cancelPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 写入取消标记到 cancelled/<taskId>（.tmp → rename 原子操作）
 * @param root - HGFS 共享根目录
 * @param taskId - 任务唯一标识
 */
export async function writeCancelMarker(root: string, taskId: string): Promise<void> {
  const markerPath = join(root, QUEUE_DIRS.cancelled, taskId);
  const tmpPath = `${markerPath}${TMP_SUFFIX}`;
  await writeFile(tmpPath, '', 'utf-8');
  await rename(tmpPath, markerPath);
}

/**
 * 读取心跳文件
 * @param root - HGFS 共享根目录
 * @returns 心跳内容，文件不存在或解析失败返回 null
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
 * 按相对路径读取大输出溢出文件
 * @param root - HGFS 共享根目录
 * @param relPath - 相对于 root 的文件路径（如 'outputs/<id>.stdout'）
 * @returns 文件内容字符串，读取失败返回 null
 */
export async function readOverflowOutput(root: string, relPath: string): Promise<string | null> {
  try {
    // 双平台兼容：Windows 写入的历史路径可能带反斜杠，统一替换为 posix 分隔符
    const fullPath = join(root, relPath.replaceAll('\\', '/'));
    return await readFile(fullPath, 'utf-8');
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// 文件交换服务器模式（exchange）：单向信箱目录操作
// outbound/ 内网只写（worker 只读），inbound/ worker 只写（内网只读）
// ────────────────────────────────────────────────────────────────

/**
 * 初始化交换模式的单向信箱目录：outbound/（含 sent/ 留痕）与 inbound/
 * @param root - HGFS 共享根目录绝对路径
 */
export async function initExchangeDirs(root: string): Promise<void> {
  await mkdir(join(root, EXCHANGE_DIRS.outbound, EXCHANGE_DIRS.sent), { recursive: true });
  await mkdir(join(root, EXCHANGE_DIRS.inbound), { recursive: true });
}

/**
 * 原子写任务文件到 outbound/（.tmp → rename），供交换模式 push 上传
 * @param root - HGFS 共享根目录
 * @param task - 任务结构体
 * @returns 任务文件相对路径 `outbound/<id>.json`（供 syncPush 上传；目录前缀由同步命令模板承担）
 */
export async function writeOutboundTask(root: string, task: CommandTask): Promise<string> {
  const targetPath = join(root, EXCHANGE_DIRS.outbound, taskFileName(task.submit_time, task.task_id));
  const tmpPath = `${targetPath}${TMP_SUFFIX}`;
  await writeFile(tmpPath, JSON.stringify(task), 'utf-8');
  await rename(tmpPath, targetPath);
  return join(EXCHANGE_DIRS.outbound, taskFileName(task.submit_time, task.task_id));
}

/**
 * 检查交换模式下任务是否仍在本地上传区（outbound/ 或 sent/ 留痕）
 * @param root - HGFS 共享根目录
 * @param taskId - 任务唯一标识
 * @returns 存在返回 true
 */
export async function exchangeTaskPending(root: string, taskId: string): Promise<boolean> {
  if (await findTaskFileByTaskId(root, EXCHANGE_DIRS.outbound, taskId)) {
    return true;
  }
  if (await findTaskFileByTaskId(root, join(EXCHANGE_DIRS.outbound, EXCHANGE_DIRS.sent), taskId)) {
    return true;
  }
  return false;
}

/**
 * push 成功后把本地任务文件移入 outbound/sent/ 留痕（同步范围之外，绝无二次上行）
 * @param root - HGFS 共享根目录
 * @param taskId - 任务唯一标识
 */
export async function archiveSentTask(root: string, taskId: string): Promise<void> {
  const srcPath = await findTaskFileByTaskId(root, EXCHANGE_DIRS.outbound, taskId);
  if (srcPath === null) {
    return;
  }
  const fileName = srcPath.split(/[\\/]/).pop() as string;
  const dstPath = join(root, EXCHANGE_DIRS.outbound, EXCHANGE_DIRS.sent, fileName);
  await rename(srcPath, dstPath).catch(() => {
    // 文件已被归档或不存在时忽略（幂等）
  });
}

/**
 * 原子写取消标记到 outbound/cancel_<id>.marker，供交换模式 push 上传（尽力取消）
 * @param root - HGFS 共享根目录
 * @param taskId - 任务唯一标识
 * @returns 取消标记相对路径 `outbound/cancel_<id>.marker`（供 syncPush 上传；目录前缀由同步命令模板承担）
 */
export async function writeOutboundCancelMarker(root: string, taskId: string): Promise<string> {
  const markerPath = join(root, EXCHANGE_DIRS.outbound, `cancel_${taskId}${CANCEL_MARKER_SUFFIX}`);
  const tmpPath = `${markerPath}${TMP_SUFFIX}`;
  await writeFile(tmpPath, '', 'utf-8');
  await rename(tmpPath, markerPath);
  return join(EXCHANGE_DIRS.outbound, `cancel_${taskId}${CANCEL_MARKER_SUFFIX}`);
}

/**
 * 从本地 inbound/ 镜像读取任务结果（过滤 .tmp 半成品）
 * 文件名约定：result_<id>.json（completed/failed），result_<id>.result（cancelled）
 * @param root - HGFS 共享根目录
 * @param taskId - 任务唯一标识
 * @returns 找到则返回 CommandTask，全部不存在返回 null
 */
export async function readResultExchange(root: string, taskId: string): Promise<CommandTask | null> {
  const inboundDir = join(root, EXCHANGE_DIRS.inbound);
  let entries: string[];
  try {
    entries = await readdir(inboundDir);
  } catch {
    return null;
  }
  const shortId = taskId.slice(0, 8).toUpperCase();
  for (const name of entries) {
    if (name.endsWith(TMP_SUFFIX) || !name.startsWith(EXCHANGE_RESULT_PREFIX)) {
      continue;
    }
    // result_<带时间戳基名>.json|.result
    const stripped = name.slice(EXCHANGE_RESULT_PREFIX.length);
    if (parseTaskIdFromFileName(stripped).toUpperCase() !== shortId) {
      continue;
    }
    try {
      const content = await readFile(join(inboundDir, name), 'utf-8');
      const parsed = JSON.parse(content) as CommandTask;
      if (parsed.task_id === taskId) {
        return parsed;
      }
    } catch {
      // 单个文件解析失败跳过
    }
  }
  return null;
}

/**
 * 从本地 inbound/ 镜像读取心跳（worker 额外落一份 inbound/heartbeat.json）
 * @param root - HGFS 共享根目录
 * @returns 心跳内容，文件不存在或解析失败返回 null
 */
export async function readHeartbeatExchange(root: string): Promise<Heartbeat | null> {
  try {
    const hbPath = join(root, EXCHANGE_DIRS.inbound, HEARTBEAT_FILE);
    const content = await readFile(hbPath, 'utf-8');
    return JSON.parse(content) as Heartbeat;
  } catch {
    return null;
  }
}

/**
 * 列出本地 inbound/ 镜像中的结果文件 task_id（供 GC 等使用，过滤 .tmp 半成品）
 * @param root - HGFS 共享根目录
 * @returns task_id 列表
 */
export async function listInboundResults(root: string): Promise<string[]> {
  const inboundDir = join(root, EXCHANGE_DIRS.inbound);
  let entries: string[];
  try {
    entries = await readdir(inboundDir);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of entries) {
    if (name.endsWith(TMP_SUFFIX)) {
      continue;
    }
    if (!name.startsWith(EXCHANGE_RESULT_PREFIX)) {
      continue;
    }
    // 读取内容解析完整 task_id
    try {
      const content = await readFile(join(inboundDir, name), 'utf-8');
      const parsed = JSON.parse(content) as { task_id?: string };
      if (parsed.task_id) {
        ids.push(parsed.task_id);
      }
    } catch {
      // 单个文件解析失败跳过
    }
  }
  return ids;
}

/**
 * 清理本地 inbound/ 镜像中超过保留期的结果文件
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
