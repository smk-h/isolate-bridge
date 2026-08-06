/**
 * @smai-kit/msgferry-shared
 * MsgFerry 共享类型契约
 * 内外网两侧共用，保证任务 JSON 读写契约一致
 *
 * 后续将定义：
 * - 任务消息结构体 TaskMessage
 * - 任务状态枚举 TaskStatus
 * - 错误码 ErrorCode
 * - 队列目录与轮询参数常量
 */

export const PACKAGE_NAME = '@smai-kit/msgferry-shared';

/** 队列目录名常量 */
export const QUEUE_DIRS = {
  pending: 'pending',
  completed: 'completed',
  failed: 'failed',
} as const;
