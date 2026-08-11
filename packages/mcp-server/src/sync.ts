/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : sync.ts
 * Author     : MsgFerry
 * Date       : 2026/08/10
 * Version    : 0.0.1
 * Description: 文件同步适配层——共享目录 / 文件交换服务器两种模式的唯一同步出入口
 *   - shared 模式（未配置同步命令）：全部同步调用短路，零成本；
 *   - exchange 模式（配置了 MSGFERRY_SYNC_PUSH_CMD / MSGFERRY_SYNC_PULL_CMD）：
 *     完整命令由用户配置，MCP 只做占位符替换 + spawn + 超时 + 退避重试。
 * ======================================================
 */

import { spawn } from 'node:child_process';

import { EXCHANGE_DIRS, SYNC, logger } from '@smai-kit/msgferry-shared';

import type { McpServerConfig } from './config.js';

/** PUSH 模板命令占位符：本地单个任务文件相对路径（如 `outbound/<id>.json`，目录前缀由模板承担） */
const SRC_PLACEHOLDER = '{src}';
/** PUSH 模板命令占位符：服务器 outbound/ 目录（相对目录，前缀由模板承担，MCP 不校验） */
const DST_PLACEHOLDER = '{dst}';

/** 命令执行结果 */
export interface SyncRunResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * 是否处于文件交换服务器模式
 * @param config - MCP Server 配置
 * @returns exchange 返回 true，shared 返回 false
 */
export function isExchangeMode(config: McpServerConfig): boolean {
  return config.sync_mode === 'exchange';
}

/**
 * 执行完整同步命令（spawn shell），带超时与失败重试
 * @param cmd - 完整命令字符串
 * @param timeoutMs - 单次执行超时上限（毫秒）
 * @param retries - 失败重试次数（退避重试，含首次之后的次数）
 * @param retryDelays - 各次重试前的等待间隔（毫秒）
 * @returns 最后一次执行的退出码/输出
 * @throws {Error} 全部重试耗尽仍非零退出码时抛错（上层映射为 SyncFailed）
 */
async function runSyncCmd(
  cmd: string,
  timeoutMs: number,
  retries: number,
  retryDelays: readonly number[],
): Promise<SyncRunResult> {
  let last: SyncRunResult | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await runOnce(cmd, timeoutMs);
    last = result;

    if (result.exit_code === 0) {
      return result;
    }

    // 非零退出码 = 同步失败；还有重试机会则退避等待后重试
    if (attempt < retries) {
      const delay = retryDelays[attempt] ?? retryDelays[retryDelays.length - 1] ?? 1000;
      logger.warn(
        `[sync] command failed (exit=${result.exit_code}), retry ${attempt + 1}/${retries} after ${delay}ms: ${cmd}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error(
    `sync command failed after ${retries + 1} attempts (exit=${last?.exit_code ?? 'null'}): ${cmd}\n${last?.stderr ?? ''}`,
  );
}

/**
 * 单次执行命令，收集退出码与输出
 * @param cmd - 完整命令字符串
 * @param timeoutMs - 超时上限（毫秒）
 * @returns 退出码与输出
 */
function runOnce(cmd: string, timeoutMs: number): Promise<SyncRunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // 超时直接终止子进程并视为失败（非零退出码），由上层退避重试
      child.kill('SIGKILL');
      resolve({ exit_code: null, stdout, stderr: `${stderr}\n[sync] command timed out after ${timeoutMs}ms`.trim() });
    }, timeoutMs);

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exit_code: null, stdout, stderr: `${stderr}\n${err.message}`.trim() });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exit_code: code, stdout, stderr });
    });
  });
}

/**
 * 生成最终 push 命令：把模板命令中的 {src}/{dst} 占位符替换为相对路径
 * - {src}：本地单个任务文件相对路径 `outbound/<id>.json`（目录前缀如 `vm_share/` 由模板承担）
 * - {dst}：服务器 outbound/ 目录（相对目录，前缀由模板承担）
 * 替换用纯字符串 replaceAll，不做 shell 解析，用户命令可带任意自定义参数。
 * @param template - 用户配置的 push 模板命令
 * @param localTaskPath - 本地任务文件相对路径
 * @param remoteOutboundDir - 服务器 outbound/ 目录（相对目录）
 * @returns 替换占位符后的完整命令
 */
export function renderPushCommand(
  template: string,
  localTaskPath: string,
  remoteOutboundDir: string,
): string {
  return template
    .replaceAll(SRC_PLACEHOLDER, localTaskPath)
    .replaceAll(DST_PLACEHOLDER, remoteOutboundDir);
}

/**
 * 同步推送单个任务文件到服务器 outbound/ 目录（exchange 模式）
 * - shared 模式直接短路（返回成功）；
 * - exchange 模式：渲染模板命令 → spawn → 超时 → 退避重试；
 *   全部重试耗尽仍失败时抛错（上层映射 SyncFailed）。
 * @param config - MCP Server 配置
 * @param localTaskPath - 本地单个任务文件相对路径 `outbound/<id>.json`（目录前缀由模板承担）
 * @returns Promise<void>
 */
export async function syncPush(
  config: McpServerConfig,
  localTaskPath: string,
): Promise<void> {
  if (!isExchangeMode(config)) {
    return;
  }
  const template = config.sync_push_cmd;
  if (!template) {
    throw new Error('sync_push_cmd is not configured in exchange mode');
  }
  const remoteOutboundDir = `${EXCHANGE_DIRS.outbound}/`;
  const cmd = renderPushCommand(template, localTaskPath, remoteOutboundDir);
  logger.info(`[sync] push: ${cmd}`);
  await runSyncCmd(cmd, config.sync_timeout_ms, config.sync_retries, SYNC.retry_delays_ms);
}

/**
 * 同步拉取服务器 inbound/ 整目录到本地（exchange 模式）
 * - shared 模式直接短路（返回成功）；
 * - exchange 模式：直接 spawn PULL 静态命令 → 超时 → 退避重试；
 *   拉取失败抛错（由上层决定是否视为 Worker 离线）。
 * @param config - MCP Server 配置
 * @returns Promise<void>
 */
export async function syncPull(config: McpServerConfig): Promise<void> {
  if (!isExchangeMode(config)) {
    return;
  }
  const cmd = config.sync_pull_cmd;
  if (!cmd) {
    throw new Error('sync_pull_cmd is not configured in exchange mode');
  }
  logger.info(`[sync] pull: ${cmd}`);
  await runSyncCmd(cmd, config.sync_timeout_ms, config.sync_retries, SYNC.retry_delays_ms);
}
