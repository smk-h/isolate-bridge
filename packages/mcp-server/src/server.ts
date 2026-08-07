/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : server.ts
 * Author     : MsgFerry
 * Date       : 2026/08/08
 * Version    : 0.0.1
 * Description: McpServer 创建、工具注册、StdioServerTransport 连接
 * ======================================================
 */

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { z } from 'zod';

import type { McpServerConfig } from './config.js';
import {
  submitSshTask,
  queryTaskStatus,
  cancelTask,
  checkBridgeHealth,
} from './tools.js';

/** MCP Server 名称 */
const SERVER_NAME = '@smai-kit/msgferry-mcp-server';

/** MCP Server 版本 */
const SERVER_VERSION = '0.0.1';

/** 文本内容块类型 */
interface TextContent {
  type: 'text';
  text: string;
}

/** 错误响应结构 */
interface ErrorStructuredContent {
  error_code: string;
  error_msg: string;
}

/**
 * 构造文本内容块
 * @param text - 文本内容
 * @returns 文本内容块对象
 */
function makeTextContent(text: string): TextContent {
  return { type: 'text', text };
}

/**
 * 构造成功响应（content + structuredContent）
 * @param data - 结构化数据
 * @returns MCP CallToolResult 格式的成功响应
 */
function makeSuccessResult(data: unknown): {
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
function makeErrorResult(errorCode: string, errorMsg: string): {
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
 * 创建 McpServer 实例并注册四个工具
 * @param config - MCP Server 配置
 * @param root - HGFS 共享根目录
 * @returns 已注册工具的 McpServer 实例
 */
export function createMcpServer(config: McpServerConfig, root: string): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // 注册 submit_ssh_task 工具
  server.registerTool(
    'submit_ssh_task',
    {
      title: 'Submit SSH Task',
      description: '提交 SSH 命令到外网 Worker 执行，阻塞等待结果返回',
      inputSchema: z.object({
        cmd: z.string().describe('待执行 SSH 命令'),
        timeout_sec: z.number().optional().describe('命令超时秒数，默认 30'),
        task_id: z.string().optional().describe('自定义任务标识，未提供则自动生成'),
      }),
    },
    async (args) => {
      try {
        const result = await submitSshTask(config, root, {
          cmd: args.cmd,
          timeout_sec: args.timeout_sec,
          task_id: args.task_id,
        });
        return makeSuccessResult(result);
      } catch (e) {
        return makeErrorResult('unknown', String(e));
      }
    },
  );

  // 注册 query_task_status 工具
  server.registerTool(
    'query_task_status',
    {
      title: 'Query Task Status',
      description: '按 task_id 查询任务当前状态与已有结果',
      inputSchema: z.object({
        task_id: z.string().describe('任务唯一标识'),
      }),
    },
    async (args) => {
      try {
        const result = await queryTaskStatus(root, args.task_id);
        return makeSuccessResult(result);
      } catch (e) {
        return makeErrorResult('unknown', String(e));
      }
    },
  );

  // 注册 cancel_task 工具
  server.registerTool(
    'cancel_task',
    {
      title: 'Cancel Task',
      description: '取消任务，写入取消标记触发 Worker 孤儿结果回收',
      inputSchema: z.object({
        task_id: z.string().describe('任务唯一标识'),
      }),
    },
    async (args) => {
      try {
        const result = await cancelTask(root, args.task_id);
        return makeSuccessResult(result);
      } catch (e) {
        return makeErrorResult('unknown', String(e));
      }
    },
  );

  // 注册 check_bridge_health 工具
  server.registerTool(
    'check_bridge_health',
    {
      title: 'Check Bridge Health',
      description: '检查外网 Worker 存活状态，读取心跳判断是否在线',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const result = await checkBridgeHealth(root);
        return makeSuccessResult(result);
      } catch (e) {
        return makeErrorResult('unknown', String(e));
      }
    },
  );

  return server;
}

/**
 * 创建 StdioServerTransport 并连接 McpServer
 * @param server - 已注册工具的 McpServer 实例
 */
export async function startServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp-server] stdio transport connected');
}
