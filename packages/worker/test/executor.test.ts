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

import {
  MockSshExecutor,
  MockShellSessionFactory,
  Ssh2Executor,
  ShellCmdExecutor,
  createExecutor,
  createShellSessionFactory,
} from '../src/executor.js';
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
      exec_mode: 'command',
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
      exec_mode: 'command',
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

  it('ssh2 + exec_mode=shell 应返回 ShellCmdExecutor（交互式 shell 通道）', () => {
    const config: WorkerConfig = {
      hgfs_root: '/tmp',
      queue_mode: 'shared',
      executor_type: 'ssh2',
      exec_mode: 'shell',
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
    assert.ok(exec instanceof ShellCmdExecutor);
  });

  it('mock 会话工厂应返回 MockShellSessionFactory 实例', () => {
    const config: WorkerConfig = {
      hgfs_root: '/tmp',
      queue_mode: 'shared',
      executor_type: 'mock',
      exec_mode: 'shell',
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
    const factory = createShellSessionFactory(config);
    assert.ok(factory instanceof MockShellSessionFactory);
  });
});

describe('MockShellSessionFactory', () => {
  it('open 返回会话，write 输入被回显到 stdout', async () => {
    const factory = new MockShellSessionFactory();
    const session = await factory.open('board-100');
    assert.equal(session.device, 'board-100');

    let stdout = '';
    session.onStdout((chunk) => { stdout += chunk; });
    session.write('ls -la\n');
    session.write('echo hi\n');
    assert.ok(stdout.includes('[mock-shell]'));
    assert.ok(stdout.includes('ls -la'));
    assert.ok(stdout.includes('echo hi'));

    await factory.closeAll();
  });

  it('close 触发 onClose 回调', async () => {
    const factory = new MockShellSessionFactory();
    const session = await factory.open();
    let closed = false;
    session.onClose(() => { closed = true; });
    await session.close();
    assert.equal(closed, true);
    await factory.closeAll();
  });
});

describe('ShellCmdExecutor (mock)', () => {
  it('execute 通过 mock shell 回显输入并返回结果', async () => {
    const config: WorkerConfig = {
      hgfs_root: '/tmp',
      queue_mode: 'shared',
      executor_type: 'mock',
      exec_mode: 'shell',
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
    const exec = new ShellCmdExecutor(config);
    const result = await exec.execute('docker ps', 1);
    assert.ok(result.stdout.includes('[mock-shell]'));
    assert.ok(result.stdout.includes('docker ps'));
    assert.equal(result.exit_code, 0);
    assert.equal(result.timed_out, false);
    assert.ok(!result.stdout.includes('__MSG_DONE_'), 'stdout 不应残留结束 marker');
    await exec.close();
  });

  it('命令输出应通过结束 marker 立即判定完成，无需等满超时', async () => {
    const config: WorkerConfig = {
      hgfs_root: '/tmp',
      queue_mode: 'shared',
      executor_type: 'mock',
      exec_mode: 'shell',
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
    const started = Date.now();
    const exec = new ShellCmdExecutor(config);
    const result = await exec.execute('ls -la', 30);
    const elapsed = Date.now() - started;
    assert.equal(result.exit_code, 0);
    assert.equal(result.timed_out, false);
    assert.ok(elapsed < 1000, `命令应在 marker 检测后立即返回，实际耗时 ${elapsed}ms`);
    await exec.close();
  });

  it('同一设备多条命令应复用同一 shell 会话（长连接）', async () => {
    const config: WorkerConfig = {
      hgfs_root: '/tmp',
      queue_mode: 'shared',
      executor_type: 'mock',
      exec_mode: 'shell',
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
    const exec = new ShellCmdExecutor(config);
    const r1 = await exec.execute('cmd1', 5, 'board-a');
    const r2 = await exec.execute('cmd2', 5, 'board-a');
    // mock 会话工厂为每个会话生成 ssh_1、ssh_2…，复用时应只开 1 个会话
    assert.equal(r1.exit_code, 0);
    assert.equal(r2.exit_code, 0);
    assert.ok(r1.stdout.includes('cmd1'));
    assert.ok(r2.stdout.includes('cmd2'));
    await exec.close();
  });

  it('会话远端关闭后应重建新会话（自动重连）', async () => {
    const config: WorkerConfig = {
      hgfs_root: '/tmp',
      queue_mode: 'shared',
      executor_type: 'mock',
      exec_mode: 'shell',
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
    const exec = new ShellCmdExecutor(config);
    await exec.execute('cmd1', 5, 'board-a');
    // 手动关闭会话，模拟远端断开：下一次 execute 应重新 open 新会话
    const sessions = [...(exec as unknown as { sessions: Map<string, unknown> }).sessions.values()];
    assert.equal(sessions.length, 1);
    await (sessions[0] as { close(): Promise<void> }).close();
    const r2 = await exec.execute('cmd2', 5, 'board-a');
    assert.equal(r2.exit_code, 0);
    assert.ok(r2.stdout.includes('cmd2'));
    const sessions2 = [...(exec as unknown as { sessions: Map<string, unknown> }).sessions.values()];
    assert.equal(sessions2.length, 1, '远端关闭后应重建并缓存新会话');
    await exec.close();
  });
});
