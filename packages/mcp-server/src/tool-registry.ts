/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : tool-registry.ts
 * Author     : MsgFerry
 * Date       : 2026/08/09
 * Version    : 0.0.1
 * Description: 工具注册基础设施——mcpDefineTool 泛型封装、统一调用日志、统一成功/错误响应构造
 * ======================================================
 */

import { fromJsonSchema } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';

import { logger } from '@smai-kit/msgferry-shared';

/** 文本内容块类型 */
export interface TextContent {
  type: 'text';
  text: string;
}

/** 错误响应结构 */
export interface ErrorStructuredContent {
  error_code: string;
  error_msg: string;
}

/** 工具回调：接收参数，返回 MCP CallToolResult */
export type mcpToolCallback = (args: unknown) => CallToolResult | Promise<CallToolResult>;

/** 工具配置（description + inputSchema，与实现同文件内聚） */
export interface mcpToolConfig {
  title?: string;
  description: string;
  inputSchema: ReturnType<typeof fromJsonSchema>;
}

/** 工具条目：name/config/handler 三元组，供 server 批量注册 */
export interface ToolEntry {
  name: string;
  config: mcpToolConfig;
  handler: mcpToolCallback;
}

/**
 * 快速构造 MCP TextContent 对象
 * @param content - 文本内容
 * @returns 文本内容块对象
 */
export function makeTextContent(content: string): TextContent {
  return { type: 'text', text: content };
}

/**
 * 构造成功响应（content + structuredContent）
 * @param data - 结构化数据
 * @returns MCP CallToolResult 格式的成功响应
 */
export function makeSuccessResult(data: unknown): {
  content: TextContent[];
  structuredContent: unknown;
} {
  return {
    content: [makeTextContent(JSON.stringify(data, null, 2))],
    structuredContent: data,
  };
}

/**
 * 构造错误响应（isError + error_code + error_msg）
 * @param errorCode - 错误码
 * @param errorMsg - 错误信息
 * @returns MCP CallToolResult 格式的错误响应
 */
export function makeErrorResult(errorCode: string, errorMsg: string): {
  content: TextContent[];
  isError: true;
  structuredContent: ErrorStructuredContent;
} {
  return {
    content: [makeTextContent(JSON.stringify({ error_code: errorCode, error_msg: errorMsg }, null, 2))],
    isError: true,
    structuredContent: { error_code: errorCode, error_msg: errorMsg },
  };
}

/**
 * 获取错误的可读消息
 * @param err - 任意异常
 * @returns Error.message 或 String(err)
 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 统一包裹工具执行：记录调用开始（含 AI 传入的原始参数）与调用结束/失败。
 * 日志流据此能精确配对每一次工具调用的开始/完成边界。
 * @param name - 工具名
 * @param handler - 原始工具回调
 * @returns 带调用日志的包装回调
 */
function withInvocationLog(name: string, handler: mcpToolCallback): mcpToolCallback {
  return async (args: unknown) => {
    const raw = args === undefined ? '' : JSON.stringify(args);
    logger.info(`>>> Tool invocation begins! [${name}] args=${raw}`);
    const started = Date.now();
    try {
      const result = await handler(args);
      const ms = Date.now() - started;
      logger.info(`<<< Tool invocation completed!!! [${name}] elapsed=${ms}ms`);
      return result;
    } catch (err) {
      const msg = getErrorMessage(err);
      const ms = Date.now() - started;
      logger.error(`<<< Tool invocation FAILED [${name}] elapsed=${ms}ms err=${msg}`);
      throw err;
    }
  };
}

/**
 * 泛型工具定义封装：把 name/config/handler 组装为 ToolEntry，并注入统一调用日志。
 * 新增工具时只需「一个文件 + 在族 index.ts 数组加一行」，server.ts 永不改动。
 * @param name - 工具名
 * @param config - 工具配置（description/inputSchema）
 * @param handler - 工具实现（接收泛型参数 T）
 * @returns ToolEntry
 */
export function mcpDefineTool<T>(
  name: string,
  config: mcpToolConfig,
  handler: (args: T) => CallToolResult | Promise<CallToolResult>,
): ToolEntry {
  return {
    name,
    config,
    handler: withInvocationLog(name, handler as mcpToolCallback),
  };
}
