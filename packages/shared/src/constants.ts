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

/** Worker 配置文件相对路径（位于共享根目录下，可与 MCP 侧共享约定）。
 * 使用 YAML 格式：支持注释，便于部署时填写说明。 */
export const WORKER_CONFIG_FILE = 'config/worker.yaml' as const;

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

/** 业务日志默认目录（相对共享根目录，未设置 LOG_DIR 时使用） */
export const LOG_DIRS = {
  /** mcp-server 业务日志默认目录 */
  mcpServer: 'logs/mcp-server',
  /** worker 业务日志默认目录 */
  worker: 'logs/worker',
} as const;

/** 交互式会话根目录（位于共享根目录下），每个会话占 <root>/sessions/<session_id>/ */
export const SESSIONS_DIR = 'sessions' as const;

/** 交互式会话摆渡子目录与序号文件约定 */
export const SESSION = {
  /** stdin 摆渡子目录名（相对会话根目录） */
  stdin: 'stdin',
  /** stdout 摆渡子目录名（相对会话根目录） */
  stdout: 'stdout',
  /** 关闭标记文件名 */
  close_marker: 'close.marker',
  /** 会话元信息文件名 */
  meta: 'session.json',
} as const;

/** 文件交换服务器模式（exchange）下的单向信箱目录名 */
export const EXCHANGE_DIRS = {
  /** 内网只写、Worker 只读：任务文件与取消标记的上传方向 */
  outbound: 'outbound',
  /** Worker 只写、内网只读：结果文件与心跳的拉取方向 */
  inbound: 'inbound',
  /** 内网 push 成功后本地留痕（同步范围之外，绝无二次上行） */
  sent: 'sent',
} as const;

/** 文件同步参数（交换服务器模式，MCP 侧 sync.ts 使用） */
export const SYNC = {
  /** 每次 push/pull 失败后的退避重试次数 */
  retries: 3,
  /** 各次重试前的等待间隔（毫秒） */
  retry_delays_ms: [1000, 2000, 4000] as const,
  /** 单次同步命令的超时上限（毫秒） */
  timeout_ms: 30000,
} as const;
