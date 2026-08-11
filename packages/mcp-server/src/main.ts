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
import { initQueueDirs, initExchangeDirs } from './queue.js';
import { isExchangeMode } from './sync.js';
import { createMcpServer, startServer } from './server.js';
import type { McpServer } from '@modelcontextprotocol/server';
import { pathToFileURL } from 'node:url';
import { logger } from '@smai-kit/msgferry-shared';
import { resolveLogDir } from '@smai-kit/msgferry-shared';

/**
 * 优雅退出：关闭 server 后退出进程
 * @param server - McpServer 实例
 */
async function gracefulShutdown(server: McpServer): Promise<void> {
  try {
    await server.close();
  } catch (e) {
    logger.error('[mcp-server] error during shutdown:', e);
  }
  logger.info('[mcp-server] shutdown complete');
  process.exit(0);
}

/**
 * 主函数：解析配置 → 初始化队列 → 创建 server → 连接 transport
 */
export async function main(): Promise<void> {
  const config = parseConfig(process.argv, process.env);
  validateConfig(config);

  logger.info(`MCP server starting... cwd: ${process.cwd()}`);
  logger.info(`MCP server hgfs_root: ${config.hgfs_root}`);
  logger.info(`MCP server log_dir: ${resolveLogDir({ hgfsRoot: config.hgfs_root, logDir: process.env.LOG_DIR })}`);
  logger.info(`MCP server sync_mode: ${config.sync_mode}`);

  // 初始化 HGFS 队列子目录（交换模式额外初始化 outbound/inbound 单向信箱）
  await initQueueDirs(config.hgfs_root);
  if (isExchangeMode(config)) {
    await initExchangeDirs(config.hgfs_root);
  }

  // 创建 McpServer 实例并注册工具
  const server = createMcpServer(config, config.hgfs_root);

  // 连接 stdio transport，开始监听 Claude Code 请求
  await startServer(server);

  logger.info(`MCP server ready, hgfs_root=${config.hgfs_root}`);

  // 信号处理：收到 SIGINT/SIGTERM 后优雅退出
  process.on('SIGINT', () => {
    logger.warn('[mcp-server] received SIGINT, shutting down...');
    void gracefulShutdown(server);
  });
  process.on('SIGTERM', () => {
    logger.warn('[mcp-server] received SIGTERM, shutting down...');
    void gracefulShutdown(server);
  });
}

// 作为主模块运行时自动调用 main
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    logger.error('[mcp-server] fatal:', err);
    process.exit(1);
  });
}
