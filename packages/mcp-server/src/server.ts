/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : server.ts
 * Author     : MsgFerry
 * Date       : 2026/08/09
 * Version    : 0.0.1
 * Description: McpServer 创建、工具批量注册、StdioServerTransport 连接（不含任何工具业务）
 * ======================================================
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import type { McpServerConfig } from './config.js';
import { createAllTools } from './tools/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 兜底 Server 信息（读取失败时使用，正常情况从 package.json 读取） */
const FALLBACK_PKG = {
  name: '@smai-kit/msgferry-mcp-server',
  version: '0.0.0',
};

/**
 * 从 package.json 读取 Server 名称与版本，避免硬编码漂移。
 * bundle 产物模式下 package.json 与 index.mjs 同目录；
 * 源码/tsx 直跑模式下位于 src/ 的上一级。
 */
function readPkgInfo(): { name: string; version: string } {
  const candidates = [
    resolve(__dirname, 'package.json'),     // dist/msgferry-mcp-server/package.json
    resolve(__dirname, '../package.json'),  // packages/mcp-server/package.json
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf-8')) as {
        name?: string;
        version?: string;
      };
      if (pkg?.name && pkg?.version) {
        return { name: pkg.name, version: pkg.version };
      }
    } catch {
      // 当前候选路径不可读，尝试下一个
    }
  }
  return FALLBACK_PKG;
}

const pkgInfo = readPkgInfo();

/** 向客户端说明 Server 能力与工具语义 */
const INSTRUCTIONS = [
  'MsgFerry 内网 MCP Server：在隔离网络环境下，通过 HGFS 共享目录文件队列，把 SSH 命令投递给外网 Worker 执行并回读结果。',
  '可用工具：',
  '- submit_ssh_task：提交 SSH 命令到外网 Worker 执行，阻塞等待结果返回；',
  '- query_task_status：按 task_id 查询任务当前状态与已有结果；',
  '- cancel_task：取消任务，写入取消标记触发 Worker 孤儿结果回收；',
  '- check_bridge_health：检查外网 Worker 存活状态，读取心跳判断是否在线。',
  '提示：submit_ssh_task 为阻塞式调用，命令执行耗时较长时请配合足够大的客户端调用超时；',
  '任务结果中的 status 字段取值：pending / processing / completed / failed / cancelled / timeout。',
].join(' ');

/**
 * 创建 McpServer 实例并批量注册全部工具。
 * 新增工具只需在 tools/ 下新增文件并在族 index.ts 数组加一行，本函数永不改动。
 * @param config - MCP Server 配置
 * @param root - HGFS 共享根目录
 * @returns 已注册工具的 McpServer 实例
 */
export function createMcpServer(config: McpServerConfig, root: string): McpServer {
  const server = new McpServer(
    { name: pkgInfo.name, version: pkgInfo.version },
    {
      capabilities: { logging: {} },
      instructions: INSTRUCTIONS,
    },
  );

  for (const { name, config: toolConfig, handler } of createAllTools(config, root)) {
    server.registerTool(name, toolConfig, handler);
  }

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
