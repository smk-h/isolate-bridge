/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : path.ts
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: 路径工具——家目录占位符（~ / $HOME）展开为绝对路径
 * ======================================================
 */

import { homedir } from 'node:os';

/**
 * 展开路径中的家目录占位符（`~` 与 `$HOME`）为真实家目录路径
 *
 * 跨平台说明：
 * - Windows 原生环境的 `$HOME` 变量通常不存在（用的是 `USERPROFILE`），
 *   因此这里不依赖 `process.env.HOME`，而是统一用 `node:os` 的 `homedir()`，
 *   它在 Windows 优先取 `USERPROFILE`、在 Linux/macOS 取 `HOME`，跨平台可靠。
 * - 支持两种写法：
 *   - `~/.msgferry/vm_share`      → `${homedir}/.msgferry/vm_share`
 *   - `$HOME/.msgferry/vm_share`  → `${homedir}/.msgferry/vm_share`
 *   兼容 `/$HOME/...`（用户可能多写一个前导 `/`）的写法。
 * - 不含占位符时原样返回。
 *
 * @param raw - 配置原始值（如 `$HOME/.msgferry/vm_share`）
 * @returns 展开后的绝对路径
 */
export function expandHomeDir(raw: string): string {
  if (!raw) {
    return raw;
  }
  const home = homedir();
  if (!home) {
    return raw;
  }
  // 先处理 `~` 前缀，再处理 `$HOME`（兼容可选的前导 `/`）
  let expanded = raw;
  if (expanded === '~' || expanded.startsWith('~/')) {
    expanded = home + expanded.slice(1);
  }
  expanded = expanded.replace(/^\/?\$HOME\//, `${home}/`).replace(/^\$HOME$/, home);
  return expanded;
}