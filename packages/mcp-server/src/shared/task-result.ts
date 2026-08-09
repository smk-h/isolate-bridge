/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : task-result.ts
 * Author     : MsgFerry
 * Date       : 2026/08/09
 * Version    : 0.0.1
 * Description: 多工具复用的任务结果读取逻辑——大输出指针拼回
 * ======================================================
 */

import { ErrorCode } from '@smai-kit/msgferry-shared';
import type { CommandTask } from '@smai-kit/msgferry-shared';

import { readOverflowOutput } from '../queue.js';

/** 拼回后的输出结果 */
export interface OverflowAwareResult {
  stdout: string;
  stderr: string;
  truncated: boolean;
  error_msg: string | null;
}

/**
 * 若任务 truncated=true 则按指针读取大输出拼回
 * @param root - HGFS 共享根目录
 * @param task - 任务结构体
 * @returns 拼回后的 stdout/stderr/truncated/error_msg
 */
export async function readOverflowIfTruncated(
  root: string,
  task: CommandTask,
): Promise<OverflowAwareResult> {
  if (!task.truncated) {
    return {
      stdout: task.stdout,
      stderr: task.stderr,
      truncated: false,
      error_msg: task.error_msg,
    };
  }

  let stdout = task.stdout;
  let stderr = task.stderr;
  let errorMsg = task.error_msg;

  // 按指针路径读取完整 stdout
  if (task.stdout_overflow_path) {
    const fullStdout = await readOverflowOutput(root, task.stdout_overflow_path);
    if (fullStdout !== null) {
      stdout = fullStdout;
    } else {
      errorMsg = ErrorCode.OverflowReadFailed;
    }
  }

  // 按指针路径读取完整 stderr
  if (task.stderr_overflow_path) {
    const fullStderr = await readOverflowOutput(root, task.stderr_overflow_path);
    if (fullStderr !== null) {
      stderr = fullStderr;
    } else {
      errorMsg = ErrorCode.OverflowReadFailed;
    }
  }

  return {
    stdout,
    stderr,
    truncated: false,
    error_msg: errorMsg,
  };
}
