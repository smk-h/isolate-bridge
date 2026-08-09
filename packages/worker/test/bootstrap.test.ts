/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : bootstrap.test.ts
 * Author     : MsgFerry
 * Date       : 2026/08/08
 * Version    : 0.0.1
 * Description: 共享目录引导测试——config/ 与 policy/ 目录及模板文件的自动补齐、
 *             幂等跳过，以及策略模板复制时 default_action 由 deny 改写为 allow
 * ======================================================
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureSharedTemplates } from '../src/bootstrap.js';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

let roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'msgferry-boot-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const r of roots) {
    rmSync(r, { recursive: true, force: true });
  }
  roots = [];
});

describe('ensureSharedTemplates', () => {
  it('creates config/worker.yaml and policy/policy.json when missing', async () => {
    const root = makeRoot();
    await ensureSharedTemplates(root);

    const cfgPath = join(root, 'config', 'worker.yaml');
    const polPath = join(root, 'policy', 'policy.json');
    assert.ok(existsSync(cfgPath), 'config/worker.yaml should be created');
    assert.ok(existsSync(polPath), 'policy/policy.json should be created');

    const cfg = parseYaml(readFileSync(cfgPath, 'utf-8')) as Record<string, any>;
    assert.equal(cfg.executor, 'ssh2');
    // 模板使用多设备结构（设备名 → 连接信息）
    assert.equal(cfg.devices?.['default']?.host, '192.168.1.100');
    assert.equal(cfg.devices?.['default']?.username, 'root');
    assert.equal(cfg.devices?.['board-100']?.host, '192.168.1.100');
    assert.equal(cfg.devices?.['board-100']?.username, 'root');
    // 模板 SSH 认证使用用户名 + 密码，不再携带 Windows 私钥文件路径
    assert.equal(cfg.devices?.['board-100']?.password, 'your_password');
    assert.equal(cfg.devices?.['board-100']?.private_key_path, undefined);
    assert.equal(cfg.devices?.['board-101']?.host, '192.168.1.101');
    // 模板中 policy_file 应为相对共享根目录的路径，
    // 由 Worker 按 --hgfs-root 解析为绝对路径，避免示例 Windows 绝对路径污染重启后配置
    assert.equal(cfg.policy_file, 'policy/policy.json');
    // hgfs_root / audit_log_dir 不再进配置文件（hgfs_root 仅命令行必填；audit_log_dir 暂固定与 log_dir 一致）
    assert.equal(cfg.hgfs_root, undefined);
    assert.equal(cfg.audit_log_dir, undefined);

    const pol = JSON.parse(readFileSync(polPath, 'utf-8'));
    assert.ok(Array.isArray(pol.whitelist_prefixes), 'policy whitelist_prefixes should be array');
    assert.ok(pol.whitelist_prefixes.includes('docker'));
    assert.equal(pol.default_action, 'allow', 'generated policy default_action should be allow');
  });

  it('leaves existing config/policy files untouched', async () => {
    const root = makeRoot();
    const cfgDir = join(root, 'config');
    const polDir = join(root, 'policy');
    mkdirSync(cfgDir, { recursive: true });
    mkdirSync(polDir, { recursive: true });

    const customCfg = stringifyYaml({ executor: 'mock', note: 'user customized' });
    const customPol = JSON.stringify({ whitelist_prefixes: ['custom'], '//': 'user customized' }, null, 2);
    writeFileSync(join(cfgDir, 'worker.yaml'), customCfg);
    writeFileSync(join(polDir, 'policy.json'), customPol);

    await ensureSharedTemplates(root);

    assert.equal(readFileSync(join(cfgDir, 'worker.yaml'), 'utf-8'), customCfg);
    assert.equal(readFileSync(join(polDir, 'policy.json'), 'utf-8'), customPol);
  });

  it('is idempotent when run twice', async () => {
    const root = makeRoot();
    await ensureSharedTemplates(root);
    const cfgPath = join(root, 'config', 'worker.yaml');
    const before = readFileSync(cfgPath, 'utf-8');
    await ensureSharedTemplates(root);
    assert.equal(readFileSync(cfgPath, 'utf-8'), before);
  });
});
