/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : housekeeping.ts
 * Author     : MsgFerry
 * Date       : 2026/08/07
 * Version    : 0.0.1
 * Description: 心跳与 GC 周期循环
 * ======================================================
 */

import { writeHeartbeat, gcResults } from './queue.js';
import type { Heartbeat } from './queue.js';

/** 心跳统计获取函数类型 */
export type HeartbeatStatsGetter = () => { processedCount: number; queueDepth: number };

/** 循环句柄 */
interface LoopHandle {
  stop(): Promise<void>;
}

/**
 * 启动心跳写入循环
 * @param root - HGFS 共享根目录
 * @param intervalSec - 心跳写入间隔（秒）
 * @param getStats - 获取统计数据的回调
 * @returns 带 stop 方法的句柄
 */
export function startHeartbeatLoop(
  root: string,
  intervalSec: number,
  getStats: HeartbeatStatsGetter,
): LoopHandle {
  const timer = setInterval(async () => {
    try {
      const stats = getStats();
      const hb: Heartbeat = {
        pid: process.pid,
        last_beat: Date.now(),
        processed_count: stats.processedCount,
        queue_depth: stats.queueDepth,
        shutdown_at: null,
      };
      await writeHeartbeat(root, hb);
    } catch {
      // 心跳写入失败不阻塞主循环，仅告警
      console.warn('[housekeeping] heartbeat write failed');
    }
  }, intervalSec * 1000);

  return {
    stop() {
      clearInterval(timer);
      return Promise.resolve();
    },
  };
}

/**
 * 启动结果文件 GC 循环
 * @param root - HGFS 共享根目录
 * @param ttlSec - 结果保留期（秒）
 * @param intervalSec - GC 扫描间隔（秒）
 * @returns 带 stop 方法的句柄
 */
export function startGcLoop(
  root: string,
  ttlSec: number,
  intervalSec: number,
): LoopHandle {
  const timer = setInterval(async () => {
    try {
      await gcResults(root, ttlSec);
    } catch {
      // GC 失败不阻塞主循环，仅告警
      console.warn('[housekeeping] gc failed');
    }
  }, intervalSec * 1000);

  return {
    stop() {
      clearInterval(timer);
      return Promise.resolve();
    },
  };
}
