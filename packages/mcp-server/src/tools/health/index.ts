/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : MsgFerry
 * Date       : 2026/08/09
 * Version    : 0.0.1
 * Description: 健康检查族工具定义入口——只导出工具列表，注册由 server.ts 负责
 * ======================================================
 */

import { mcpDefineTool } from '../../tool-registry.js';
import type { ToolEntry } from '../../tool-registry.js';

import type { McpServerConfig } from '../../config.js';
import {
  checkBridgeHealthConfig,
  createCheckBridgeHealthHandler,
} from './check.js';

/** 健康检查族工具列表（bridge_health） */
export function createHealthTools(config: McpServerConfig, root: string): ToolEntry[] {
  return [
    mcpDefineTool('check_bridge_health', checkBridgeHealthConfig, createCheckBridgeHealthHandler(config, root)),
  ];
}
