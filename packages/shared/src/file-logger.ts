/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : file-logger.ts
 * Author     : MsgFerry
 * Date       : 2026/08/13
 * Version    : 0.0.1
 * Description: 原始数据文件日志记录器（FileLogger）
 *   将 SSH shell 会话的原始输入输出按行写入日志文件，每行附时间戳。
 *   行缓冲区确保跨 chunk 到达的数据合并为完整行后再输出，同一行只有一个时间戳。
 *   逻辑与参考项目 embedded-mcp-toolkit 的 src/shared/file-logger.ts 完全一致。
 * ======================================================
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  statSync,
  type WriteStream,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { beijingFields, fileTimestamp, logTimestamp } from './timestamp.js';
import { sanitizeLine } from './terminal-sanitizer.js';

/**
 * 原始数据文件日志记录器
 *
 * 将接收到的原始数据按行写入日志文件，每行附时间戳。
 * 行缓冲区确保跨 chunk 到达的数据合并为完整行后再输出，
 * 同一行只有一个时间戳（该行实际到达完成的时刻）。
 *
 * 供 SSH 交互式 shell 会话（SshSession / MockShellSession）复用。
 */
export class FileLogger {
  /** 日志文件写入流，enable 时创建，disable 时关闭 */
  private logStream: WriteStream | null = null;
  /** 行缓冲区：缓存不完整行，遇换行符时整行输出 */
  private logLineBuf = '';

  /**
   * 启用文件日志
   *
   * 创建日志目录（如不存在），打开文件写入流。
   * 若文件为新文件或空文件，先写入统一头部。
   *
   * @param logPath 日志文件完整路径
   */
  enable(logPath: string): void {
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const isNew = !existsSync(logPath) || statSync(logPath).size === 0;
    this.logStream = createWriteStream(logPath, { flags: 'a' });
    if (isNew) {
      const f = beijingFields();
      const ts = `${f.y}.${f.m}.${f.d} ${f.hh}:${f.mm}:${f.ss}`;
      this.logStream.write('\uFEFF');
      this.logStream.write(
        `=~=~=~=~=~=~=~=~=~=~=~= Mcp Server log ${ts} =~=~=~=~=~=~=~=~=~=~=~=\n`,
      );
    }
  }

  /**
   * 为 SSH shell 会话启用文件日志
   *
   * 日志落在 {rootDir}/{deviceName}/ssh_{sessionId}_{fileTimestamp()}.log。
   * 会话开启时调用，返回实际创建的日志文件完整路径；未启用时返回 undefined。
   *
   * @param rootDir    SSH shell 原始日志根目录（如 <hgfs_root>/logs/ssh-shell）
   * @param deviceName 设备名（normalize 后，如 default / board-100）
   * @param sessionId  会话 id（如 ssh_1）
   * @returns 实际创建的日志文件完整路径；文件日志未启用时返回 undefined
   */
  enableForShell(
    rootDir: string,
    deviceName: string,
    sessionId: string,
  ): string | undefined {
    const absDir = resolve(rootDir);
    // 文件名：ssh_<id>_<YYYY-MM-DD_HHMMSS>.log（sessionId 形如 ssh_1）
    const fileName = `${sessionId}_${fileTimestamp()}.log`;
    const logPath = join(absDir, deviceName, fileName);
    this.enable(logPath);
    return logPath;
  }

  /**
   * 关闭文件日志
   *
   * 将行缓冲区中剩余的不完整行写入文件，然后关闭写流。
   * 未启用时调用无副作用。
   */
  disable(): void {
    if (this.logStream) {
      if (this.logLineBuf) {
        this.logStream.write(`${logTimestamp()} ${this.logLineBuf}\n`);
        this.logLineBuf = '';
      }
      this.logStream.end();
      this.logStream = null;
    }
  }

  /**
   * 写入原始数据文本
   *
   * 将接收到的 chunk 按换行符分割，完整行附时间戳写入文件，
   * 不完整行暂存到行缓冲区等待下一个 chunk 拼接。
   * 未启用时无副作用。
   *
   * @param text 接收到的原始数据文本
   */
  write(text: string): void {
    if (!this.logStream) return;
    this.logLineBuf += text;
    const lines = this.logLineBuf.split('\n');
    this.logLineBuf = lines.pop() ?? '';
    for (const line of lines) {
      this.logStream.write(`${logTimestamp()} ${sanitizeLine(line)}\n`);
    }
  }
}
