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

/**
 * 审计日志滚动写入器
 * 每条任务一条 JSON 记录，按日期分文件，超限自动滚动（_1/_2…），
 * 按 task_id 检索，保留 retentionDays 天后由 gc 清理。
 */
export class AuditLogger {
  private readonly logDir: string;
  private readonly maxFileSize: number;
  private readonly retentionDays: number;

  /**
   * 构造审计日志器
   * @param logDir - 日志目录（不存在会创建）
   * @param options - 可选配置：maxFileSize=单文件字节上限，retentionDays=保留天数
   */
  constructor(logDir: string, options?: { maxFileSize?: number; retentionDays?: number }) {
    this.logDir = logDir;
    this.maxFileSize = options?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.retentionDays = options?.retentionDays ?? DEFAULT_RETENTION_DAYS;
  }

  /**
   * 追加一条审计日志：截断 cmd_summary、补齐系统时间戳，写入当日文件（自动滚动）
   * @param entry - 审计条目
   */
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

  /**
   * 追加写入并自动滚动：当日文件超限时改用 <date>_<index>.log 继续写
   * @param basePath - 当日日志文件路径
   * @param line - 待写入的单行 JSON
   */
  private async appendWithRoll(basePath: string, line: string): Promise<void> {
    let targetPath = basePath;
    let rollIndex = 1;
    try {
      // 当日文件存在时才需要判断是否超限
      const fileStat = await stat(basePath);
      // 若当日文件已满，则依次尝试 _1/_2/… 后缀的滚动文件，找到首个未满的写入
      while (fileStat.size + Buffer.byteLength(line) > this.maxFileSize) {
        targetPath = join(this.logDir, `${new Date().toISOString().slice(0, 10)}_${rollIndex}${LOG_SUFFIX}`);
        try {
          const rollStat = await stat(targetPath);
          // 滚动文件未满则停在此文件；已满则继续探测下一个序号
          if (rollStat.size + Buffer.byteLength(line) <= this.maxFileSize) {
            break;
          }
          rollIndex++;
        } catch {
          // 该序号文件不存在（全新滚动文件），直接选用并退出
          break;
        }
      }
    } catch {
      // base 不存在直接写
    }
    await writeFile(targetPath, line, { flag: 'a' });
  }

  /** 刷新缓冲（当前实现为同步追加写入，无额外缓冲，预留接口） */
  async flush(): Promise<void> {}
  /** 关闭日志器（当前实现无待回收资源，预留接口） */
  async close(): Promise<void> {}

  /**
   * 按 task_id 检索全部匹配的审计记录（跨文件、跨行扫描）
   * @param taskId - 任务唯一标识
   * @returns 匹配的审计条目列表
   */
  async searchByTaskId(taskId: string): Promise<AuditEntry[]> {
    let entries: string[];
    try {
      entries = await readdir(this.logDir);
    } catch {
      return [];
    }
    const results: AuditEntry[] = [];
    // 逐个日志文件扫描匹配 task_id
    for (const name of entries) {
      // 只处理 .log 文件
      if (!name.endsWith(LOG_SUFFIX)) {
        continue;
      }
      const content = await readFile(join(this.logDir, name), 'utf-8').catch(() => '');
      // 按行解析 JSON 记录并匹配任务 id
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

  /**
   * 清理超过保留期的旧日志文件
   * @returns 清理的文件数
   */
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
      // 只处理 .log 文件
      if (!name.endsWith(LOG_SUFFIX)) {
        continue;
      }
      const filePath = join(this.logDir, name);
      try {
        // 超过保留期的旧日志文件直接删除
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
