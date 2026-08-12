/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : audit.test.ts
 * Author     : MsgFerry
 * Date       : 2026/08/07
 * Version    : 0.0.1
 * Description: audit 模块单元测试
 * ======================================================
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuditLogger, formatSystemTime } from '../src/log/index.js';
import type { AuditEntry } from '../src/log/index.js';

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    task_id: 'a1', cmd_summary: 'docker ps', policy_result: { allowed: true },
    ssh_target: null, exit_code: 0, duration_ms: 100, cancelled: false,
    timestamp: Date.now(), system_time: formatSystemTime(Date.now()), ...overrides,
  };
}

let logDir: string;

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), 'msgferry-audit-'));
});

afterEach(() => {
  rmSync(logDir, { recursive: true, force: true });
});

describe('AuditLogger log', () => {
  it('应写入当日日志文件', async () => {
    const logger = new AuditLogger(logDir);
    await logger.log(makeEntry());
    const dateStr = new Date().toISOString().slice(0, 10);
    assert.ok(existsSync(join(logDir, `${dateStr}.log`)));
  });

  it('cmd_summary 应截断到 200 字符', async () => {
    const logger = new AuditLogger(logDir);
    await logger.log(makeEntry({ cmd_summary: 'x'.repeat(300) }));
    const dateStr = new Date().toISOString().slice(0, 10);
    const content = readFileSync(join(logDir, `${dateStr}.log`), 'utf-8');
    const entry = JSON.parse(content.trim());
    assert.equal(entry.cmd_summary.length, 200);
  });

  it('应写入 system_time 字段，格式为 YYYY-MM-DD HH:MM:SS', async () => {
    const logger = new AuditLogger(logDir);
    const ts = Date.now();
    await logger.log(makeEntry({ timestamp: ts }));
    const dateStr = new Date().toISOString().slice(0, 10);
    const content = readFileSync(join(logDir, `${dateStr}.log`), 'utf-8');
    const entry = JSON.parse(content.trim());
    assert.match(entry.system_time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(entry.system_time, formatSystemTime(ts));
  });

  it('未提供 system_time 时应基于 timestamp 自动补齐', async () => {
    const logger = new AuditLogger(logDir);
    // 模拟旧调用方未提供 system_time：移除该字段后仍能自动补齐
    const entry = makeEntry();
    const { system_time: _omit, ...rest } = entry;
    void _omit;
    await logger.log(rest as AuditEntry);
    const dateStr = new Date().toISOString().slice(0, 10);
    const content = readFileSync(join(logDir, `${dateStr}.log`), 'utf-8');
    const entryOut = JSON.parse(content.trim());
    assert.match(entryOut.system_time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('formatSystemTime', () => {
  it('应输出本地时区 YYYY-MM-DD HH:MM:SS 格式', () => {
    const ts = new Date(2026, 7, 8, 9, 5, 7).getTime();
    assert.equal(formatSystemTime(ts), '2026-08-08 09:05:07');
  });

  it('月/日/时/分/秒应补零', () => {
    const ts = new Date(2026, 0, 3, 4, 6, 8).getTime();
    assert.equal(formatSystemTime(ts), '2026-01-03 04:06:08');
  });
});

describe('AuditLogger searchByTaskId', () => {
  it('应返回匹配 task_id 的条目', async () => {
    const logger = new AuditLogger(logDir);
    await logger.log(makeEntry({ task_id: 'find-me' }));
    await logger.log(makeEntry({ task_id: 'other' }));
    const results = await logger.searchByTaskId('find-me');
    assert.equal(results.length, 1);
    assert.equal(results[0].task_id, 'find-me');
  });

  it('无匹配应返回空数组', async () => {
    const logger = new AuditLogger(logDir);
    await logger.log(makeEntry({ task_id: 'a1' }));
    assert.equal((await logger.searchByTaskId('nonexistent')).length, 0);
  });
});

describe('AuditLogger gc', () => {
  it('应清理过期日志文件', async () => {
    const logger = new AuditLogger(logDir, { retentionDays: 1 });
    const oldFile = join(logDir, '2020-01-01.log');
    writeFileSync(oldFile, '{"test":1}\n');
    const oldTime = new Date(Date.now() - 31 * 86400 * 1000);
    utimesSync(oldFile, oldTime, oldTime);
    const cleaned = await logger.gc();
    assert.ok(cleaned >= 1);
    assert.ok(!existsSync(oldFile));
  });
});
