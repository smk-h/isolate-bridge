/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : logger.ts
 * Author     : MsgFerry
 * Date       : 2026/08/09
 * Version    : 0.0.1
 * Description: worker 侧业务日志单例——未设置 LOG_DIR 时默认 <hgfs_root>/logs/worker
 * ======================================================
 */

import { Logger, LOG_DIRS } from '@smai-kit/msgferry-shared';

/** worker 业务日志：LOG_DIR（绝对/相对基于 hgfs_root）> 默认 <hgfs_root>/logs/worker */
export const logger = new Logger(LOG_DIRS.worker, 'Worker');
