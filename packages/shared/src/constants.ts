/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : constants.ts
 * Author     : MsgFerry
 * Date       : 2026/08/07
 * Version    : 0.0.1
 * Description: MsgFerry shared 队列目录与运行参数常量
 * ======================================================
 */

/** HGFS 共享根目录下的队列子目录名与心跳文件名 */
export const QUEUE_DIRS = {
  pending: 'pending',
  processing: 'processing',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  outputs: 'outputs',
  policy: 'policy',
} as const;

/** 心跳文件名（位于共享根目录） */
export const HEARTBEAT_FILE = 'heartbeat.json' as const;

/** Worker 配置文件相对路径（位于共享根目录下，可与 MCP 侧共享约定） */
export const WORKER_CONFIG_FILE = 'config/worker.json' as const;

/** 轮询退避参数（毫秒） */
export const POLLING = {
  /** 起步间隔，有任务后复位到此值 */
  initial_interval_ms: 500,
  /** 退避上限 */
  max_interval_ms: 3000,
} as const;

/** 大输出内联上限 */
export const OUTPUT = {
  /** stdout/stderr 内联字节数上限，超过则落 outputs/ 子目录 */
  max_inline_bytes: 65536,
} as const;

/** 心跳保活参数（秒） */
export const HEARTBEAT = {
  /** 心跳过期阈值：now - last_beat 超过此值视为 Worker 离线 */
  expiry_sec: 15,
  /** Worker 心跳写入间隔 */
  write_interval_sec: 5,
} as const;

/** 结果文件保留期（秒） */
export const RETENTION = {
  /** completed/failed 结果文件保留时长，过期由 Worker 清理 */
  result_ttl_sec: 600,
} as const;

/** 内网侧等待参数（毫秒） */
export const WAIT = {
  /** 内网提交后阻塞等待结果的最大时长，超时则写 cancelled 取消标记 */
  default_max_wait_ms: 30000,
} as const;
