/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : strategy.ts
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: 队列模式策略接口——收敛 shared / exchange 分支
 *
 *   目标：把散落在 main.ts / processTask / housekeeping.ts 中按 queue_mode
 *   分支的「选目录 / 回写路径 / 取消方式」逻辑抽象成一个协议无关的策略接口。
 *   以后再加第三种队列模式，只需新增一个策略类 + 工厂加一行分支，不再改业务流。
 * ======================================================
 */

import type { CommandTask } from '@smai-kit/msgferry-shared';

import {
  initQueueDirs,
  listPending,
  readTask,
  writeResult,
  checkCancelled,
  writeCancelledResult,
  writeHeartbeat,
  gcResults,
  gcProcessing,
} from './shared.js';
import {
  initExchangeDirs,
  listOutbound,
  readOutboundTask,
  writeResultExchange,
  checkCancelledExchange,
  writeCancelledResultExchange,
  writeHeartbeatExchange,
  removeCancelMarker,
  gcInboundResults,
} from './exchange.js';
import type { Heartbeat } from './shared.js';

/**
 * 队列模式策略接口（协议无关）
 * 封装「按 mode 变化的目录初始化、任务读取、结果回写、取消检查、心跳与 GC」。
 */
export interface QueueModeStrategy {
  /** 队列模式标识 */
  readonly mode: 'shared' | 'exchange';
  /** 初始化本模式全部队列目录 */
  initDirs(root: string): Promise<void>;
  /** 列出待领取任务 id */
  listTasks(root: string): Promise<string[]>;
  /** 读取任务 */
  readTask(root: string, taskId: string): Promise<CommandTask>;
  /** 领取后移入 processing 的源目录 */
  transitionSourceDir(): 'pending' | 'outbound';
  /** 回写结果 */
  writeResult(root: string, task: CommandTask, maxInline: number): Promise<void>;
  /** 回写取消结果 */
  writeCancelledResult(root: string, task: CommandTask): Promise<void>;
  /** 检查取消标记 */
  checkCancelled(root: string, taskId: string): Promise<boolean>;
  /** 消费后清理取消残留（exchange 特有，shared 空实现） */
  afterConsumed(root: string, taskId: string): Promise<void>;
  /** 心跳落盘（shared 落根 heartbeat.json，exchange 额外落 inbound） */
  writeHeartbeat(root: string, hb: Heartbeat): Promise<void>;
  /** 结果 GC（shared 扫 completed/failed，exchange 扫 inbound） */
  gcResults(root: string, ttlSec: number): Promise<number>;
}

/** shared 共享目录模式策略 */
class SharedQueueStrategy implements QueueModeStrategy {
  readonly mode = 'shared' as const;

  async initDirs(root: string): Promise<void> {
    await initQueueDirs(root);
  }

  listTasks(root: string): Promise<string[]> {
    return listPending(root);
  }

  readTask(root: string, taskId: string): Promise<CommandTask> {
    return readTask(root, taskId);
  }

  transitionSourceDir(): 'pending' {
    return 'pending';
  }

  writeResult(root: string, task: CommandTask, maxInline: number): Promise<void> {
    return writeResult(root, task, maxInline);
  }

  writeCancelledResult(root: string, task: CommandTask): Promise<void> {
    return writeCancelledResult(root, task);
  }

  checkCancelled(root: string, taskId: string): Promise<boolean> {
    return checkCancelled(root, taskId);
  }

  async afterConsumed(): Promise<void> {
    // shared 模式无取消残留需要清理
  }

  writeHeartbeat(root: string, hb: Heartbeat): Promise<void> {
    return writeHeartbeat(root, hb);
  }

  gcResults(root: string, ttlSec: number): Promise<number> {
    return Promise.all([gcResults(root, ttlSec), gcProcessing(root, ttlSec)])
      .then(([results, processing]) => results + processing);
  }
}

/** exchange 文件交换服务器模式策略 */
class ExchangeQueueStrategy implements QueueModeStrategy {
  readonly mode = 'exchange' as const;

  async initDirs(root: string): Promise<void> {
    // exchange 也需要共享目录（锁/processing 等），额外初始化 outbound/inbound 信箱
    await initQueueDirs(root);
    await initExchangeDirs(root);
  }

  listTasks(root: string): Promise<string[]> {
    return listOutbound(root);
  }

  readTask(root: string, taskId: string): Promise<CommandTask> {
    return readOutboundTask(root, taskId);
  }

  transitionSourceDir(): 'outbound' {
    return 'outbound';
  }

  writeResult(root: string, task: CommandTask, maxInline: number): Promise<void> {
    return writeResultExchange(root, task, maxInline);
  }

  writeCancelledResult(root: string, task: CommandTask): Promise<void> {
    return writeCancelledResultExchange(root, task);
  }

  checkCancelled(root: string, taskId: string): Promise<boolean> {
    return checkCancelledExchange(root, taskId);
  }

  afterConsumed(root: string, taskId: string): Promise<void> {
    return removeCancelMarker(root, taskId);
  }

  async writeHeartbeat(root: string, hb: Heartbeat): Promise<void> {
    await writeHeartbeat(root, hb);
    await writeHeartbeatExchange(root, hb);
  }

  gcResults(root: string, ttlSec: number): Promise<number> {
    return Promise.all([gcInboundResults(root, ttlSec), gcProcessing(root, ttlSec)])
      .then(([results, processing]) => results + processing);
  }
}

/**
 * 按队列模式创建策略实例
 * @param mode - 队列模式
 * @returns 策略实例
 */
export function createQueueStrategy(mode: 'shared' | 'exchange'): QueueModeStrategy {
  if (mode === 'exchange') {
    return new ExchangeQueueStrategy();
  }
  return new SharedQueueStrategy();
}
