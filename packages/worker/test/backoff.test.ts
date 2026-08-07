/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : backoff.test.ts
 * Author     : MsgFerry
 * Date       : 2026/08/07
 * Version    : 0.0.1
 * Description: backoff 模块单元测试
 * ======================================================
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createBackoff } from '../src/backoff.js';

describe('backoff', () => {
  it('next() 应按指数增长且不超上限', () => {
    const bo = createBackoff(500, 3000);
    assert.equal(bo.next(), 500);
    assert.equal(bo.next(), 1000);
    assert.equal(bo.next(), 2000);
    assert.equal(bo.next(), 3000);
    assert.equal(bo.next(), 3000);
  });

  it('reset() 应复位到初始间隔', () => {
    const bo = createBackoff(500, 3000);
    bo.next();
    bo.next();
    bo.reset();
    assert.equal(bo.next(), 500);
  });

  it('current_interval_ms 应反映当前间隔', () => {
    const bo = createBackoff(500, 3000);
    bo.next();
    assert.equal(bo.current_interval_ms, 1000);
  });

  it('初始间隔等于上限时应固定返回', () => {
    const bo = createBackoff(3000, 3000);
    assert.equal(bo.next(), 3000);
    assert.equal(bo.next(), 3000);
  });
});
