/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : policy.ts
 * Author     : MsgFerry
 * Date       : 2026/08/07
 * Version    : 0.0.1
 * Description: 命令安全策略校验——白名单前缀、黑名单、参数危险模式
 * ======================================================
 */

import { existsSync, statSync, readFileSync } from 'node:fs';

/** 默认动作：白名单未命中时的兜底策略 */
export type DefaultAction = 'deny' | 'allow';

/** 策略规则集 */
export interface PolicyRule {
  /** 命令首词白名单（如 docker、kubectl），default_action=deny 时生效 */
  whitelist_prefixes: string[];
  /** 危险命令黑名单（子串匹配） */
  blacklist_patterns: string[];
  /** 危险参数模式（正则字符串） */
  dangerous_param_patterns: string[];
  /** 白名单未命中时的默认动作：deny=拦截（whitelist_miss）｜allow=放行（黑名单与参数模式仍生效） */
  default_action: DefaultAction;
}

/** 策略校验结果 */
export type PolicyResult =
  | { allowed: true }
  | { allowed: false; reason: 'whitelist_miss' | 'blacklist_hit' | 'param_blocked' };

/** 默认策略规则（策略文件不存在时使用） */
export const DEFAULT_POLICY: PolicyRule = {
  whitelist_prefixes: ['docker', 'kubectl', 'systemctl', 'journalctl', 'cat', 'ls', 'tail'],
  blacklist_patterns: ['rm -rf /', 'dd if=', 'mkfs', ':(){'],
  dangerous_param_patterns: [';', '&&', '\\|\\|', '\\$\\(', '`'],
  default_action: 'deny',
};

/**
 * 加载策略文件，文件不存在则返回默认规则
 * @param file - 策略文件路径
 * @returns 策略规则对象
 */
export async function loadPolicy(file: string): Promise<PolicyRule> {
  if (!existsSync(file)) {
    return { ...DEFAULT_POLICY };
  }
  try {
    const content = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(content) as Partial<PolicyRule>;
    return {
      whitelist_prefixes: parsed.whitelist_prefixes ?? DEFAULT_POLICY.whitelist_prefixes,
      blacklist_patterns: parsed.blacklist_patterns ?? DEFAULT_POLICY.blacklist_patterns,
      dangerous_param_patterns: parsed.dangerous_param_patterns ?? DEFAULT_POLICY.dangerous_param_patterns,
      default_action: parsed.default_action ?? DEFAULT_POLICY.default_action,
    };
  } catch {
    // 策略文件解析失败回退到默认规则，不阻塞启动
    return { ...DEFAULT_POLICY };
  }
}

/**
 * 简易命令解析，按空格分割首词与参数
 * 不处理引号嵌套复杂场景，够用即可
 * @param cmd - 原始命令字符串
 * @returns 首词 head 与参数列表 args
 */
export function parseCmd(cmd: string): { head: string; args: string[] } {
  const parts = cmd.trim().split(/\s+/);
  const head = parts[0] ?? '';
  const args = parts.slice(1);
  return { head, args };
}

/**
 * 校验命令是否符合安全策略
 * @param rule - 策略规则
 * @param cmd - 待校验命令
 * @returns 校验结果
 */
export function checkCommand(rule: PolicyRule, cmd: string): PolicyResult {
  const { head } = parseCmd(cmd);

  // 黑名单优先级最高：即使首词不在白名单，命中黑名单也必须拦截为 blacklist_hit
  for (const pattern of rule.blacklist_patterns) {
    if (cmd.includes(pattern)) {
      return { allowed: false, reason: 'blacklist_hit' };
    }
  }

  // 参数危险模式检查（在整个命令字符串中检测，避免 head 残留危险字符漏检）
  for (const pattern of rule.dangerous_param_patterns) {
    const re = new RegExp(pattern);
    if (re.test(cmd)) {
      return { allowed: false, reason: 'param_blocked' };
    }
  }

  // 白名单前缀匹配（最后检查，确保黑名单与参数危险模式优先拦截）
  // default_action=deny 时未命中白名单直接拦截；=allow 时放行（黑名单与参数模式仍生效）
  if (!rule.whitelist_prefixes.includes(head)) {
    if (rule.default_action === 'allow') {
      return { allowed: true };
    }
    return { allowed: false, reason: 'whitelist_miss' };
  }

  return { allowed: true };
}

/**
 * 创建策略文件变化监听器，定时 stat mtime，变化则重载并回调
 * @param file - 策略文件路径
 * @param intervalMs - 检测间隔（毫秒）
 * @param onChange - 变化回调，参数为新加载的规则
 * @returns 带 stop 方法的句柄
 */
export function createPolicyWatcher(
  file: string,
  intervalMs: number,
  onChange: (rule: PolicyRule) => void,
): { stop: () => void } {
  let lastMtime = 0;
  try {
    if (existsSync(file)) {
      lastMtime = statSync(file).mtimeMs;
    }
  } catch {
    // 初始 stat 失败忽略，后续轮询时再尝试
  }

  const timer = setInterval(async () => {
    try {
      if (!existsSync(file)) {
        return;
      }
      const mtime = statSync(file).mtimeMs;
      if (mtime !== lastMtime) {
        lastMtime = mtime;
        const rule = await loadPolicy(file);
        onChange(rule);
      }
    } catch {
      // stat 失败忽略，下次重试
    }
  }, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
