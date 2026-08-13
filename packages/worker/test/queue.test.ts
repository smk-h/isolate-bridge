/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : queue.test.ts
 * Author     : MsgFerry
 * Date       : 2026/08/07
 * Version    : 0.0.1
 * Description: queue 模块单元测试
 * ======================================================
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  initQueueDirs,
  listPending,
  readTask,
  acquireLock,
  transitionToProcessing,
  writeResult,
  checkCancelled,
  writeCancelledResult,
  writeHeartbeat,
  readHeartbeat,
  releaseProcessing,
  gcProcessing,
  gcResults,
  initExchangeDirs,
  listOutbound,
  readOutboundTask,
  writeResultExchange,
  checkCancelledExchange,
  writeCancelledResultExchange,
  writeHeartbeatExchange,
  removeCancelMarker,
  gcInboundResults,
} from '../src/queue/index.js';
import {
  taskFileName,
  taskFileBaseName,
  formatBeijingTimestamp,
} from '@smai-kit/msgferry-shared';
import type { CommandTask } from '@smai-kit/msgferry-shared';

function makeTask(overrides: Partial<CommandTask> = {}): CommandTask {
  return {
    kind: 'command', task_id: 'test-id-1234', batch_id: null, depends_on: [],
    cmd: 'docker ps', timeout_sec: 30, submit_time: formatBeijingTimestamp(Date.now()),
    start_time: '', end_time: '', stdout: '', stderr: '', stdout_size: 0,
    stderr_size: 0, truncated: false, stdout_overflow_path: null,
    stderr_overflow_path: null, max_inline_bytes: 65536, exit_code: null,
    error_msg: null, status: 'pending', worker_pid: null, policy_blocked: false,
    ...overrides,
  };
}

/** 生成任务文件的 pending/ 路径（手动写入时与实现保持一致） */
function pendingPath(task: CommandTask): string {
  return join(testRoot, 'pending', taskFileName(task.submit_time, task.task_id));
}

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'msgferry-q-'));
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('queue initQueueDirs', () => {
  it('应创建七个子目录', async () => {
    await initQueueDirs(testRoot);
    for (const dir of ['pending','processing','completed','failed','cancelled','outputs','policy']) {
      assert.ok(existsSync(join(testRoot, dir)), `${dir} should exist`);
    }
  });
});

describe('queue listPending', () => {
  it('应返回完整 task_id 并过滤 .tmp 文件', async () => {
    await initQueueDirs(testRoot);
    const task = makeTask({ task_id: 'list-aa0001' });
    writeFileSync(pendingPath(task), JSON.stringify(task));
    writeFileSync(join(testRoot, 'pending', 'tmp.tmp'), '{}');
    assert.deepEqual(await listPending(testRoot), ['list-aa0001']);
  });
});

describe('queue readTask', () => {
  it('应正确读取任务 JSON', async () => {
    await initQueueDirs(testRoot);
    const task = makeTask({ task_id: 'read-aa0001' });
    writeFileSync(pendingPath(task), JSON.stringify(task));
    const result = await readTask(testRoot, 'read-aa0001');
    assert.equal(result.task_id, 'read-aa0001');
    assert.equal(result.cmd, 'docker ps');
  });
});

describe('queue acquireLock', () => {
  it('首次创建应成功', async () => {
    await initQueueDirs(testRoot);
    assert.equal(await acquireLock(testRoot, 'lock-aa0001', 123), true);
    assert.ok(existsSync(join(testRoot, 'processing', 'lock-aa0001.lock')));
  });

  it('重复创建应返回 false', async () => {
    await initQueueDirs(testRoot);
    await acquireLock(testRoot, 'lock-aa0002', 111);
    assert.equal(await acquireLock(testRoot, 'lock-aa0002', 222), false);
  });
});

describe('queue transitionToProcessing', () => {
  it('应写 processing 并删 pending', async () => {
    await initQueueDirs(testRoot);
    const task = makeTask({ task_id: 'trans-aa001' });
    writeFileSync(pendingPath(task), JSON.stringify(task));
    await transitionToProcessing(testRoot, task, 999);
    assert.ok(existsSync(join(testRoot, 'processing', taskFileName(task.submit_time, task.task_id))));
    assert.ok(!existsSync(pendingPath(task)));
    assert.equal(task.status, 'processing');
    assert.equal(task.worker_pid, 999);
  });
});

describe('queue writeResult', () => {
  it('小输出应内联写入 completed', async () => {
    await initQueueDirs(testRoot);
    const task = makeTask({ task_id: 'write-aa001', status: 'completed', stdout: 'ok', stdout_size: 2 });
    await writeResult(testRoot, task, 65536);
    assert.ok(existsSync(join(testRoot, 'completed', taskFileName(task.submit_time, task.task_id))));
  });

  it('大输出应分流到 outputs', async () => {
    await initQueueDirs(testRoot);
    const big = 'x'.repeat(70000);
    const task = makeTask({ task_id: 'write-aa002', status: 'completed', stdout: big, stdout_size: 70000 });
    await writeResult(testRoot, task, 65536);
    assert.ok(existsSync(join(testRoot, 'outputs', `${taskFileBaseName(task.submit_time, task.task_id)}.stdout`)));
    assert.equal(task.truncated, true);
    assert.ok(task.stdout_overflow_path !== null);
    assert.ok(task.stdout.length <= 65536);
  });

  it('failed 状态应写入 failed 目录', async () => {
    await initQueueDirs(testRoot);
    const task = makeTask({ task_id: 'write-aa003', status: 'failed' });
    await writeResult(testRoot, task, 65536);
    assert.ok(existsSync(join(testRoot, 'failed', taskFileName(task.submit_time, task.task_id))));
  });
});

describe('queue checkCancelled', () => {
  it('无标记返回 false', async () => {
    await initQueueDirs(testRoot);
    assert.equal(await checkCancelled(testRoot, 'cancel-a1'), false);
  });

  it('有标记返回 true', async () => {
    await initQueueDirs(testRoot);
    writeFileSync(join(testRoot, 'cancelled', 'cancel-a2'), '');
    assert.equal(await checkCancelled(testRoot, 'cancel-a2'), true);
  });
});

describe('queue writeCancelledResult', () => {
  it('应写入 cancelled/<带时间戳基名>.result', async () => {
    await initQueueDirs(testRoot);
    const task = makeTask({ task_id: 'canc-aa0001', status: 'cancelled' });
    await writeCancelledResult(testRoot, task);
    assert.ok(existsSync(join(testRoot, 'cancelled', `${taskFileBaseName(task.submit_time, task.task_id)}.result`)));
  });
});

describe('queue heartbeat', () => {
  it('writeHeartbeat + readHeartbeat 往返', async () => {
    await initQueueDirs(testRoot);
    await writeHeartbeat(testRoot, {
      pid: 42, last_beat: 1000, processed_count: 7, queue_depth: 3, shutdown_at: null,
    });
    const hb = await readHeartbeat(testRoot);
    assert.equal(hb?.pid, 42);
    assert.equal(hb?.processed_count, 7);
  });

  it('readHeartbeat 文件不存在返回 null', async () => {
    assert.equal(await readHeartbeat(testRoot), null);
  });
});

describe('queue releaseProcessing', () => {
  it('应删除 processing 锁与任务记录', async () => {
    await initQueueDirs(testRoot);
    const task = makeTask({ task_id: 'rele-aa0001' });
    await acquireLock(testRoot, task.task_id, 1);
    await transitionToProcessing(testRoot, task, 1);
    assert.ok(existsSync(join(testRoot, 'processing', `${task.task_id}.lock`)));
    assert.ok(existsSync(join(testRoot, 'processing', taskFileName(task.submit_time, task.task_id))));
    await releaseProcessing(testRoot, task.task_id);
    assert.ok(!existsSync(join(testRoot, 'processing', `${task.task_id}.lock`)));
    assert.ok(!existsSync(join(testRoot, 'processing', taskFileName(task.submit_time, task.task_id))));
  });

  it('文件不存在时静默忽略（幂等）', async () => {
    await initQueueDirs(testRoot);
    await releaseProcessing(testRoot, 'rele-aa0002');
    assert.ok(true);
  });
});

describe('queue gcProcessing', () => {
  it('应清理超龄孤儿锁及其任务记录', async () => {
    await initQueueDirs(testRoot);
    const task = makeTask({ task_id: 'gc-orphan-01' });
    await acquireLock(testRoot, task.task_id, 1);
    await transitionToProcessing(testRoot, task, 1);
    const oldTime = new Date(Date.now() - 3600 * 1000);
    utimesSync(join(testRoot, 'processing', `${task.task_id}.lock`), oldTime, oldTime);
    const cleaned = await gcProcessing(testRoot, 600);
    assert.ok(cleaned >= 1);
    assert.ok(!existsSync(join(testRoot, 'processing', `${task.task_id}.lock`)));
    assert.ok(!existsSync(join(testRoot, 'processing', taskFileName(task.submit_time, task.task_id))));
  });

  it('未超龄锁不应被清理', async () => {
    await initQueueDirs(testRoot);
    const taskId = 'gc-fresh-01';
    await acquireLock(testRoot, taskId, 1);
    assert.equal(await gcProcessing(testRoot, 600), 0);
    assert.ok(existsSync(join(testRoot, 'processing', `${taskId}.lock`)));
  });
});

describe('queue gcResults', () => {
  it('应清理过期结果文件', async () => {
    await initQueueDirs(testRoot);
    const task = makeTask({ task_id: 'gc-res-0001', status: 'completed' });
    await writeResult(testRoot, task, 65536);
    // 将文件 mtime 设为 1 小时前，确保超过保留期
    const oldTime = new Date(Date.now() - 3600 * 1000);
    utimesSync(join(testRoot, 'completed', taskFileName(task.submit_time, task.task_id)), oldTime, oldTime);
    const cleaned = await gcResults(testRoot, 600);
    assert.ok(cleaned >= 1);
    assert.ok(!existsSync(join(testRoot, 'completed', taskFileName(task.submit_time, task.task_id))));
  });

  it('未过期文件不应被清理', async () => {
    await initQueueDirs(testRoot);
    const task = makeTask({ task_id: 'gc-res-0002', status: 'completed' });
    await writeResult(testRoot, task, 65536);
    const cleaned = await gcResults(testRoot, 600);
    assert.equal(cleaned, 0);
    assert.ok(existsSync(join(testRoot, 'completed', taskFileName(task.submit_time, task.task_id))));
  });
});

// ────────────────────────────────────────────────────────────────
// 文件交换服务器模式（exchange）：单向信箱目录操作
// ────────────────────────────────────────────────────────────────

describe('exchange initExchangeDirs', () => {
  it('应创建 outbound/ 与 inbound/ 目录', async () => {
    await initExchangeDirs(testRoot);
    assert.ok(existsSync(join(testRoot, 'outbound')));
    assert.ok(existsSync(join(testRoot, 'inbound')));
  });
});

describe('exchange listOutbound', () => {
  it('应返回完整 task_id 并过滤 .tmp 与取消标记', async () => {
    await initExchangeDirs(testRoot);
    const task = makeTask({ task_id: 'list-ob-0001' });
    writeFileSync(join(testRoot, 'outbound', taskFileName(task.submit_time, task.task_id)), JSON.stringify(task));
    writeFileSync(join(testRoot, 'outbound', 'tmp.tmp'), '{}');
    writeFileSync(join(testRoot, 'outbound', 'cancel_t3.marker'), '');
    assert.deepEqual(await listOutbound(testRoot), ['list-ob-0001']);
  });
});

describe('exchange readOutboundTask', () => {
  it('应正确读取 outbound 任务 JSON', async () => {
    await initExchangeDirs(testRoot);
    const task = makeTask({ task_id: 'read-ob-001' });
    writeFileSync(join(testRoot, 'outbound', taskFileName(task.submit_time, task.task_id)), JSON.stringify(task));
    const result = await readOutboundTask(testRoot, 'read-ob-001');
    assert.equal(result.task_id, 'read-ob-001');
    assert.equal(result.cmd, 'docker ps');
  });
});

describe('exchange writeResultExchange', () => {
  it('小输出应内联写入 inbound/result_<带时间戳名>.json', async () => {
    await initExchangeDirs(testRoot);
    const task = makeTask({ task_id: 'ew-aa000001', status: 'completed', stdout: 'ok', stdout_size: 2 });
    await writeResultExchange(testRoot, task, 65536);
    const resultName = `result_${taskFileName(task.submit_time, task.task_id)}`;
    assert.ok(existsSync(join(testRoot, 'inbound', resultName)));
    const saved = JSON.parse(readFileSync(join(testRoot, 'inbound', resultName), 'utf-8'));
    assert.equal(saved.status, 'completed');
  });

  it('大输出应随结果批次同目录（不写 outputs/）', async () => {
    await initExchangeDirs(testRoot);
    const big = 'x'.repeat(70000);
    const task = makeTask({ task_id: 'ew-aa000002', status: 'completed', stdout: big, stdout_size: 70000 });
    await writeResultExchange(testRoot, task, 65536);
    const base = taskFileBaseName(task.submit_time, task.task_id);
    assert.ok(existsSync(join(testRoot, 'inbound', `result_${base}.json`)));
    assert.ok(existsSync(join(testRoot, 'inbound', `${base}.stdout`)));
    assert.ok(!existsSync(join(testRoot, 'outputs', `${base}.stdout`)));
    assert.equal(task.truncated, true);
    assert.ok(task.stdout_overflow_path?.includes(`inbound/${base}.stdout`));
  });

  it('failed 状态也应写入 inbound/result_<带时间戳名>.json', async () => {
    await initExchangeDirs(testRoot);
    const task = makeTask({ task_id: 'ew-aa000003', status: 'failed' });
    await writeResultExchange(testRoot, task, 65536);
    assert.ok(existsSync(join(testRoot, 'inbound', `result_${taskFileName(task.submit_time, task.task_id)}`)));
  });
});

describe('exchange checkCancelledExchange', () => {
  it('无标记返回 false', async () => {
    await initExchangeDirs(testRoot);
    assert.equal(await checkCancelledExchange(testRoot, 'ec-aa000001'), false);
  });

  it('有标记返回 true', async () => {
    await initExchangeDirs(testRoot);
    writeFileSync(join(testRoot, 'outbound', 'cancel_ec-aa0002.marker'), '');
    assert.equal(await checkCancelledExchange(testRoot, 'ec-aa0002'), true);
  });
});

describe('exchange writeCancelledResultExchange', () => {
  it('应写入 inbound/result_<带时间戳基名>.result', async () => {
    await initExchangeDirs(testRoot);
    const task = makeTask({ task_id: 'ecc-aa00001', status: 'cancelled' });
    await writeCancelledResultExchange(testRoot, task);
    assert.ok(existsSync(join(testRoot, 'inbound', `result_${taskFileBaseName(task.submit_time, task.task_id)}.result`)));
  });
});

describe('exchange heartbeat', () => {
  it('writeHeartbeatExchange 应写入 inbound/heartbeat.json', async () => {
    await initExchangeDirs(testRoot);
    await writeHeartbeatExchange(testRoot, {
      pid: 42, last_beat: 1000, processed_count: 7, queue_depth: 3, shutdown_at: null,
    });
    const hb = JSON.parse(readFileSync(join(testRoot, 'inbound', 'heartbeat.json'), 'utf-8'));
    assert.equal(hb?.pid, 42);
    assert.equal(hb?.processed_count, 7);
  });
});

describe('exchange removeCancelMarker', () => {
  it('应删除已消费任务的取消标记', async () => {
    await initExchangeDirs(testRoot);
    writeFileSync(join(testRoot, 'outbound', 'cancel_rm1.marker'), '');
    await removeCancelMarker(testRoot, 'rm1');
    assert.ok(!existsSync(join(testRoot, 'outbound', 'cancel_rm1.marker')));
  });

  it('标记不存在时静默忽略', async () => {
    await initExchangeDirs(testRoot);
    await removeCancelMarker(testRoot, 'rm2');
    assert.ok(true);
  });
});

describe('exchange gcInboundResults', () => {
  it('应清理过期结果文件并保留心跳', async () => {
    await initExchangeDirs(testRoot);
    const task = makeTask({ task_id: 'gcx-aa00001', status: 'completed' });
    await writeResultExchange(testRoot, task, 65536);
    await writeHeartbeatExchange(testRoot, {
      pid: 1, last_beat: Date.now(), processed_count: 0, queue_depth: 0, shutdown_at: null,
    });
    const resultName = `result_${taskFileName(task.submit_time, task.task_id)}`;
    const oldTime = new Date(Date.now() - 3600 * 1000);
    utimesSync(join(testRoot, 'inbound', resultName), oldTime, oldTime);
    const cleaned = await gcInboundResults(testRoot, 600);
    assert.ok(cleaned >= 1);
    assert.ok(!existsSync(join(testRoot, 'inbound', resultName)));
    assert.ok(existsSync(join(testRoot, 'inbound', 'heartbeat.json')));
  });
});
