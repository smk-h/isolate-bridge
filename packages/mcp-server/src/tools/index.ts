/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : MsgFerry
 * Date       : 2026/08/09
 * Version    : 0.0.1
 * Description: 全部工具的统一聚合入口——只导出工具列表，注册由 server.ts 负责
 * ======================================================
 */

import type { ToolEntry } from '../tool-registry.js';

import type { McpServerConfig } from '../config.js';
import { createTaskTools } from './task/index.js';
import { createHealthTools } from './health/index.js';

/**
 * 全部 MCP 工具列表。
 * 新增工具族时：建目录 + 在下方数组加一行，server.ts 永不改动。
 * @param config - MCP Server 配置
 * @param root - HGFS 共享根目录
 * @returns 聚合后的 ToolEntry 数组
 */
export function createAllTools(config: McpServerConfig, root: string): ToolEntry[] {
  return [
    ...createTaskTools(config, root),
    ...createHealthTools(root),
  ];
}
