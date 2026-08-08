/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : main.ts
 * Author     : MsgFerry
 * Date       : 2026/08/08
 * Version    : 0.0.1
 * Description: MCP Server 主进程入口——组装模块、连接 transport、信号处理、优雅退出
 * ======================================================
 */

import { parseConfig, validateConfig } from './config.js';
import { initQueueDirs } from './queue.js';
import { createMcpServer, startServer } from './server.js';
import type { McpServer } from '@modelcontextprotocol/server';
import { pathToFileURL } from 'node:url';

/**
 * 优雅退出：关闭 server 后退出进程
 * @param server - McpServer 实例
 */
async function gracefulShutdown(server: McpServer): Promise<void> {
  try {
    await server.close();
  } catch (e) {
    console.error('[mcp-server] error during shutdown:', e);
  }
  process.exit(0);
}

/**
 * 主函数：解析配置 → 初始化队列 → 创建 server → 连接 transport
 */
export async function main(): Promise<void> {
  const config = parseConfig(process.argv, process.env);
  validateConfig(config);

  console.error('[mcp-server] starting...');

  // 初始化 HGFS 队列子目录
  await initQueueDirs(config.hgfs_root);

  // 创建 McpServer 实例并注册工具
  const server = createMcpServer(config, config.hgfs_root);

  // 连接 stdio transport，开始监听 Claude Code 请求
  await startServer(server);

  console.error(`[mcp-server] ready, hgfs_root=${config.hgfs_root}`);

  // 信号处理：收到 SIGINT/SIGTERM 后优雅退出
  process.on('SIGINT', () => {
    void gracefulShutdown(server);
  });
  process.on('SIGTERM', () => {
    void gracefulShutdown(server);
  });
}

// 作为主模块运行时自动调用 main
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[mcp-server] fatal:', err);
    process.exit(1);
  });
}
