/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: 队列模块入口——统一 re-export 队列操作函数与策略
 *   对外符号面与旧 queue.ts 完全一致（另新增 QueueModeStrategy / createQueueStrategy）。
 * ======================================================
 */

export type { LockFile, Heartbeat } from './shared.js';
export {
  initQueueDirs,
  listPending,
  readTask,
  acquireLock,
  transitionToProcessing,
  writeOverflowOutput,
  writeResult,
  checkCancelled,
  writeCancelledResult,
  writeHeartbeat,
  readHeartbeat,
  releaseProcessing,
  gcProcessing,
  gcResults,
} from './shared.js';
export {
  initExchangeDirs,
  listOutbound,
  readOutboundTask,
  writeResultExchange,
  writeCancelledResultExchange,
  checkCancelledExchange,
  writeHeartbeatExchange,
  removeCancelMarker,
  gcInboundResults,
} from './exchange.js';
export type { QueueModeStrategy } from './strategy.js';
export { createQueueStrategy } from './strategy.js';
