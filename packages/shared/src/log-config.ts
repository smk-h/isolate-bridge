/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : log-config.ts
 * Author     : MsgFerry
 * Date       : 2026/08/09
 * Version    : 0.0.1
 * Description: 业务日志路径解析——LOG_SAVE 开关读取 + LOG_DIR → 绝对路径
 *             （绝对原样 / 相对基于 hgfs_root / 缺省 <hgfs_root>/logs/mcp-server）
 * ======================================================
 */

import { isAbsolute, join } from 'node:path';

import { LOG_DIRS } from './constants.js';

/**
 * 判断业务日志是否启用
 * 与参考项目 embedded-mcp-toolkit 一致：LOG_SAVE 取值为 "1" 或 "true" 时启用
 * @param env - 进程环境变量
 * @returns 启用返回 true
 */
export function isLogSaveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const save = env.LOG_SAVE;
  return save === '1' || save === 'true';
}

/**
 * 解析业务日志目录为绝对路径
 * - LOG_DIR 为绝对路径 → 原样使用（如外网侧 Windows 路径、内网 /var/log/msgferry）
 * - LOG_DIR 为相对路径 → 基于 hgfs_root 解析为绝对路径
 * - LOG_DIR 未设置 → 使用默认 <hgfs_root>/logs/mcp-server
 *   （hgfs_root 未配置时回退参考项目默认 ./log，保证 Logger 可独立使用）
 * @param opts - 解析选项
 * @returns 解析后的绝对日志目录
 */
export function resolveLogDir(opts: {
  hgfsRoot?: string;
  logDir?: string;
  defaultRel?: string;
}): string {
  const { hgfsRoot, logDir, defaultRel } = opts;
  const rel = defaultRel ?? LOG_DIRS.mcpServer;

  if (logDir !== undefined && logDir !== '') {
    if (isAbsolute(logDir)) {
      return logDir;
    }
    // 相对路径：基于 hgfs_root 解析；未提供 hgfs_root 时回退 cwd
    return join(hgfsRoot ?? process.cwd(), logDir);
  }

  // 未设置 LOG_DIR：基于 hgfs_root 的默认相对路径（logs/mcp-server）；未提供 hgfs_root 时回退 ./log
  return join(hgfsRoot ?? '.', rel);
}
