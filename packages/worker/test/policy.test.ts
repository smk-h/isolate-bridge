/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : policy.test.ts
 * Author     : MsgFerry
 * Date       : 2026/08/07
 * Version    : 0.0.1
 * Description: policy 模块单元测试
 * ======================================================
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_POLICY, checkCommand, parseCmd } from '../src/policy.js';

describe('policy checkCommand', () => {
  it('白名单命中应通过', () => {
    assert.deepEqual(checkCommand(DEFAULT_POLICY, 'docker ps'), { allowed: true });
  });

  it('黑名单命中应返回 blacklist_hit（优先于白名单）', () => {
    const result = checkCommand(DEFAULT_POLICY, 'rm -rf /');
    assert.equal(result.allowed, false);
    assert.equal((result as { reason: string }).reason, 'blacklist_hit');
  });

  it('参数危险模式应返回 param_blocked', () => {
    const result = checkCommand(DEFAULT_POLICY, 'ls; rm');
    assert.equal(result.allowed, false);
    assert.equal((result as { reason: string }).reason, 'param_blocked');
  });

  it('白名单未命中应返回 whitelist_miss', () => {
    const result = checkCommand(DEFAULT_POLICY, 'reboot');
    assert.equal(result.allowed, false);
    assert.equal((result as { reason: string }).reason, 'whitelist_miss');
  });

  it('default_action=allow 时白名单未命中应放行', () => {
    const allowPolicy = { ...DEFAULT_POLICY, default_action: 'allow' as const };
    const result = checkCommand(allowPolicy, 'reboot');
    assert.deepEqual(result, { allowed: true });
  });

  it('default_action=allow 时黑名单仍优先拦截', () => {
    const allowPolicy = { ...DEFAULT_POLICY, default_action: 'allow' as const };
    const result = checkCommand(allowPolicy, 'shutdown rm -rf /');
    assert.equal(result.allowed, false);
    assert.equal((result as { reason: string }).reason, 'blacklist_hit');
  });

  it('default_action=allow 时危险参数模式仍拦截', () => {
    const allowPolicy = { ...DEFAULT_POLICY, default_action: 'allow' as const };
    const result = checkCommand(allowPolicy, 'reboot; ls');
    assert.equal(result.allowed, false);
    assert.equal((result as { reason: string }).reason, 'param_blocked');
  });

  it('default_action=deny 时白名单未命中仍拦截（与默认一致）', () => {
    const denyPolicy = { ...DEFAULT_POLICY, default_action: 'deny' as const };
    const result = checkCommand(denyPolicy, 'reboot');
    assert.equal(result.allowed, false);
    assert.equal((result as { reason: string }).reason, 'whitelist_miss');
  });

  it('dd if= 应被黑名单拦截', () => {
    const result = checkCommand(DEFAULT_POLICY, 'dd if=/dev/zero of=/tmp/x');
    assert.equal(result.allowed, false);
    assert.equal((result as { reason: string }).reason, 'blacklist_hit');
  });

  it('命令替换 $() 含黑名单应被黑名单优先拦截', () => {
    const result = checkCommand(DEFAULT_POLICY, 'ls $(rm -rf /)');
    assert.equal(result.allowed, false);
    assert.equal((result as { reason: string }).reason, 'blacklist_hit');
  });

  it('命令替换 $() 无黑名单应被参数危险模式拦截', () => {
    const result = checkCommand(DEFAULT_POLICY, 'ls $(echo hi)');
    assert.equal(result.allowed, false);
    assert.equal((result as { reason: string }).reason, 'param_blocked');
  });
});

describe('policy parseCmd', () => {
  it('应正确分割首词与参数', () => {
    assert.deepEqual(parseCmd('docker ps -a'), { head: 'docker', args: ['ps', '-a'] });
  });

  it('空命令应返回空 head', () => {
    assert.deepEqual(parseCmd(''), { head: '', args: [] });
  });
});
