/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : status.ts
 * Author     : MsgFerry
 * Date       : 2026/08/07
 * Version    : 0.0.1
 * Description: MsgFerry shared 任务状态与会话状态枚举、终态集合、状态流转表
 * ======================================================
 */

/** 任务状态枚举，状态机单向流转 */
export const TaskStatus = {
  Pending: 'pending',
  Processing: 'processing',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;

export type TaskStatus = typeof TaskStatus[keyof typeof TaskStatus];

/** 会话状态枚举（远期 session 能力） */
export const SessionStatus = {
  Creating: 'creating',
  Running: 'running',
  Closed: 'closed',
  Aborted: 'aborted',
} as const;

export type SessionStatus = typeof SessionStatus[keyof typeof SessionStatus];

/** 终态集合：进入后不再流转 */
export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  TaskStatus.Completed,
  TaskStatus.Failed,
  TaskStatus.Cancelled,
] as const;

/**
 * 合法状态流转表
 * pending → processing（Worker 抢占）
 * processing → completed/failed/cancelled（执行结束或被取消）
 * 终态无后继
 */
export const VALID_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  [TaskStatus.Pending]: [TaskStatus.Processing],
  [TaskStatus.Processing]: [
    TaskStatus.Completed,
    TaskStatus.Failed,
    TaskStatus.Cancelled,
  ],
  [TaskStatus.Completed]: [],
  [TaskStatus.Failed]: [],
  [TaskStatus.Cancelled]: [],
};
