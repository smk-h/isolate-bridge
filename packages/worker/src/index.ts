/**
 * @smai-kit/msgferry-worker
 * MsgFerry 外网 Node Worker 入口
 *
 * 常驻后台进程，轮询 pending/ 消费任务，
 * 经安全策略校验后 SSH 执行，回写结果到 completed/failed。
 *
 * 后续将实现：
 * - 主循环轮询与任务抢占
 * - 命令安全策略校验
 * - SSH 执行与超时控制
 * - 心跳保活
 */

export const PACKAGE_NAME = '@smai-kit/msgferry-worker';

export { QUEUE_DIRS } from '@smai-kit/msgferry-shared';
