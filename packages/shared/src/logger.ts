/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : logger.ts
 * Author     : MsgFerry
 * Date       : 2026/08/09
 * Version    : 0.0.1
 * Description: 业务日志模块——LOG_SAVE / LOG_DIR 控制文件写入，info/error/warn/block
 *             格式与参考项目 embedded-mcp-toolkit 的 src/shared/logger.ts 完全一致，
 *             日志目录缺省 <local_root>/logs/mcp-server（可由 LOG_DIR 自定义）
 * ======================================================
 */

import { mkdirSync, appendFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { beijingFields, fileTimestamp, logTimestamp } from './timestamp.js';
import { sanitizeLine } from './terminal-sanitizer.js';
import { isLogSaveEnabled, resolveLogDir } from './log-config.js';

/**
 * 业务日志记录器
 * 提供 info / error / warn / block 方法，调用时同时写入日志文件和 stderr。
 * 日志文件在首次写入时延迟创建，避免依赖模块加载时的环境变量时序。
 */
export class Logger {
  private logFile: string | null = null;
  private initialized = false;

  /**
   * @param defaultRel - 未设置 LOG_DIR 时的默认相对日志目录
   *                     （基于 local_root 解析），缺省取 LOG_DIRS.mcpServer
   * @param label      - 日志文件头部标识（默认 "Mcp Server"，worker 侧传 "Worker"）
   */
  constructor(
    private readonly defaultRel?: string,
    private readonly label: string = 'Mcp Server',
  ) {}

  /** 延迟初始化（首次写入时触发，确保 LOG_SAVE / LOG_DIR 已设置） */
  private ensureInit(): void {
    if (this.initialized) return;
    this.initialized = true;

    if (!isLogSaveEnabled()) return;

    // 目录解析：LOG_DIR（绝对原样 / 相对基于 local_root）> 默认 <local_root>/logs/<label>
    const dir = resolveLogDir({
      localRoot: process.env.MSGFERRY_LOCAL_ROOT,
      logDir: process.env.LOG_DIR,
      defaultRel: this.defaultRel,
    });
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.logFile = join(dir, `${fileTimestamp()}.log`);

    // 新文件或空文件时写入统一头部
    const isNew =
      !existsSync(this.logFile) || statSync(this.logFile).size === 0;
    if (isNew) {
      const f = beijingFields();
      const ts = `${f.y}.${f.m}.${f.d} ${f.hh}:${f.mm}:${f.ss}`;
      appendFileSync(
        this.logFile,
        `=~=~=~=~=~=~=~=~=~=~=~= ${this.label} log ${ts} =~=~=~=~=~=~=~=~=~=~=~=\n`,
      );
    }
  }

  /** 安全写入 stderr：管道已断（MCP 客户端掉线）时静默吞掉，避免 EPIPE 死循环 */
  private safeStderr(msg: string): void {
    try {
      process.stderr.write(msg);
    } catch {
      /* stderr 管道断开，忽略 */
    }
  }

  /** 写入一行到日志文件 */
  private write(level: string, message: string): void {
    this.ensureInit();
    if (!this.logFile) return;
    try {
      const line = `${logTimestamp()} [${level}] ${message}\n`;
      const safe = sanitizeLine(line);
      appendFileSync(this.logFile, Buffer.from(safe, 'utf8'));
    } catch {
      /* 静默失败，不影响主流程 */
    }
  }

  /** 序列化参数为字符串 */
  private format(args: unknown[]): string {
    return args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
  }

  /** 普通信息日志（终端输出到 stderr，避免污染 MCP stdio 协议通道） */
  info(...args: unknown[]): void {
    const msg = this.format(args);
    this.write('INFO', msg);
    this.safeStderr(`${msg}\n`);
  }

  /** 错误日志 */
  error(...args: unknown[]): void {
    const msg = this.format(args);
    this.write('ERROR', msg);
    this.safeStderr(`${msg}\n`);
  }

  /** 警告日志 */
  warn(...args: unknown[]): void {
    const msg = this.format(args);
    this.write('WARN', msg);
    this.safeStderr(`${msg}\n`);
  }

  /**
   * 写入带分隔符的内容块到日志文件和终端
   *
   * 格式:
   *   [YYYY-MM-DD HH:mm:ss] [LEVEL] [context] 描述::
   *   ----------------------------
   *       缩进 4 空格的内容行
   *   ----------------------------
   *
   * @param level       日志级别 (INFO, WARN, ERROR)
   * @param context     上下文标识（如 "policy"、"task"）
   * @param description 块描述/标签
   * @param content     块内容
   * @param maxLines    最大保留行数，正数=截断省略中间行，-1=全部显示（默认 -1）
   */
  block(
    level: string,
    context: string,
    description: string,
    content: string,
    maxLines = -1,
  ): void {
    this.ensureInit();
    if (!content) return;

    let display = content;
    if (maxLines > 0) {
      const lines = content.split(/\r?\n/);
      if (lines.length > maxLines) {
        const half = Math.floor(maxLines / 2);
        const head = lines.slice(0, half).join('\n');
        const tail = lines.slice(-half).join('\n');
        display = `${head}\n...[${lines.length - maxLines} lines omitted]...\n${tail}`;
      }
    }

    const parts: string[] = [];
    const ctxTag = context ? `[${context}] ` : '';
    parts.push(`${logTimestamp()} [${level}] ${ctxTag}${description}:`);
    parts.push('----------------------------');
    for (const line of display.split('\n')) {
      parts.push(`    ${line}`);
    }
    parts.push('----------------------------');

    if (this.logFile) {
      try {
        const safe = sanitizeLine(parts.join('\n') + '\n');
        appendFileSync(this.logFile, Buffer.from(safe, 'utf8'));
      } catch {
        /* 静默失败，不影响主流程 */
      }
    }

    const indented = display
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
    this.safeStderr(
      `${description}:\n----------------------------\n${indented}\n----------------------------\n`,
    );
  }

  /** 是否启用了文件保存 */
  get isEnabled(): boolean {
    return this.logFile !== null;
  }
}

/** 全局单例 logger */
export const logger = new Logger();
