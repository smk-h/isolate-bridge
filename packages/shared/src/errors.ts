/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : errors.ts
 * Author     : MsgFerry
 * Date       : 2026/08/07
 * Version    : 0.0.1
 * Description: MsgFerry shared 系统级错误码枚举、描述表、可重试/不可重试归类
 * ======================================================
 */

/** 系统级错误码枚举 */
export const ErrorCode = {
  BlockedByPolicy: 'blocked_by_policy',
  ExecutionTimeout: 'execution_timeout',
  SshConnectionFailed: 'ssh_connection_failed',
  DeviceOffline: 'device_offline',
  WorkerOffline: 'worker_offline',
  DuplicateSubmit: 'duplicate_submit',
  OrphanedResult: 'orphaned_result',
  OverflowReadFailed: 'overflow_read_failed',
  Unknown: 'unknown',
} as const;

export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

/** 错误码 → 人类可读简短描述 */
export const ERROR_CODE_DESCRIPTIONS: Readonly<Record<ErrorCode, string>> = {
  [ErrorCode.BlockedByPolicy]: '命令被安全策略拦截',
  [ErrorCode.ExecutionTimeout]: '任务执行超时',
  [ErrorCode.SshConnectionFailed]: 'SSH 连接失败',
  [ErrorCode.DeviceOffline]: '设备离线',
  [ErrorCode.WorkerOffline]: 'Worker 心跳过期，离线',
  [ErrorCode.DuplicateSubmit]: '任务重复提交',
  [ErrorCode.OrphanedResult]: '孤儿结果：内网已取消但 Worker 回写',
  [ErrorCode.OverflowReadFailed]: '大输出指针文件读取失败',
  [ErrorCode.Unknown]: '未知错误',
};

/** 可重试错误码集合：环境性/暂时性故障，重试可能成功 */
export const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ErrorCode.DeviceOffline,
  ErrorCode.WorkerOffline,
  ErrorCode.ExecutionTimeout,
  ErrorCode.SshConnectionFailed,
]);

/** 不可重试错误码集合：确定性故障，重试无意义 */
export const NON_RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ErrorCode.BlockedByPolicy,
  ErrorCode.DuplicateSubmit,
  ErrorCode.OrphanedResult,
  ErrorCode.OverflowReadFailed,
  ErrorCode.Unknown,
]);
