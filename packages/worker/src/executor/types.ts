/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : types.ts
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: 执行器协议无关接口与类型定义
 *   - CmdExecutor：一次性命令执行器接口
 *   - ShellSession / ShellSessionFactory：交互式 shell 会话接口
 * ======================================================
 */

/** 命令执行结果（协议无关） */
export interface CmdResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
}

/** 命令执行器接口（协议无关） */
export interface CmdExecutor {
  /**
   * 执行命令并返回结果
   * @param cmd - 待执行命令
   * @param timeout_sec - 超时秒数
   * @param device - 目标设备名（可选，未指定走默认设备）
   * @returns 执行结果
   */
  execute(cmd: string, timeout_sec: number, device?: string): Promise<CmdResult>;
}

/**
 * 交互式 shell 会话接口（协议无关）
 * 基于 ssh2 shell channel + pty 建立，支持 stdin 注入与 stdout/stderr 订阅，
 * 供交互式 shell 任务做低频 stdin/stdout 文件摆渡。
 */
export interface ShellSession {
  /** 会话 id，形如 ssh_N */
  readonly sessionId: string;
  /** 目标设备名（normalize 后） */
  readonly device: string;
  /** 写入 stdin（交互式 shell 输入） */
  write(data: string): void;
  /** 订阅 stdout 输出（UTF-8 文本，每次回调一个数据块） */
  onStdout(cb: (chunk: string) => void): void;
  /** 退订 stdout 输出 */
  offStdout(cb: (chunk: string) => void): void;
  /** 订阅 stderr 输出（UTF-8 文本） */
  onStderr(cb: (chunk: string) => void): void;
  /** 退订 stderr 输出 */
  offStderr(cb: (chunk: string) => void): void;
  /** 订阅会话关闭（远端关闭或本地主动关闭触发） */
  onClose(cb: () => void): void;
  /** 退订会话关闭 */
  offClose(cb: () => void): void;
  /** 主动关闭会话并回收通道 */
  close(): Promise<void>;
}

/** 会话工厂：按设备打开交互式 shell 会话 */
export interface ShellSessionFactory {
  /**
   * 打开一个交互式 shell 会话
   * @param device - 目标设备名（可选，未指定走默认设备）
   * @returns 已就绪的会话
   */
  open(device?: string): Promise<ShellSession>;
  /** 关闭所有已建立的会话（Worker 优雅退出时调用） */
  closeAll(): Promise<void>;
}
