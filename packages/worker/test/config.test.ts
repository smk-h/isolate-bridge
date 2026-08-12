/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : config.test.ts
 * Author     : MsgFerry
 * Date       : 2026/08/08
 * Version    : 0.0.2
 * Description: Worker 配置解析测试——覆盖“配置文件 / 内置默认值”两级取值，
 *             以及命令行仅支持 --hgfs-root / --log-save / --log-dir
 * ======================================================
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig, validateConfig, isValidDeviceName, findSshConfig } from '../src/config/index.js';

import { stringify as stringifyYaml } from 'yaml';

let roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'msgferry-cfg-'));
  roots.push(root);
  return root;
}

function writeConfig(root: string, content: unknown): void {
  const dir = join(root, 'config');
  mkdirSync(dir, { recursive: true });
  // 配置文件为 YAML（config/worker.yaml），兼容 JSON 输入（JSON 是 YAML 的子集）
  writeFileSync(join(dir, 'worker.yaml'), typeof content === 'string' ? content : stringifyYaml(content));
}

afterEach(() => {
  for (const r of roots) {
    rmSync(r, { recursive: true, force: true });
  }
  roots = [];
});

describe('parseConfig from config file', () => {
  it('reads ssh settings from <hgfs_root>/config/worker.yaml', () => {
    const root = makeRoot();
    writeConfig(root, {
      executor: 'ssh2',
      ssh: { host: '10.0.0.5', port: 2222, username: 'ops', password: 'secret' },
    });
    const cfg = parseConfig(['--hgfs-root', root]);
    assert.equal(cfg.executor_type, 'ssh2');
    assert.equal(cfg.ssh_config?.host, '10.0.0.5');
    assert.equal(cfg.ssh_config?.port, 2222);
    assert.equal(cfg.ssh_config?.username, 'ops');
    assert.equal(cfg.ssh_config?.password, 'secret');
    assert.equal(cfg.ssh_config?.private_key_path, null);
  });

  it('parses multiple devices from devices map', () => {
    const root = makeRoot();
    writeConfig(root, {
      executor: 'ssh2',
      devices: {
        'board-100': { host: '192.168.1.100', port: 22, username: 'root', password: 'p1' },
        'board-101': { host: '192.168.1.101', port: 2222, username: 'admin', private_key_path: '/k.pem' },
      },
    });
    const cfg = parseConfig(['--hgfs-root', root]);
    assert.equal(Object.keys(cfg.devices).length, 2);
    assert.equal(cfg.devices['board-100']?.host, '192.168.1.100');
    assert.equal(cfg.devices['board-100']?.password, 'p1');
    assert.equal(cfg.devices['board-101']?.host, '192.168.1.101');
    assert.equal(cfg.devices['board-101']?.port, 2222);
    assert.equal(cfg.devices['board-101']?.private_key_path, '/k.pem');
    // 无 default/ssh 时 ssh_config 为 null，但 devices 可查
    assert.equal(cfg.ssh_config, null);
    assert.equal(findSshConfig(cfg, 'board-100')?.host, '192.168.1.100');
    assert.equal(findSshConfig(cfg, 'board-101')?.port, 2222);
  });

  it('skips devices with invalid names or missing host/username', () => {
    const root = makeRoot();
    writeConfig(root, {
      executor: 'ssh2',
      devices: {
        'board-ok': { host: '10.0.0.1', username: 'u' },
        'bad name!': { host: '10.0.0.2', username: 'u' },
        'no-host': { username: 'u' },
        'no-user': { host: '10.0.0.3' },
      },
    });
    const cfg = parseConfig(['--hgfs-root', root]);
    assert.deepEqual(Object.keys(cfg.devices), ['board-ok']);
  });

  it('supports devices.default and legacy ssh fallback', () => {
    const root = makeRoot();
    writeConfig(root, {
      executor: 'ssh2',
      devices: {
        default: { host: '10.0.0.9', username: 'def', password: 'pd' },
        'board-100': { host: '10.0.0.1', username: 'u' },
      },
    });
    const cfg = parseConfig(['--hgfs-root', root]);
    assert.equal(cfg.ssh_config?.host, '10.0.0.9');
    assert.equal(cfg.devices.default?.host, '10.0.0.9');
    assert.equal(findSshConfig(cfg)?.host, '10.0.0.9');
    assert.equal(findSshConfig(cfg, 'board-100')?.host, '10.0.0.1');
    // 未命中时回退到默认设备
    assert.equal(findSshConfig(cfg, 'unknown')?.host, '10.0.0.9');
  });

  it('keeps private_key_path as optional alternative to password', () => {
    const root = makeRoot();
    writeConfig(root, {
      executor: 'ssh2',
      ssh: { host: '10.0.0.5', username: 'ops', private_key_path: '/k.pem' },
    });
    const cfg = parseConfig(['--hgfs-root', root]);
    assert.equal(cfg.ssh_config?.private_key_path, '/k.pem');
    assert.equal(cfg.ssh_config?.password, null);
  });

  it('falls back to defaults when no config file exists', () => {
    const root = makeRoot();
    const cfg = parseConfig(['--hgfs-root', root]);
    assert.equal(cfg.executor_type, 'mock');
    assert.equal(cfg.ssh_config, null);
    assert.equal(cfg.heartbeat_interval_sec, 5);
    assert.equal(cfg.polling.initial_interval_ms, 500);
    assert.equal(cfg.max_inline_bytes, 65536);
    assert.equal(cfg.policy_file, join(root, 'policy', 'policy.json'));
    // 日志/审计目录默认均为 <hgfs_root>/logs/worker
    assert.equal(cfg.log_dir, join(root, 'logs', 'worker'));
    assert.equal(cfg.audit_log_dir, cfg.log_dir);
    assert.equal(cfg.log_save, false);
  });

  it('resolves relative policy_file under hgfs_root', () => {
    const root = makeRoot();
    writeConfig(root, {
      policy_file: 'policy/policy.json',
    });
    const cfg = parseConfig(['--hgfs-root', root]);
    assert.equal(cfg.policy_file, join(root, 'policy', 'policy.json'));
  });

  it('keeps absolute policy_file as-is', () => {
    const root = makeRoot();
    writeConfig(root, {
      policy_file: '/etc/msgferry/policy.json',
    });
    const cfg = parseConfig(['--hgfs-root', root]);
    assert.equal(cfg.policy_file, '/etc/msgferry/policy.json');
  });

  it('supports comments and inline fields in YAML config', () => {
    const root = makeRoot();
    // YAML 支持注释；设备名与 key 均可含连字符
    writeConfig(root, `
# Worker 配置示例（YAML）
executor: ssh2  # 行尾注释

ssh:
  host: 10.0.0.5
  port: 2222
  username: ops
  password: secret
`);
    const cfg = parseConfig(['--hgfs-root', root]);
    assert.equal(cfg.executor_type, 'ssh2');
    assert.equal(cfg.ssh_config?.host, '10.0.0.5');
    assert.equal(cfg.ssh_config?.port, 2222);
    assert.equal(cfg.ssh_config?.username, 'ops');
    assert.equal(cfg.ssh_config?.password, 'secret');
  });

  it('keeps JSON content valid as YAML (backward compatible)', () => {
    const root = makeRoot();
    // JSON 是 YAML 的子集，旧 worker.json 内容仍可被 YAML 解析
    writeConfig(root, {
      executor: 'ssh2',
      ssh: { host: '10.0.0.5', port: 2222, username: 'ops', password: 'secret' },
    });
    const cfg = parseConfig(['--hgfs-root', root]);
    assert.equal(cfg.executor_type, 'ssh2');
    assert.equal(cfg.ssh_config?.host, '10.0.0.5');
  });

  it('throws when config file is not valid YAML', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'worker.yaml'), '{{broken');
    assert.throws(() => parseConfig(['--hgfs-root', root]), /not valid YAML/);
  });

  it('parses exec_mode (command default | shell)', () => {
    // 默认 command
    const root = makeRoot();
    const cfgDefault = parseConfig(['--hgfs-root', root]);
    assert.equal(cfgDefault.exec_mode, 'command');

    // 显式 shell
    const rootShell = makeRoot();
    writeConfig(rootShell, { exec_mode: 'shell' });
    assert.equal(parseConfig(['--hgfs-root', rootShell]).exec_mode, 'shell');

    // 显式 command
    const rootCmd = makeRoot();
    writeConfig(rootCmd, { exec_mode: 'command' });
    assert.equal(parseConfig(['--hgfs-root', rootCmd]).exec_mode, 'command');
  });

  it('rejects invalid exec_mode', () => {
    const root = makeRoot();
    writeConfig(root, { exec_mode: 'bogus' });
    assert.throws(() => parseConfig(['--hgfs-root', root]), /invalid exec_mode/);
  });
});

describe('parseConfig log settings from CLI', () => {
  it('defaults log_save=false and log_dir=<hgfs_root>/logs/worker', () => {
    const root = makeRoot();
    const cfg = parseConfig(['--hgfs-root', root]);
    assert.equal(cfg.log_save, false);
    assert.equal(cfg.log_dir, join(root, 'logs', 'worker'));
  });

  it('enables log_save with --log-save 1/true', () => {
    const root = makeRoot();
    assert.equal(parseConfig(['--hgfs-root', root, '--log-save', '1']).log_save, true);
    assert.equal(parseConfig(['--hgfs-root', root, '--log-save', 'true']).log_save, true);
  });

  it('keeps log_save disabled for other values', () => {
    const root = makeRoot();
    assert.equal(parseConfig(['--hgfs-root', root, '--log-save', '0']).log_save, false);
    assert.equal(parseConfig(['--hgfs-root', root, '--log-save', 'yes']).log_save, false);
  });

  it('resolves relative --log-dir under hgfs_root', () => {
    const root = makeRoot();
    const cfg = parseConfig(['--hgfs-root', root, '--log-dir', 'logs/worker']);
    assert.equal(cfg.log_dir, join(root, 'logs', 'worker'));
    assert.equal(cfg.audit_log_dir, cfg.log_dir);
  });

  it('keeps absolute --log-dir as-is', () => {
    const root = makeRoot();
    const cfg = parseConfig(['--hgfs-root', root, '--log-dir', '/var/log/msgferry']);
    assert.equal(cfg.log_dir, '/var/log/msgferry');
    assert.equal(cfg.audit_log_dir, '/var/log/msgferry');
  });

  it('audit_log_dir always equals log_dir (not configurable for now)', () => {
    const root = makeRoot();
    // 配置文件即使写了 audit_log_dir 也不会被读取
    writeConfig(root, { audit_log_dir: 'logs/custom' });
    const cfg = parseConfig(['--hgfs-root', root, '--log-dir', 'logs/worker']);
    assert.equal(cfg.log_dir, join(root, 'logs', 'worker'));
    assert.equal(cfg.audit_log_dir, cfg.log_dir);
  });
});

describe('CLI/env no longer affect non-log config', () => {
  it('ignores legacy CLI flags like --executor/--ssh-*/--policy-file', () => {
    const root = makeRoot();
    const cfg = parseConfig([
      '--hgfs-root', root,
      '--executor', 'ssh2',
      '--ssh-host', '10.0.0.5',
      '--ssh-user', 'ops',
      '--policy-file', 'custom/policy.json',
      '--polling-initial', '100',
    ]);
    // 全部走默认值（无配置文件）
    assert.equal(cfg.executor_type, 'mock');
    assert.equal(cfg.ssh_config, null);
    assert.equal(cfg.policy_file, join(root, 'policy', 'policy.json'));
    assert.equal(cfg.polling.initial_interval_ms, 500);
  });

  it('ignores env vars (MSGFERRY_* / LOG_SAVE / LOG_DIR)', () => {
    const root = makeRoot();
    const cfg = parseConfig(['--hgfs-root', root]);
    assert.equal(cfg.executor_type, 'mock');
    assert.equal(cfg.log_save, false);
    assert.equal(cfg.log_dir, join(root, 'logs', 'worker'));
    // 验证函数本身不读取 env：即便进程环境里有值也不影响
    process.env.MSGFERRY_EXECUTOR = 'ssh2';
    process.env.LOG_SAVE = '1';
    process.env.LOG_DIR = '/tmp/from-env';
    try {
      const cfg2 = parseConfig(['--hgfs-root', root]);
      assert.equal(cfg2.executor_type, 'mock');
      assert.equal(cfg2.log_save, false);
      assert.equal(cfg2.log_dir, join(root, 'logs', 'worker'));
    } finally {
      delete process.env.MSGFERRY_EXECUTOR;
      delete process.env.LOG_SAVE;
      delete process.env.LOG_DIR;
    }
  });
});

describe('isValidDeviceName', () => {
  it('accepts letters, digits, underscore and hyphen', () => {
    for (const name of ['board-100', 'board_100', 'Board100', 'a-b_c', '123']) {
      assert.equal(isValidDeviceName(name), true, name);
    }
  });

  it('rejects special symbols and spaces', () => {
    for (const name of ['board name', 'board@100', 'board#100', 'board.100', 'board/100', '中文', '', 'a b']) {
      assert.equal(isValidDeviceName(name), false, name);
    }
  });
});

describe('validateConfig', () => {
  it('rejects missing hgfs_root', () => {
    assert.throws(() => validateConfig({
      hgfs_root: '',
      queue_mode: 'shared',
      executor_type: 'mock',
      exec_mode: 'command',
      devices: {},
      ssh_config: null,
      audit_log_dir: '',
      policy_file: '',
      polling: { initial_interval_ms: 500, max_interval_ms: 3000 },
      heartbeat_interval_sec: 5,
      result_ttl_sec: 600,
      max_inline_bytes: 65536,
      log_save: false,
      log_dir: '',
    }), /hgfs_root is required/);
  });

  it('rejects ssh2 mode without host/username', () => {
    const root = makeRoot();
    const cfg = parseConfig(['--hgfs-root', root]);
    assert.throws(() => validateConfig({ ...cfg, executor_type: 'ssh2' }), /ssh_config is required/);
  });

  it('passes for ssh2 config loaded from file', () => {
    const root = makeRoot();
    writeConfig(root, { executor: 'ssh2', ssh: { host: '10.0.0.5', username: 'ops' } });
    const cfg = parseConfig(['--hgfs-root', root]);
    assert.doesNotThrow(() => validateConfig(cfg));
  });

  it('passes for ssh2 config with multiple devices', () => {
    const root = makeRoot();
    writeConfig(root, {
      executor: 'ssh2',
      devices: {
        'board-100': { host: '10.0.0.1', username: 'u' },
        'board-101': { host: '10.0.0.2', username: 'u' },
      },
    });
    const cfg = parseConfig(['--hgfs-root', root]);
    assert.doesNotThrow(() => validateConfig(cfg));
  });
});
