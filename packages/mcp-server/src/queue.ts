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
} from 'node:fs/promises';

import { QUEUE_DIRS, HEARTBEAT_FILE } from '@smai-kit/msgferry-shared';
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
 * 原子提交任务到 pending/ 目录（.tmp → rename）
 * @param root - HGFS 共享根目录
 * @param task - 任务结构体
 */
export async function submitTask(root: string, task: CommandTask): Promise<void> {
  const targetPath = join(root, QUEUE_DIRS.pending, `${task.task_id}${JSON_SUFFIX}`);
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
  const pendingPath = join(root, QUEUE_DIRS.pending, `${taskId}${JSON_SUFFIX}`);
  try {
    await stat(pendingPath);
    return 'pending';
  } catch {
    // pending 不存在，继续检查 processing
  }

  const processingPath = join(root, QUEUE_DIRS.processing, `${taskId}${JSON_SUFFIX}`);
  try {
    await stat(processingPath);
    return 'processing';
  } catch {
    return null;
  }
}

/**
 * 从 completed/failed/cancelled 读取结果文件
 * @param root - HGFS 共享根目录
 * @param taskId - 任务唯一标识
 * @returns 找到则返回 CommandTask，全部不存在返回 null
 */
export async function readResult(root: string, taskId: string): Promise<CommandTask | null> {
  const candidates = [
    join(root, QUEUE_DIRS.completed, `${taskId}${JSON_SUFFIX}`),
    join(root, QUEUE_DIRS.failed, `${taskId}${JSON_SUFFIX}`),
    join(root, QUEUE_DIRS.cancelled, `${taskId}${CANCELLED_RESULT_SUFFIX}`),
  ];

  for (const filePath of candidates) {
    try {
      const content = await readFile(filePath, 'utf-8');
      return JSON.parse(content) as CommandTask;
    } catch {
      // 文件不存在，尝试下一个
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
  const filePath = join(root, dir, `${taskId}${JSON_SUFFIX}`);
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
