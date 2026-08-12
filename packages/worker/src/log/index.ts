/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : index.ts
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: 日志模块入口——统一 re-export 业务日志与审计日志
 *   业务日志（logger）与审计日志（AuditLogger）同属日志相关，收敛到 log/ 目录。
 * ======================================================
 */

export { logger } from './logger.js';
export { AuditLogger, formatSystemTime } from './audit.js';
export type { AuditEntry } from './audit.js';
