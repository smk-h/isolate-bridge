/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : exchange.ts
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: 文件交换服务器模式（exchange）——outbound/ inbound/ 单向信箱目录操作
 *   outbound/ 内网只写（worker 只读），inbound/ worker 只写（内网只读）
 * ======================================================
 */

import { join } from 'node:path';
import {
  readFile,
  writeFile,
  readdir,
  mkdir,
  unlink,
  stat,
  rename,
} from 'node:fs/promises';

import {
  EXCHANGE_DIRS,
  HEARTBEAT_FILE,
} from '@smai-kit/msgferry-shared';
import type { CommandTask } from '@smai-kit/msgferry-shared';

import type { Heartbeat } from './shared.js';

const TMP_SUFFIX = '.tmp';
const JSON_SUFFIX = '.json';
const CANCELLED_RESULT_SUFFIX = '.result';
const CANCEL_MARKER_SUFFIX = '.marker';
const EXCHANGE_RESULT_PREFIX = 'result_';

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
    // 跳过写了一半的临时文件，避免误删正在写入的结果
    if (name.endsWith(TMP_SUFFIX)) {
      continue;
    }
    // 心跳文件不参与结果 GC（内网健康检查依赖它）
    if (name === HEARTBEAT_FILE) {
      continue;
    }
    const filePath = join(inboundDir, name);
    try {
      // 超保留期的结果文件（含大输出分包）删除
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
