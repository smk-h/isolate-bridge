/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : session.test.ts
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: 交互式 shell 会话管理（stdin/stdout 文件摆渡）单元测试
 * ======================================================
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SESSIONS_DIR, SESSION, SessionStatus } from '@smai-kit/msgferry-shared';
import type { SessionTask } from '@smai-kit/msgferry-shared';

import {
  initSessionsDir,
  listSessions,
  readSessionMeta,
  writeSessionMeta,
  listStdinInputs,
  readAndRemoveStdinInput,
  writeStdoutOutput,
  checkSessionCloseMarker,
  writeSessionCloseMarker,
  SessionManager,
} from '../src/session/index.js';
import { MockShellSessionFactory } from '../src/executor/index.js';

let root: string;

function makeSession(overrides: Partial<SessionTask> = {}): SessionTask {
  return {
    kind: 'session',
    session_id: 'sess-1',
    cmd: '',
    device: 'board-100',
    timeout_sec: 30,
    submit_time: Date.now(),
    start_time: Date.now(),
    end_time: 0,
    status: SessionStatus.Running,
    session_dir: join(root, SESSIONS_DIR, 'sess-1'),
    stdin_dir: SESSION.stdin,
    stdout_dir: SESSION.stdout,
    close_marker: null,
    stdout_seq: 0,
    stdin_seq: 0,
    error_msg: null,
    worker_pid: 123,
    ...overrides,
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'msgferry-sess-'));
  await initSessionsDir(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('会话目录操作', () => {
  it('writeSessionMeta / readSessionMeta 往返一致', async () => {
    const s = makeSession();
    await writeSessionMeta(root, s);
    const meta = await readSessionMeta(root, 'sess-1');
    assert.equal(meta?.session_id, 'sess-1');
    assert.equal(meta?.status, SessionStatus.Running);
    assert.equal(meta?.device, 'board-100');
  });

  it('listSessions 列出已建会话目录', async () => {
    const s = makeSession();
    await writeSessionMeta(root, s);
    const ids = await listSessions(root);
    assert.deepEqual(ids, ['sess-1']);
  });

  it('stdin 输入写入后可按序号读取并删除', async () => {
    const s = makeSession();
    await writeSessionMeta(root, s);
    const stdinDir = join(root, SESSIONS_DIR, 'sess-1', SESSION.stdin);
    mkdirSync(stdinDir, { recursive: true });
    writeFileSync(join(stdinDir, '1.input'), 'ls -la\n');
    writeFileSync(join(stdinDir, '2.input'), 'pwd\n');

    const seqs = await listStdinInputs(root, 'sess-1');
    assert.deepEqual(seqs, [1, 2]);
    assert.equal(await readAndRemoveStdinInput(root, 'sess-1', 1), 'ls -la\n');
    const seqs2 = await listStdinInputs(root, 'sess-1');
    assert.deepEqual(seqs2, [2]);
  });

  it('writeStdoutOutput 落盘 stdout/<seq>.output', async () => {
    await writeStdoutOutput(root, 'sess-1', 0, 'hello\n');
    const content = readFileSync(join(root, SESSIONS_DIR, 'sess-1', SESSION.stdout, '0.output'), 'utf-8');
    assert.equal(content, 'hello\n');
  });

  it('关闭标记写入后 checkSessionCloseMarker 返回 true', async () => {
    const s = makeSession();
    await writeSessionMeta(root, s);
    assert.equal(await checkSessionCloseMarker(root, 'sess-1'), false);
    await writeSessionCloseMarker(root, 'sess-1');
    assert.equal(await checkSessionCloseMarker(root, 'sess-1'), true);
  });
});

describe('SessionManager (mock)', () => {
  it('open 后注入 stdin，输出落盘 stdout', async () => {
    const s = makeSession();
    await writeSessionMeta(root, s);
    const manager = new SessionManager(root, new MockShellSessionFactory());
    await manager.open(s);

    // 写入 stdin 输入，驱动 tick 注入到 shell
    const stdinDir = join(root, SESSIONS_DIR, 'sess-1', SESSION.stdin);
    mkdirSync(stdinDir, { recursive: true });
    writeFileSync(join(stdinDir, '0.input'), 'echo hello\n');
    await new Promise((r) => setTimeout(r, 20));
    await manager.tick(0);

    // stdout 应有输出
    const stdoutDir = join(root, SESSIONS_DIR, 'sess-1', SESSION.stdout);
    const files = existsSync(stdoutDir) ? (await import('node:fs/promises')).readdir(stdoutDir) : [];
    assert.ok((await files).length > 0, 'stdout 应有输出文件');

    await manager.closeAll();
  });

  it('close 标记触发会话关闭并 finalize 为 closed', async () => {
    const s = makeSession();
    await writeSessionMeta(root, s);
    const manager = new SessionManager(root, new MockShellSessionFactory());
    await manager.open(s);

    await writeSessionCloseMarker(root, 'sess-1');
    await manager.tick(0);

    const meta = await readSessionMeta(root, 'sess-1');
    assert.equal(meta?.status, SessionStatus.Closed);
    assert.equal(manager.size, 0);

    await manager.closeAll();
  });

  it('空闲超时触发会话 aborted', async () => {
    const s = makeSession();
    await writeSessionMeta(root, s);
    const manager = new SessionManager(root, new MockShellSessionFactory());
    await manager.open(s);

    // 空闲超时 0ms：最后活跃时间已过，立即触发
    await new Promise((r) => setTimeout(r, 20));
    await manager.tick(1);

    const meta = await readSessionMeta(root, 'sess-1');
    assert.equal(meta?.status, SessionStatus.Aborted);
    assert.equal(manager.size, 0);

    await manager.closeAll();
  });
});
