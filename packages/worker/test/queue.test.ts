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
} from '../src/queue.js';
import type { CommandTask } from '@smai-kit/msgferry-shared';

function makeTask(overrides: Partial<CommandTask> = {}): CommandTask {
  return {
    kind: 'command', task_id: 'test-1', batch_id: null, depends_on: [],
    cmd: 'docker ps', timeout_sec: 30, submit_time: Date.now(),
    start_time: 0, end_time: 0, stdout: '', stderr: '', stdout_size: 0,
    stderr_size: 0, truncated: false, stdout_overflow_path: null,
    stderr_overflow_path: null, max_inline_bytes: 65536, exit_code: null,
    error_msg: null, status: 'pending', worker_pid: null, policy_blocked: false,
    ...overrides,
  };
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
  it('应过滤 .tmp 文件', async () => {
    await initQueueDirs(testRoot);
    writeFileSync(join(testRoot, 'pending', 't1.json'), '{}');
    writeFileSync(join(testRoot, 'pending', 't2.tmp'), '{}');
    assert.deepEqual(await listPending(testRoot), ['t1']);
  });
});

describe('queue readTask', () => {
  it('应正确读取任务 JSON', async () => {
    await initQueueDirs(testRoot);
    const task = makeTask({ task_id: 'r1' });
    writeFileSync(join(testRoot, 'pending', 'r1.json'), JSON.stringify(task));
    const result = await readTask(testRoot, 'r1');
    assert.equal(result.task_id, 'r1');
    assert.equal(result.cmd, 'docker ps');
  });
});

describe('queue acquireLock', () => {
  it('首次创建应成功', async () => {
    await initQueueDirs(testRoot);
    assert.equal(await acquireLock(testRoot, 'l1', 123), true);
    assert.ok(existsSync(join(testRoot, 'processing', 'l1.lock')));
  });

  it('重复创建应返回 false', async () => {
    await initQueueDirs(testRoot);
    await acquireLock(testRoot, 'l2', 111);
    assert.equal(await acquireLock(testRoot, 'l2', 222), false);
  });
});

describe('queue transitionToProcessing', () => {
  it('应写 processing 并删 pending', async () => {
    await initQueueDirs(testRoot);
    const task = makeTask({ task_id: 'tr1' });
    writeFileSync(join(testRoot, 'pending', 'tr1.json'), JSON.stringify(task));
    await transitionToProcessing(testRoot, task, 999);
    assert.ok(existsSync(join(testRoot, 'processing', 'tr1.json')));
    assert.ok(!existsSync(join(testRoot, 'pending', 'tr1.json')));
    assert.equal(task.status, 'processing');
    assert.equal(task.worker_pid, 999);
  });
});

describe('queue writeResult', () => {
  it('小输出应内联写入 completed', async () => {
    await initQueueDirs(testRoot);
    const task = makeTask({ task_id: 'w1', status: 'completed', stdout: 'ok', stdout_size: 2 });
    await writeResult(testRoot, task, 65536);
    assert.ok(existsSync(join(testRoot, 'completed', 'w1.json')));
  });

  it('大输出应分流到 outputs', async () => {
    await initQueueDirs(testRoot);
    const big = 'x'.repeat(70000);
    const task = makeTask({ task_id: 'w2', status: 'completed', stdout: big, stdout_size: 70000 });
    await writeResult(testRoot, task, 65536);
    assert.ok(existsSync(join(testRoot, 'outputs', 'w2.stdout')));
    assert.equal(task.truncated, true);
    assert.ok(task.stdout_overflow_path !== null);
    assert.ok(task.stdout.length <= 65536);
  });

  it('failed 状态应写入 failed 目录', async () => {
    await initQueueDirs(testRoot);
    const task = makeTask({ task_id: 'w3', status: 'failed' });
    await writeResult(testRoot, task, 65536);
    assert.ok(existsSync(join(testRoot, 'failed', 'w3.json')));
  });
});

describe('queue checkCancelled', () => {
  it('无标记返回 false', async () => {
    await initQueueDirs(testRoot);
    assert.equal(await checkCancelled(testRoot, 'c1'), false);
  });

  it('有标记返回 true', async () => {
    await initQueueDirs(testRoot);
    writeFileSync(join(testRoot, 'cancelled', 'c2'), '');
    assert.equal(await checkCancelled(testRoot, 'c2'), true);
  });
});

describe('queue writeCancelledResult', () => {
  it('应写入 cancelled/<id>.result', async () => {
    await initQueueDirs(testRoot);
    const task = makeTask({ task_id: 'cc1', status: 'cancelled' });
    await writeCancelledResult(testRoot, task);
    assert.ok(existsSync(join(testRoot, 'cancelled', 'cc1.result')));
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

describe('queue gcResults', () => {
  it('应清理过期结果文件', async () => {
    await initQueueDirs(testRoot);
    const task = makeTask({ task_id: 'g1', status: 'completed' });
    await writeResult(testRoot, task, 65536);
    // 将文件 mtime 设为 1 小时前，确保超过保留期
    const oldTime = new Date(Date.now() - 3600 * 1000);
    utimesSync(join(testRoot, 'completed', 'g1.json'), oldTime, oldTime);
    const cleaned = await gcResults(testRoot, 600);
    assert.ok(cleaned >= 1);
    assert.ok(!existsSync(join(testRoot, 'completed', 'g1.json')));
  });

  it('未过期文件不应被清理', async () => {
    await initQueueDirs(testRoot);
    const task = makeTask({ task_id: 'g2', status: 'completed' });
    await writeResult(testRoot, task, 65536);
    const cleaned = await gcResults(testRoot, 600);
    assert.equal(cleaned, 0);
    assert.ok(existsSync(join(testRoot, 'completed', 'g2.json')));
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
  it('应列出 .json 任务并过滤 .tmp 与取消标记', async () => {
    await initExchangeDirs(testRoot);
    writeFileSync(join(testRoot, 'outbound', 't1.json'), '{}');
    writeFileSync(join(testRoot, 'outbound', 't2.tmp'), '{}');
    writeFileSync(join(testRoot, 'outbound', 'cancel_t3.marker'), '');
    assert.deepEqual(await listOutbound(testRoot), ['t1']);
  });
});

describe('exchange readOutboundTask', () => {
  it('应正确读取 outbound 任务 JSON', async () => {
    await initExchangeDirs(testRoot);
    const task = makeTask({ task_id: 'e1' });
    writeFileSync(join(testRoot, 'outbound', 'e1.json'), JSON.stringify(task));
    const result = await readOutboundTask(testRoot, 'e1');
    assert.equal(result.task_id, 'e1');
    assert.equal(result.cmd, 'docker ps');
  });
});

describe('exchange writeResultExchange', () => {
  it('小输出应内联写入 inbound/result_<id>.json', async () => {
    await initExchangeDirs(testRoot);
    const task = makeTask({ task_id: 'ew1', status: 'completed', stdout: 'ok', stdout_size: 2 });
    await writeResultExchange(testRoot, task, 65536);
    assert.ok(existsSync(join(testRoot, 'inbound', 'result_ew1.json')));
    const saved = JSON.parse(readFileSync(join(testRoot, 'inbound', 'result_ew1.json'), 'utf-8'));
    assert.equal(saved.status, 'completed');
  });

  it('大输出应随结果批次同目录（不写 outputs/）', async () => {
    await initExchangeDirs(testRoot);
    const big = 'x'.repeat(70000);
    const task = makeTask({ task_id: 'ew2', status: 'completed', stdout: big, stdout_size: 70000 });
    await writeResultExchange(testRoot, task, 65536);
    assert.ok(existsSync(join(testRoot, 'inbound', 'result_ew2.json')));
    assert.ok(existsSync(join(testRoot, 'inbound', 'ew2.stdout')));
    assert.ok(!existsSync(join(testRoot, 'outputs', 'ew2.stdout')));
    assert.equal(task.truncated, true);
    assert.ok(task.stdout_overflow_path?.includes('inbound/ew2.stdout'));
  });

  it('failed 状态也应写入 inbound/result_<id>.json', async () => {
    await initExchangeDirs(testRoot);
    const task = makeTask({ task_id: 'ew3', status: 'failed' });
    await writeResultExchange(testRoot, task, 65536);
    assert.ok(existsSync(join(testRoot, 'inbound', 'result_ew3.json')));
  });
});

describe('exchange checkCancelledExchange', () => {
  it('无标记返回 false', async () => {
    await initExchangeDirs(testRoot);
    assert.equal(await checkCancelledExchange(testRoot, 'ec1'), false);
  });

  it('有标记返回 true', async () => {
    await initExchangeDirs(testRoot);
    writeFileSync(join(testRoot, 'outbound', 'cancel_ec2.marker'), '');
    assert.equal(await checkCancelledExchange(testRoot, 'ec2'), true);
  });
});

describe('exchange writeCancelledResultExchange', () => {
  it('应写入 inbound/result_<id>.result', async () => {
    await initExchangeDirs(testRoot);
    const task = makeTask({ task_id: 'ecc1', status: 'cancelled' });
    await writeCancelledResultExchange(testRoot, task);
    assert.ok(existsSync(join(testRoot, 'inbound', 'result_ecc1.result')));
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
    await writeResultExchange(testRoot, makeTask({ task_id: 'gx1', status: 'completed' }), 65536);
    await writeHeartbeatExchange(testRoot, {
      pid: 1, last_beat: Date.now(), processed_count: 0, queue_depth: 0, shutdown_at: null,
    });
    const oldTime = new Date(Date.now() - 3600 * 1000);
    utimesSync(join(testRoot, 'inbound', 'result_gx1.json'), oldTime, oldTime);
    const cleaned = await gcInboundResults(testRoot, 600);
    assert.ok(cleaned >= 1);
    assert.ok(!existsSync(join(testRoot, 'inbound', 'result_gx1.json')));
    assert.ok(existsSync(join(testRoot, 'inbound', 'heartbeat.json')));
  });
});
