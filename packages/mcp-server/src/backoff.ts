/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : backoff.ts
 * Author     : MsgFerry
 * Date       : 2026/08/08
 * Version    : 0.0.1
 * Description: 轮询退避纯函数——指数退避，有任务复位，无任务增长到上限
 * ======================================================
 */

/** 退避状态对象 */
export interface BackoffState {
  /** 当前间隔（毫秒） */
  readonly current_interval_ms: number;
  /** 有任务时复位到初始间隔 */
  reset(): void;
  /** 返回当前间隔并推进到下一档（不超上限） */
  next(): number;
}

/**
 * 创建退避状态对象
 * @param initial - 起始间隔（毫秒），有任务时复位到此值
 * @param max - 退避上限（毫秒）
 * @returns 退避状态对象
 */
export function createBackoff(initial: number, max: number): BackoffState {
  let current = initial;

  return {
    get current_interval_ms() {
      return current;
    },
    reset() {
      // 有任务时立即复位到初始间隔，保证繁忙时响应速度
      current = initial;
    },
    next() {
      // 返回当前间隔，然后翻倍推进（不超上限）
      const result = current;
      current = Math.min(current * 2, max);
      return result;
    },
  };
}
