/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : utils.ts
 * Author     : MsgFerry
 * Date       : 2026/08/07
 * Version    : 0.0.1
 * Description: MsgFerry shared 纯函数工具（终态判定、错误码归类、任务判别、状态流转校验、循环依赖检测）
 * ======================================================
 */

import { TaskStatus, TERMINAL_STATUSES, VALID_TRANSITIONS } from './status.js';
import { ErrorCode, RETRYABLE_ERROR_CODES } from './errors.js';
import { CommandTask, SessionTask, DependencyChain } from './tasks.js';

/**
 * 判断给定状态是否为终态
 * 终态进入后不再流转（completed/failed/cancelled）
 * @param status - 任务状态
 * @returns 是终态返回 true，否则 false
 */
export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * 判断给定错误码是否可重试
 * 可重试码为环境性/暂时性故障（设备离线、Worker 离线、超时、SSH 连接失败）
 * @param code - 错误码
 * @returns 可重试返回 true，不可重试返回 false
 */
export function isRetryableErrorCode(code: ErrorCode): boolean {
  return RETRYABLE_ERROR_CODES.has(code);
}

/**
 * 判断给定任务是否为单命令任务
 * @param task - 任务对象（CommandTask 或 SessionTask）
 * @returns 是单命令任务返回 true，并收窄类型
 */
export function isCommandTask(task: CommandTask | SessionTask): task is CommandTask {
  return task.kind === 'command';
}

/**
 * 判断给定任务是否为 session 交互式任务
 * @param task - 任务对象（CommandTask 或 SessionTask）
 * @returns 是 session 任务返回 true，并收窄类型
 */
export function isSessionTask(task: CommandTask | SessionTask): task is SessionTask {
  return task.kind === 'session';
}

/**
 * 判断从状态 from 到状态 to 的流转是否合法
 * 合法流转：pending→processing、processing→completed/failed/cancelled
 * 逆向流转与终态后继均非法
 * @param from - 起始状态
 * @param to - 目标状态
 * @returns 合法返回 true，非法返回 false
 */
export function isValidStatusTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/**
 * 检测依赖图是否存在循环依赖
 * 基于 DFS，对每个起点做深度遍历，遇到已在当前递归栈中的节点即存在环
 * @param chain - 依赖图：task_id → 其依赖的 task_id 列表
 * @returns 存在环（含自依赖）返回 true，无环返回 false
 */
export function hasCircularDependency(chain: DependencyChain): boolean {
  const visited = new Set<string>();        // 全局已访问节点
  const inStack = new Set<string>();        // 当前递归栈中的节点

  /**
   * 从单个节点出发做 DFS，检测环
   * @param node - 当前节点
   * @returns 当前路径上存在环返回 true
   */
  function dfs(node: string): boolean {
    if (inStack.has(node)) {
      // 回到当前路径上的节点，存在环
      return true;
    }
    if (visited.has(node)) {
      // 已完整访问过且无环，跳过
      return false;
    }
    visited.add(node);
    inStack.add(node);
    const deps = chain[node] ?? [];
    for (const dep of deps) {
      if (dfs(dep)) {
        return true;
      }
    }
    inStack.delete(node);
    return false;
  }

  // 对所有起点尝试 DFS，处理不连通的依赖图
  for (const node of Object.keys(chain)) {
    if (dfs(node)) {
      return true;
    }
  }
  return false;
}
