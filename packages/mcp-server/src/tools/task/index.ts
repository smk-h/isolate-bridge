/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : MsgFerry
 * Date       : 2026/08/09
 * Version    : 0.0.1
 * Description: 任务族工具定义入口——只导出工具列表，注册由 server.ts 负责
 * ======================================================
 */

import { mcpDefineTool } from '../../tool-registry.js';
import type { ToolEntry } from '../../tool-registry.js';

import type { McpServerConfig } from '../../config.js';
import {
  submitSshTaskConfig,
  createSubmitSshTaskHandler,
} from './submit.js';
import {
  queryTaskStatusConfig,
  createQueryTaskStatusHandler,
} from './query.js';
import {
  cancelTaskConfig,
  createCancelTaskHandler,
} from './cancel.js';

/** 任务族工具列表（task_submit / task_query / task_cancel） */
export function createTaskTools(config: McpServerConfig, root: string): ToolEntry[] {
  return [
    mcpDefineTool('submit_ssh_task', submitSshTaskConfig, createSubmitSshTaskHandler(config, root)),
    mcpDefineTool('query_task_status', queryTaskStatusConfig, createQueryTaskStatusHandler(config, root)),
    mcpDefineTool('cancel_task', cancelTaskConfig, createCancelTaskHandler(config, root)),
  ];
}
