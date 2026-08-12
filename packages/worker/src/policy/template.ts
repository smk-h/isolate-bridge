/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : template.ts
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: 策略模板引导——启动时自动补齐 <root>/policy/policy.json
 *   策略：检测目标文件是否存在，存在则跳过，不存在则从随产物分发的
 *   policy.example.json 复制并重命名。注意：复制时会把 default_action 由
 *   deny 改写为 allow（即自动生成的 policy.json 白名单未命中时默认放行，
 *   黑名单与危险参数模式仍生效）。
 * ======================================================
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from '../log/index.js';

/** 随产物分发的策略模板文件名 */
const POLICY_TEMPLATE_FILE = 'policy.example.json';
/** 默认策略文件相对路径（共享根目录 policy/ 子目录） */
const POLICY_FILE_REL = 'policy/policy.json';

/** 自动生成的策略文件中 default_action 的目标值：deny → allow */
const POLICY_DEFAULT_ACTION = 'allow';

/** 兜底策略模板（模板文件缺失时使用，内容与 policy.example.json 保持一致） */
const FALLBACK_POLICY_TEMPLATE: Record<string, unknown> = {
  '//': '命令安全策略示例文件。由 Worker 启动时自动写入共享目录 policy/policy.json。字段说明：whitelist_prefixes=命令首词白名单（精确匹配）；blacklist_patterns=危险命令黑名单（子串匹配，优先级最高）；dangerous_param_patterns=危险参数正则模式（对整个命令做 RegExp 检测）；default_action=白名单未命中时的兜底动作（deny=拦截 / allow=放行）。省略的字段会用内置默认值补齐。',
  whitelist_prefixes: ['docker', 'kubectl', 'systemctl', 'journalctl', 'cat', 'ls', 'tail'],
  blacklist_patterns: ['rm -rf /', 'dd if=', 'mkfs', ':(){'],
  dangerous_param_patterns: [';', '&&', '\\|', '>', '\\$\\(', '`'],
  default_action: 'deny',
};

/**
 * 解析模板文件所在目录（Worker 安装/产物目录）
 * - rollup 产物：index.mjs 与 policy.example.json 同目录
 * - tsc 源码编译：import.meta.url 指向 dist/src，模板读取失败时走内联兜底
 * @returns 模板文件所在目录绝对路径
 */
function resolveTemplateDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

/**
 * 写入策略模板：复制默认动作由 deny 改写为 allow（仅用于自动生成的
 * policy/policy.json；模板文件保持原样，已存在的策略文件不会被覆盖）
 * @param root - HGFS 共享根目录
 */
export async function ensurePolicyTemplate(root: string): Promise<void> {
  const target = join(root, POLICY_FILE_REL);
  try {
    await access(target);
    return;
  } catch {
    // 目标文件不存在，继续生成模板
  }
  await mkdir(dirname(target), { recursive: true });
  // 读取随产物分发的策略模板；缺失时退回内联兜底模板
  let content: string;
  try {
    content = await readFile(join(resolveTemplateDir(), POLICY_TEMPLATE_FILE), 'utf-8');
  } catch {
    content = JSON.stringify(FALLBACK_POLICY_TEMPLATE, null, 2);
  }
  const policy = JSON.parse(content) as Record<string, unknown>;
  policy.default_action = POLICY_DEFAULT_ACTION;
  await writeFile(target, `${JSON.stringify(policy, null, 2)}\n`, 'utf-8');
  logger.info(`[bootstrap] ${POLICY_FILE_REL} missing, created from template ${POLICY_TEMPLATE_FILE} (default_action -> ${POLICY_DEFAULT_ACTION})`);
}
