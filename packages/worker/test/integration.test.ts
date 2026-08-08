/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : integration.test.ts
 * Author     : MsgFerry
 * Date       : 2026/08/07
 * Version    : 0.0.1
 * Description: 端到端集成测试
 * ======================================================
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initQueueDirs, listPending, acquireLock, readTask } from '../src/queue.js';
import { transitionToProcessing, writeResult, checkCancelled, writeCancelledResult } from '../src/queue.js';
import { loadPolicy, checkCommand } from '../src/policy.js';
import { MockSshExecutor } from '../src/executor.js';
import { AuditLogger, formatSystemTime } from '../src/audit.js';
import type { AuditEntry } from '../src/audit.js';
import type { CommandTask } from '@smai-kit/msgferry-shared';

function makeTask(overrides: Partial<CommandTask> = {}): CommandTask {
  return {
    kind: 'command', task_id: 'it-1', batch_id: null, depends_on: [],
    cmd: 'docker ps', timeout_sec: 30, submit_time: Date.now(),
    start_time: 0, end_time: 0, stdout: '', stderr: '', stdout_size: 0,
    stderr_size: 0, truncated: false, stdout_overflow_path: null,
    stderr_overflow_path: null, max_inline_bytes: 65536, exit_code: null,
    error_msg: null, status: 'pending', worker_pid: null, policy_blocked: false,
    ...overrides,
  };
}

let root: string;
let executor: MockSshExecutor;
let auditLogger: AuditLogger;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'msgferry-it-'));
  await initQueueDirs(root);
  executor = new MockSshExecutor();
  auditLogger = new AuditLogger(join(root, 'logs'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function processTask(task: CommandTask, pid: number): Promise<void> {
  const policyRule = await loadPolicy(join(root, 'policy', 'policy.json'));
  await transitionToProcessing(root, task, pid);
  const policyResult = checkCommand(policyRule, task.cmd);
  if (!policyResult.allowed) {
    task.status = 'failed';
    task.policy_blocked = true;
    task.error_msg = 'blocked_by_policy';
    task.end_time = Date.now();
    await writeResult(root, task, 65536);
    await logAudit(task, policyResult, task.end_time);
    return;
  }
  const sshResult = await executor.execute(task.cmd, task.timeout_sec);
  task.stdout = sshResult.stdout;
  task.stderr = sshResult.stderr;
  task.stdout_size = Buffer.byteLength(sshResult.stdout, 'utf-8');
  task.stderr_size = Buffer.byteLength(sshResult.stderr, 'utf-8');
  task.exit_code = sshResult.exit_code;
  task.error_msg = sshResult.stderr || null;
  task.end_time = Date.now();
  if (await checkCancelled(root, task.task_id)) {
    task.status = 'cancelled';
    await writeCancelledResult(root, task);
    await logAudit(task, policyResult, task.end_time);
    return;
  }
  task.status = sshResult.exit_code === 0 ? 'completed' : 'failed';
  await writeResult(root, task, 65536);
  await logAudit(task, policyResult, task.end_time);
}

/** 记录审计日志 */
async function logAudit(task: CommandTask, policyResult: { allowed: boolean; reason?: string }, endTime: number): Promise<void> {
  const now = Date.now();
  const entry: AuditEntry = {
    task_id: task.task_id,
    cmd_summary: task.cmd.slice(0, 200),
    policy_result: policyResult as AuditEntry['policy_result'],
    ssh_target: null,
    exit_code: task.exit_code,
    duration_ms: endTime - task.start_time,
    cancelled: task.status === 'cancelled',
    timestamp: now,
    system_time: formatSystemTime(now),
  };
  await auditLogger.log(entry);
}

describe('集成：正常任务全流程', () => {
  it('pending -> processing -> completed', async () => {
    const task = makeTask({ task_id: 'normal-1' });
    writeFileSync(join(root, 'pending', 'normal-1.json'), JSON.stringify(task));
    const pending = await listPending(root);
    assert.equal(pending[0], 'normal-1');
    const locked = await acquireLock(root, 'normal-1', 100);
    assert.equal(locked, true);
    const readed = await readTask(root, 'normal-1');
    await processTask(readed, 100);
    assert.ok(existsSync(join(root, 'completed', 'normal-1.json')));
    const result = JSON.parse(readFileSync(join(root, 'completed', 'normal-1.json'), 'utf-8'));
    assert.ok(result.stdout.includes('[mock]'));
    assert.equal(result.exit_code, 0);
    assert.equal(result.status, 'completed');
  });
});

describe('集成：策略拦截', () => {
  it('rm -rf / 应进 failed 且 policy_blocked', async () => {
    const task = makeTask({ task_id: 'block-1', cmd: 'rm -rf /' });
    writeFileSync(join(root, 'pending', 'block-1.json'), JSON.stringify(task));
    await acquireLock(root, 'block-1', 200);
    const readed = await readTask(root, 'block-1');
    await processTask(readed, 200);
    assert.ok(existsSync(join(root, 'failed', 'block-1.json')));
    const result = JSON.parse(readFileSync(join(root, 'failed', 'block-1.json'), 'utf-8'));
    assert.equal(result.policy_blocked, true);
    assert.equal(result.error_msg, 'blocked_by_policy');
    assert.equal(result.status, 'failed');
  });
});

describe('集成：取消回收', () => {
  it('已取消任务应回写到 cancelled/<id>.result', async () => {
    const task = makeTask({ task_id: 'cancel-1' });
    writeFileSync(join(root, 'pending', 'cancel-1.json'), JSON.stringify(task));
    writeFileSync(join(root, 'cancelled', 'cancel-1'), '');
    await acquireLock(root, 'cancel-1', 300);
    const readed = await readTask(root, 'cancel-1');
    await processTask(readed, 300);
    assert.ok(existsSync(join(root, 'cancelled', 'cancel-1.result')));
    assert.ok(!existsSync(join(root, 'completed', 'cancel-1.json')));
    const result = JSON.parse(readFileSync(join(root, 'cancelled', 'cancel-1.result'), 'utf-8'));
    assert.equal(result.status, 'cancelled');
  });
});
