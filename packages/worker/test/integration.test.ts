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
import { initExchangeDirs, listOutbound, readOutboundTask, writeResultExchange, checkCancelledExchange, writeCancelledResultExchange } from '../src/queue.js';
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
  auditLogger = new AuditLogger(join(root, 'logs', 'worker'));
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
  const cmdResult = await executor.execute(task.cmd, task.timeout_sec);
  task.stdout = cmdResult.stdout;
  task.stderr = cmdResult.stderr;
  task.stdout_size = Buffer.byteLength(cmdResult.stdout, 'utf-8');
  task.stderr_size = Buffer.byteLength(cmdResult.stderr, 'utf-8');
  task.exit_code = cmdResult.exit_code;
  task.error_msg = cmdResult.stderr || null;
  task.end_time = Date.now();
  if (await checkCancelled(root, task.task_id)) {
    task.status = 'cancelled';
    await writeCancelledResult(root, task);
    await logAudit(task, policyResult, task.end_time);
    return;
  }
  task.status = cmdResult.exit_code === 0 ? 'completed' : 'failed';
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

describe('集成：exchange 模式任务全流程', () => {
  it('outbound 领取 -> 结果写回 inbound/result_<id>.json', async () => {
    await initExchangeDirs(root);
    const task = makeTask({ task_id: 'ex-1' });
    writeFileSync(join(root, 'outbound', 'ex-1.json'), JSON.stringify(task));

    const outbound = await listOutbound(root);
    assert.equal(outbound[0], 'ex-1');
    const locked = await acquireLock(root, 'ex-1', 400);
    assert.equal(locked, true);
    const readed = await readOutboundTask(root, 'ex-1');

    // 模拟 processTask 的 exchange 分支：transition 从 outbound 领取
    await transitionToProcessing(root, readed, 400, 'outbound');
    assert.ok(!existsSync(join(root, 'outbound', 'ex-1.json')));

    const cmdResult = await executor.execute(readed.cmd, readed.timeout_sec);
    readed.stdout = cmdResult.stdout;
    readed.stderr = cmdResult.stderr;
    readed.stdout_size = Buffer.byteLength(cmdResult.stdout, 'utf-8');
    readed.stderr_size = Buffer.byteLength(cmdResult.stderr, 'utf-8');
    readed.exit_code = cmdResult.exit_code;
    readed.end_time = Date.now();
    readed.status = 'completed';
    await writeResultExchange(root, readed, 65536);

    assert.ok(existsSync(join(root, 'inbound', 'result_ex-1.json')));
    const result = JSON.parse(readFileSync(join(root, 'inbound', 'result_ex-1.json'), 'utf-8'));
    assert.equal(result.status, 'completed');
    assert.ok(result.stdout.includes('[mock]'));
    assert.equal(result.exit_code, 0);
  });

  it('outbound 取消标记 -> 结果写回 inbound/result_<id>.result', async () => {
    await initExchangeDirs(root);
    const task = makeTask({ task_id: 'ex-cancel-1' });
    writeFileSync(join(root, 'outbound', 'ex-cancel-1.json'), JSON.stringify(task));
    writeFileSync(join(root, 'outbound', 'cancel_ex-cancel-1.marker'), '');

    assert.equal(await checkCancelledExchange(root, 'ex-cancel-1'), true);
    await acquireLock(root, 'ex-cancel-1', 500);
    const readed = await readOutboundTask(root, 'ex-cancel-1');
    await transitionToProcessing(root, readed, 500, 'outbound');
    readed.status = 'cancelled';
    await writeCancelledResultExchange(root, readed);

    assert.ok(existsSync(join(root, 'inbound', 'result_ex-cancel-1.result')));
    const result = JSON.parse(readFileSync(join(root, 'inbound', 'result_ex-cancel-1.result'), 'utf-8'));
    assert.equal(result.status, 'cancelled');
  });
});
