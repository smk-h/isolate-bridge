/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : executor.test.ts
 * Author     : MsgFerry
 * Date       : 2026/08/07
 * Version    : 0.0.1
 * Description: executor 模块单元测试
 * ======================================================
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MockSshExecutor, Ssh2Executor, createExecutor } from '../src/executor.js';
import type { WorkerConfig } from '../src/config.js';

describe('MockSshExecutor', () => {
  it('execute 应返回含 mock 标记的固定文本', async () => {
    const exec = new MockSshExecutor();
    const result = await exec.execute('docker ps', 30);
    assert.ok(result.stdout.includes('[mock]'));
    assert.ok(result.stdout.includes('docker ps'));
    assert.equal(result.exit_code, 0);
    assert.equal(result.timed_out, false);
    assert.equal(result.stderr, '');
  });

  it('不同命令应在 stdout 中反映命令字符串', async () => {
    const exec = new MockSshExecutor();
    const r1 = await exec.execute('kubectl get pods', 30);
    const r2 = await exec.execute('ls -la', 30);
    assert.ok(r1.stdout.includes('kubectl get pods'));
    assert.ok(r2.stdout.includes('ls -la'));
  });
});

describe('createExecutor', () => {
  it('mock 模式应返回 MockSshExecutor 实例', () => {
    const config: WorkerConfig = {
      hgfs_root: '/tmp',
      queue_mode: 'shared',
      executor_type: 'mock',
      devices: {},
      ssh_config: null,
      audit_log_dir: '/tmp/logs',
      policy_file: '/tmp/policy.json',
      polling: { initial_interval_ms: 500, max_interval_ms: 3000 },
      heartbeat_interval_sec: 5,
      result_ttl_sec: 600,
      max_inline_bytes: 65536,
      log_save: false,
      log_dir: '/tmp/logs',
    };
    const exec = createExecutor(config);
    assert.ok(exec instanceof MockSshExecutor);
  });

  it('ssh2 模式应返回 Ssh2Executor 实例', () => {
    const config: WorkerConfig = {
      hgfs_root: '/tmp',
      queue_mode: 'shared',
      executor_type: 'ssh2',
      devices: {},
      ssh_config: { host: 'h', port: 22, username: 'u', private_key_path: null, password: null },
      audit_log_dir: '/tmp/logs',
      policy_file: '/tmp/policy.json',
      polling: { initial_interval_ms: 500, max_interval_ms: 3000 },
      heartbeat_interval_sec: 5,
      result_ttl_sec: 600,
      max_inline_bytes: 65536,
      log_save: false,
      log_dir: '/tmp/logs',
    };
    const exec = createExecutor(config);
    assert.ok(exec instanceof Ssh2Executor);
  });
});
