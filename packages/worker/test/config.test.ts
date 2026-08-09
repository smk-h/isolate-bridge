/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : config.test.ts
 * Author     : MsgFerry
 * Date       : 2026/08/08
 * Version    : 0.0.1
 * Description: Worker 配置解析测试——覆盖“配置文件 / 环境变量 / 命令行参数”三级优先级
 * ======================================================
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig, validateConfig, isValidDeviceName, findSshConfig } from '../src/config.js';

let roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'msgferry-cfg-'));
  roots.push(root);
  return root;
}

function writeConfig(root: string, content: unknown): void {
  const dir = join(root, 'config');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'worker.json'), JSON.stringify(content, null, 2));
}

afterEach(() => {
  for (const r of roots) {
    rmSync(r, { recursive: true, force: true });
  }
  roots = [];
});

describe('parseConfig from config file', () => {
  it('reads ssh settings from <hgfs_root>/config/worker.json', () => {
    const root = makeRoot();
    writeConfig(root, {
      executor: 'ssh2',
      ssh: { host: '10.0.0.5', port: 2222, username: 'ops', password: 'secret' },
    });
    const cfg = parseConfig(['--hgfs-root', root], {});
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
    const cfg = parseConfig(['--hgfs-root', root], {});
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
    const cfg = parseConfig(['--hgfs-root', root], {});
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
    const cfg = parseConfig(['--hgfs-root', root], {});
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
    const cfg = parseConfig(['--hgfs-root', root], {});
    assert.equal(cfg.ssh_config?.private_key_path, '/k.pem');
    assert.equal(cfg.ssh_config?.password, null);
  });

  it('falls back to defaults when no config file exists', () => {
    const root = makeRoot();
    const cfg = parseConfig(['--hgfs-root', root], {});
    assert.equal(cfg.executor_type, 'mock');
    assert.equal(cfg.ssh_config, null);
    assert.equal(cfg.heartbeat_interval_sec, 5);
    assert.equal(cfg.polling.initial_interval_ms, 500);
    assert.equal(cfg.max_inline_bytes, 65536);
    assert.equal(cfg.audit_log_dir, join(root, 'logs'));
    assert.equal(cfg.policy_file, join(root, 'policy', 'policy.json'));
  });

  it('resolves relative audit_log_dir/policy_file under hgfs_root', () => {
    const root = makeRoot();
    writeConfig(root, {
      audit_log_dir: 'logs',
      policy_file: 'policy/policy.json',
    });
    const cfg = parseConfig(['--hgfs-root', root], {});
    assert.equal(cfg.audit_log_dir, join(root, 'logs'));
    assert.equal(cfg.policy_file, join(root, 'policy', 'policy.json'));
  });

  it('keeps absolute audit_log_dir/policy_file as-is', () => {
    const root = makeRoot();
    writeConfig(root, {
      audit_log_dir: '/var/log/msgferry',
      policy_file: '/etc/msgferry/policy.json',
    });
    const cfg = parseConfig(['--hgfs-root', root], {});
    assert.equal(cfg.audit_log_dir, '/var/log/msgferry');
    assert.equal(cfg.policy_file, '/etc/msgferry/policy.json');
  });

  it('handles Windows drive-letter values per platform', () => {
    const root = makeRoot();
    const winLogs = 'E:\\MyLinux\\VMware\\sharedir\\vm_share\\logs';
    writeConfig(root, {
      audit_log_dir: winLogs,
      policy_file: 'policy/policy.json',
    });
    const cfg = parseConfig(['--hgfs-root', root], {});
    if (process.platform === 'win32') {
      // Windows 上盘符路径被视为绝对路径，原样保留
      assert.equal(cfg.audit_log_dir, 'E:\\MyLinux\\VMware\\sharedir\\vm_share\\logs');
    } else {
      // Linux 上盘符字符串被当作相对路径，基于共享根目录解析，不会落到 /workspace/E:... 这类错误位置
      assert.equal(cfg.audit_log_dir, join(root, 'E:\\MyLinux\\VMware\\sharedir\\vm_share\\logs'));
    }
    assert.equal(cfg.policy_file, join(root, 'policy', 'policy.json'));
  });

  it('resolves relative CLI --audit-dir/--policy-file under hgfs_root', () => {
    const root = makeRoot();
    const cfg = parseConfig(
      ['--hgfs-root', root, '--audit-dir', 'logs', '--policy-file', 'policy/policy.json'],
      {},
    );
    assert.equal(cfg.audit_log_dir, join(root, 'logs'));
    assert.equal(cfg.policy_file, join(root, 'policy', 'policy.json'));
  });

  it('CLI args override config file values', () => {
    const root = makeRoot();
    writeConfig(root, { executor: 'ssh2', ssh: { host: '10.0.0.5', username: 'ops' } });
    const cfg = parseConfig(
      ['--hgfs-root', root, '--executor', 'mock'],
      {},
    );
    assert.equal(cfg.executor_type, 'mock');
    assert.equal(cfg.ssh_config, null);
  });

  it('env vars override config file values', () => {
    const root = makeRoot();
    writeConfig(root, { executor: 'ssh2', ssh: { host: '10.0.0.5', username: 'ops' } });
    const cfg = parseConfig(['--hgfs-root', root], {
      MSGFERRY_EXECUTOR: 'mock',
    });
    assert.equal(cfg.executor_type, 'mock');
  });

  it('respects explicit --config-file path', () => {
    const root = makeRoot();
    const custom = join(root, 'custom.json');
    writeFileSync(custom, JSON.stringify({ executor: 'ssh2', ssh: { host: '10.1.1.1', username: 'u' } }));
    const cfg = parseConfig(
      ['--hgfs-root', root, '--config-file', custom],
      {},
    );
    assert.equal(cfg.executor_type, 'ssh2');
    assert.equal(cfg.ssh_config?.host, '10.1.1.1');
  });

  it('throws when config file is not valid JSON', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'worker.json'), '{broken');
    assert.throws(() => parseConfig(['--hgfs-root', root], {}), /not valid JSON/);
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
      executor_type: 'mock',
      devices: {},
      ssh_config: null,
      audit_log_dir: '',
      policy_file: '',
      polling: { initial_interval_ms: 500, max_interval_ms: 3000 },
      heartbeat_interval_sec: 5,
      result_ttl_sec: 600,
      max_inline_bytes: 65536,
    }), /hgfs_root is required/);
  });

  it('rejects ssh2 mode without host/username', () => {
    const root = makeRoot();
    const cfg = parseConfig(['--hgfs-root', root], {});
    assert.throws(() => validateConfig({ ...cfg, executor_type: 'ssh2' }), /ssh_config is required/);
  });

  it('passes for ssh2 config loaded from file', () => {
    const root = makeRoot();
    writeConfig(root, { executor: 'ssh2', ssh: { host: '10.0.0.5', username: 'ops' } });
    const cfg = parseConfig(['--hgfs-root', root], {});
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
    const cfg = parseConfig(['--hgfs-root', root], {});
    assert.doesNotThrow(() => validateConfig(cfg));
  });
});
