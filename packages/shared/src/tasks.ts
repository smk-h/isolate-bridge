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
 * Session 交互式会话任务结构体（远期能力类型骨架）
 * 不在本阶段展开 stdin/stdout 摆渡执行逻辑
 */
export interface SessionTask {
  kind: 'session';                  // 判别字段，固定值
  session_id: string;               // 会话唯一标识
  cmd: string;                      // 初始命令
  timeout_sec: number;              // 会话超时上限
  submit_time: number;
  start_time: number;
  end_time: number;
  status: SessionStatus;            // 会话状态
  stdin_dir: string;                // stdin 摆渡目录约定
  stdout_dir: string;               // stdout 摆渡目录约定
  close_marker: string | null;       // 会话关闭标记，未关闭为 null
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
