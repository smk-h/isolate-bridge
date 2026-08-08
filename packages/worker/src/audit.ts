/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : audit.ts
 * Author     : MsgFerry
 * Date       : 2026/08/07
 * Version    : 0.0.1
 * Description: 审计日志滚动文件——每条任务记录、保留 30 天、按 task_id 检索
 * ======================================================
 */

import { join } from 'node:path';
import { writeFile, readdir, readFile, unlink, stat, mkdir } from 'node:fs/promises';

import type { PolicyResult } from './policy.js';

/** 审计日志条目 */
export interface AuditEntry {
  task_id: string;
  cmd_summary: string;
  policy_result: PolicyResult;
  ssh_target: string | null;
  exit_code: number | null;
  duration_ms: number;
  cancelled: boolean;
  timestamp: number;                  // 毫秒 epoch 时间戳
  system_time: string;                // 系统时间戳（本地时区），格式 YYYY-MM-DD HH:MM:SS
}

/**
 * 格式化系统时间戳（本地时区）为 YYYY-MM-DD HH:MM:SS
 * @param ts - 毫秒 epoch 时间戳
 * @returns 形如 2026-08-08 12:30:45 的字符串
 */
export function formatSystemTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const LOG_SUFFIX = '.log';
const MAX_CMD_SUMMARY = 200;
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 30;

/** AuditLogger 占位主体，方法将在后续追加中补全 */
export class AuditLogger {
  private readonly logDir: string;
  private readonly maxFileSize: number;
  private readonly retentionDays: number;

  constructor(logDir: string, options?: { maxFileSize?: number; retentionDays?: number }) {
    this.logDir = logDir;
    this.maxFileSize = options?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.retentionDays = options?.retentionDays ?? DEFAULT_RETENTION_DAYS;
  }

  async log(entry: AuditEntry): Promise<void> {
    await mkdir(this.logDir, { recursive: true });
    const summary = entry.cmd_summary.slice(0, MAX_CMD_SUMMARY);
    // 写入时补充系统时间戳（YYYY-MM-DD HH:MM:SS），格式与 timestamp 一致，便于人工阅读
    const loggedEntry: AuditEntry = {
      ...entry,
      cmd_summary: summary,
      system_time: entry.system_time ?? formatSystemTime(entry.timestamp),
    };
    const line = JSON.stringify(loggedEntry) + '\n';
    const dateStr = new Date().toISOString().slice(0, 10);
    const basePath = join(this.logDir, `${dateStr}${LOG_SUFFIX}`);
    await this.appendWithRoll(basePath, line);
  }

  private async appendWithRoll(basePath: string, line: string): Promise<void> {
    let targetPath = basePath;
    let rollIndex = 1;
    try {
      const fileStat = await stat(basePath);
      while (fileStat.size + Buffer.byteLength(line) > this.maxFileSize) {
        targetPath = join(this.logDir, `${new Date().toISOString().slice(0, 10)}_${rollIndex}${LOG_SUFFIX}`);
        try {
          const rollStat = await stat(targetPath);
          if (rollStat.size + Buffer.byteLength(line) <= this.maxFileSize) {
            break;
          }
          rollIndex++;
        } catch {
          break;
        }
      }
    } catch {
      // base 不存在直接写
    }
    await writeFile(targetPath, line, { flag: 'a' });
  }

  async flush(): Promise<void> {}
  async close(): Promise<void> {}

  async searchByTaskId(taskId: string): Promise<AuditEntry[]> {
    let entries: string[];
    try {
      entries = await readdir(this.logDir);
    } catch {
      return [];
    }
    const results: AuditEntry[] = [];
    for (const name of entries) {
      if (!name.endsWith(LOG_SUFFIX)) {
        continue;
      }
      const content = await readFile(join(this.logDir, name), 'utf-8').catch(() => '');
      const lines = content.split('\n').filter((l) => l.trim());
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as AuditEntry;
          if (entry.task_id === taskId) {
            results.push(entry);
          }
        } catch {
          // 跳过非 JSON 行
        }
      }
    }
    return results;
  }

  async gc(): Promise<number> {
    const now = Date.now();
    const ttlMs = this.retentionDays * 86400 * 1000;
    let cleaned = 0;
    let entries: string[];
    try {
      entries = await readdir(this.logDir);
    } catch {
      return 0;
    }
    for (const name of entries) {
      if (!name.endsWith(LOG_SUFFIX)) {
        continue;
      }
      const filePath = join(this.logDir, name);
      try {
        const fileStat = await stat(filePath);
        if (now - fileStat.mtimeMs > ttlMs) {
          await unlink(filePath);
          cleaned++;
        }
      } catch {
        // 单文件清理失败忽略
      }
    }
    return cleaned;
  }
}
