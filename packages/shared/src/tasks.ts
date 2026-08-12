/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : tasks.ts
 * Author     : MsgFerry
 * Date       : 2026/08/07
 * Version    : 0.0.1
 * Description: MsgFerry shared 任务结构体（单命令任务、session 任务、批量任务）
 * ======================================================
 */

import { TaskStatus, SessionStatus } from './status.js';

/**
 * 单命令任务结构体
 * 对应架构文档「2.3 任务消息结构体」全部字段，用于请求-响应式单条 SSH 命令执行
 */
export interface CommandTask {
  kind: 'command';                  // 判别字段，固定值
  task_id: string;                  // 任务唯一标识（UUID）
  batch_id: string | null;          // 批量归属，无批次为 null
  depends_on: string[];             // 依赖的 task_id 列表，空数组表示无依赖
  cmd: string;                     // 待执行 SSH 命令
  device?: string;                  // 目标设备名（未指定走默认设备），由 submit 侧填写
  timeout_sec: number;              // 超时上限（秒）
  submit_time: number;              // 提交时间戳（ms epoch）
  start_time: number;               // 开始执行时间戳，未开始为 0
  end_time: number;                 // 结束时间戳，未结束为 0
  stdout: string;                   // 内联 stdout（截断至 max_inline_bytes）
  stderr: string;                   // 内联 stderr（截断）
  stdout_size: number;              // stdout 实际字节数
  stderr_size: number;              // stderr 实际字节数
  truncated: boolean;               // 是否发生截断
  stdout_overflow_path: string | null;  // 大输出溢出指针，无溢出为 null
  stderr_overflow_path: string | null;
  max_inline_bytes: number;         // 内联上限阈值（默认 65536）
  exit_code: number | null;         // 退出码，未执行为 null
  error_msg: string | null;         // 错误信息
  status: TaskStatus;               // 任务状态
  worker_pid: number | null;        // 执行 Worker 的 PID
  policy_blocked: boolean;         // 是否被安全策略拦截
}

/**
 * Session 交互式会话任务结构体
 * 基于文件队列做 stdin/stdout 双向摆渡：
 *  - 内网写入 <sessions>/<session_id>/stdin/<seq>.input，Worker 轮询读取后
 *    通过 pty 注入 ssh shell 会话；
 *  - ssh 输出由 Worker 实时写入 <sessions>/<session_id>/stdout/<seq>.output；
 *  - 内网写 close 标记触发会话关闭（close_marker）。
 * 受限于 HGFS 轮询延迟，仅适合低频交互，不适合 vim 等全屏 TUI。
 */
export interface SessionTask {
  kind: 'session';                  // 判别字段，固定值
  session_id: string;               // 会话唯一标识
  cmd: string;                      // 初始命令（会话启动后首条注入的命令，可为空串）
  device?: string;                  // 目标设备名（未指定走默认设备）
  timeout_sec: number;              // 会话超时上限（从最后活跃起算的空闲超时）
  submit_time: number;
  start_time: number;
  end_time: number;
  status: SessionStatus;            // 会话状态
  session_dir: string;              // 会话摆渡根目录（<root>/sessions/<session_id>）
  stdin_dir: string;                // stdin 摆渡目录（相对 session_dir）
  stdout_dir: string;               // stdout 摆渡目录（相对 session_dir）
  close_marker: string | null;      // 会话关闭标记路径，未关闭为 null
  stdout_seq: number;               // stdout 下一序号（Worker 维护）
  stdin_seq: number;                // stdin 下一序号（内网维护）
  error_msg: string | null;
  worker_pid: number | null;
}

/**
 * 批量任务：CommandTask 的 batch_id 非空形态
 * 复用单命令任务全部字段，收窄 batch_id 为非空 string
 */
export interface BatchTask extends CommandTask {
  batch_id: string;                 // 覆盖父字段，去除 null
}

/** 依赖链：task_id → 其依赖的 task_id 列表 */
export type DependencyChain = Record<string, string[]>;

/**
 * 批量任务集合
 * 约束同一批次内 task_id 唯一（由消费侧在构造时保证）
 */
export interface BatchTaskSet {
  batch_id: string;
  tasks: BatchTask[];               // 同批次任务集合
  dependency: DependencyChain;      // 依赖关系图
}
