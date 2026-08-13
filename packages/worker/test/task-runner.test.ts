/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : task-runner.test.ts
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: task-runner 处理流单测——聚焦执行异常时任务不被静默丢弃
 * ======================================================
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  initQueueDirs,
  acquireLock,
  readTask,
  initExchangeDirs,
  readOutboundTask,
  createQueueStrategy,
} from '../src/queue/index.js';
import type { QueueModeStrategy } from '../src/queue/index.js';
import { loadPolicy } from '../src/policy/index.js';
import type { PolicyRule } from '../src/policy/index.js';
import type { CmdExecutor, CmdResult } from '../src/executor/index.js';
import { AuditLogger } from '../src/log/index.js';
import type { WorkerConfig } from '../src/config/index.js';
import { processTask } from '../src/task-runner.js';
import type { CommandTask } from '@smai-kit/msgferry-shared';
import { formatBeijingTimestamp, taskFileName } from '@smai-kit/msgferry-shared';

/** 总是抛错的执行器，模拟设备离线/建连失败 */
class ThrowingExecutor implements CmdExecutor {
  async execute(): Promise<CmdResult> {
    throw new Error('connect timeout after 10000ms');
  }
}

function makeTask(overrides: Partial<CommandTask> = {}): CommandTask {
  return {
    kind: 'command', task_id: 'tr-test-0001', batch_id: null, depends_on: [],
    cmd: 'docker ps', timeout_sec: 30, submit_time: formatBeijingTimestamp(Date.now()),
    start_time: '', end_time: '', stdout: '', stderr: '', stdout_size: 0,
    stderr_size: 0, truncated: false, stdout_overflow_path: null,
    stderr_overflow_path: null, max_inline_bytes: 65536, exit_code: null,
    error_msg: null, status: 'pending', worker_pid: null, policy_blocked: false,
    ...overrides,
  };
}

let root: string;
let auditLogger: AuditLogger;
let strategy: QueueModeStrategy;
let policyRule: PolicyRule;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'msgferry-tr-'));
  await initQueueDirs(root);
  auditLogger = new AuditLogger(join(root, 'logs', 'worker'));
  strategy = createQueueStrategy('shared');
  policyRule = await loadPolicy(join(root, 'policy', 'policy.json'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeConfig(queueMode: 'shared' | 'exchange'): WorkerConfig {
  return {
    hgfs_root: root,
    queue_mode: queueMode,
    executor_type: 'mock',
    exec_mode: 'command',
    devices: {},
    ssh_config: null,
    audit_log_dir: join(root, 'logs', 'worker'),
    policy_file: join(root, 'policy', 'policy.json'),
    polling: { initial_interval_ms: 500, max_interval_ms: 3000 },
    heartbeat_interval_sec: 5,
    result_ttl_sec: 3600,
    max_inline_bytes: 65536,
    log_save: false,
    log_dir: join(root, 'logs', 'worker'),
  };
}

describe('task-runner 执行异常回写', () => {
  it('shared 模式：执行器抛错应回写 failed/ 并记审计', async () => {
    const task = makeTask({ task_id: 'sh-err-0001' });
    writeFileSync(join(root, 'pending', taskFileName(task.submit_time, task.task_id)), JSON.stringify(task));
    assert.equal(await acquireLock(root, task.task_id, 100), true);
    const readed = await readTask(root, task.task_id);
    await processTask(makeConfig('shared'), root, readed, 100, policyRule, new ThrowingExecutor(), auditLogger, strategy);

    assert.ok(existsSync(join(root, 'failed', taskFileName(task.submit_time, task.task_id))));
    const result = JSON.parse(readFileSync(join(root, 'failed', taskFileName(task.submit_time, task.task_id)), 'utf-8'));
    assert.equal(result.status, 'failed');
    assert.equal(result.error_msg, 'connect timeout after 10000ms');
    assert.equal(result.exit_code, null);
    assert.ok(result.stderr.includes('connect timeout'));
    // 审计应有该失败任务的记录
    const audit = await auditLogger.searchByTaskId(task.task_id);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].exit_code, null);
  });

  it('exchange 模式：执行器抛错应回写 inbound/result_<id>.json', async () => {
    await initExchangeDirs(root);
    strategy = createQueueStrategy('exchange');
    const task = makeTask({ task_id: 'ex-err-0001' });
    writeFileSync(join(root, 'outbound', taskFileName(task.submit_time, task.task_id)), JSON.stringify(task));
    assert.equal(await acquireLock(root, task.task_id, 200), true);
    const readed = await readOutboundTask(root, task.task_id);
    await processTask(makeConfig('exchange'), root, readed, 200, policyRule, new ThrowingExecutor(), auditLogger, strategy);

    assert.ok(existsSync(join(root, 'inbound', `result_${taskFileName(task.submit_time, task.task_id)}`)));
    const result = JSON.parse(readFileSync(join(root, 'inbound', `result_${taskFileName(task.submit_time, task.task_id)}`), 'utf-8'));
    assert.equal(result.status, 'failed');
    assert.equal(result.error_msg, 'connect timeout after 10000ms');
    // outbound 源任务已被领取消费
    assert.ok(!existsSync(join(root, 'outbound', taskFileName(task.submit_time, task.task_id))));
  });
});