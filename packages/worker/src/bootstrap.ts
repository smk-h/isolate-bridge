/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : bootstrap.ts
 * Author     : MsgFerry
 * Date       : 2026/08/08
 * Version    : 0.0.1
 * Description: 共享目录引导——启动时自动补齐 config/ 与 policy/ 目录及模板文件
 *             策略：检测目标文件是否存在，存在则跳过，不存在则从随产物分发的
 *             示例模板复制并重命名（config.example.yaml → config/worker.yaml，
 *             policy.example.json → policy/policy.json）。
 *             注意：复制策略模板时会把 default_action 由 deny 改写为 allow。
 *             （即自动生成的 policy.json 白名单未命中时默认放行，黑名单与
 *             危险参数模式仍生效）
 * ======================================================
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WORKER_CONFIG_FILE } from '@smai-kit/msgferry-shared';
import { logger } from './log.js';

/** 随产物分发的配置模板文件名 */
const CONFIG_TEMPLATE_FILE = 'config.example.yaml';
/** 随产物分发的策略模板文件名 */
const POLICY_TEMPLATE_FILE = 'policy.example.json';
/** 默认策略文件相对路径（共享根目录 policy/ 子目录） */
const POLICY_FILE_REL = 'policy/policy.json';

/** 兜底配置模板（模板文件缺失时使用，内容与 config.example.yaml 保持一致，YAML 支持注释） */
const FALLBACK_CONFIG_TEMPLATE = `# Worker 配置文件示例（YAML 格式，支持注释）。
# 由 Worker 启动时自动写入共享目录 config/worker.yaml。
# worker 启动时只需 --hgfs-root 指向同一共享目录，其余参数自动从这里读取；
# 日志使能与目录通过命令行 --log-save / --log-dir 传递，不在本文件体现。
# 配置文件未定义的项走内置默认值。
# policy_file 建议省略或写相对共享根目录的路径（policy/policy.json），
# Worker 会依据 --hgfs-root 自动解析为绝对路径，避免示例绝对路径在重启后污染配置。

# SSH 执行器：mock（本地模拟）| ssh2（真实 SSH）
executor: ssh2

# 多设备：设备名 → SSH 连接信息（设备名仅限字母/数字/下划线/连字符）
devices:
  default:
    host: 192.168.1.100
    port: 22
    username: root
    password: your_password
  board-100:
    host: 192.168.1.100
    port: 22
    username: root
    password: your_password
  board-101:
    host: 192.168.1.101
    port: 22
    username: admin
    password: another_password

# 策略文件路径（建议写相对共享根目录的路径，由 Worker 解析为绝对路径）
policy_file: policy/policy.json

# 轮询退避参数（毫秒）
polling:
  initial_interval_ms: 500
  max_interval_ms: 3000

# 心跳写入间隔（秒）
heartbeat_interval_sec: 5

# 结果文件保留期（秒）
result_ttl_sec: 600

# stdout/stderr 内联字节数上限（超过则落 outputs/ 子目录）
max_inline_bytes: 65536
`;

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
 * - rollup 产物：index.mjs 与 config.example.yaml / policy.example.json 同目录
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
 * 读取模板文件内容；文件缺失或不可读时返回内联兜底模板
 * @param file - 模板文件名（如 config.example.yaml）
 * @param fallback - 内联兜底模板文本
 * @returns 模板文件文本内容
 */
async function loadTemplate(file: string, fallback: string): Promise<string> {
  try {
    return await readFile(join(resolveTemplateDir(), file), 'utf-8');
  } catch {
    return fallback;
  }
}

/**
 * 确保共享根目录下的目标文件就位：不存在时创建父目录并写入模板，已存在则跳过
 * @param root - HGFS 共享根目录
 * @param relPath - 目标文件相对共享根的路径（如 config/worker.yaml）
 * @param templateFile - 随产物分发的模板文件名
 * @param fallback - 内联兜底模板文本
 */
async function ensureFileFromTemplate(
  root: string,
  relPath: string,
  templateFile: string,
  fallback: string,
): Promise<void> {
  const target = join(root, relPath);
  try {
    await access(target);
    return;
  } catch {
    // 目标文件不存在，继续复制模板
  }
  await mkdir(dirname(target), { recursive: true });
  const content = await loadTemplate(templateFile, fallback);
  await writeFile(target, content, 'utf-8');
  logger.info(`[bootstrap] ${relPath} missing, created from template ${templateFile}`);
}

/**
 * 写入策略模板：复制默认动作由 deny 改写为 allow（仅用于自动生成的
 * policy/policy.json；模板文件保持原样，已存在的策略文件不会被覆盖）
 * @param root - HGFS 共享根目录
 * @param relPath - 策略文件相对共享根的路径（policy/policy.json）
 */
async function ensurePolicyFile(root: string, relPath: string): Promise<void> {
  const target = join(root, relPath);
  try {
    await access(target);
    return;
  } catch {
    // 目标文件不存在，继续生成模板
  }
  await mkdir(dirname(target), { recursive: true });
  const content = await loadTemplate(POLICY_TEMPLATE_FILE, JSON.stringify(FALLBACK_POLICY_TEMPLATE, null, 2));
  const policy = JSON.parse(content) as Record<string, unknown>;
  policy.default_action = POLICY_DEFAULT_ACTION;
  await writeFile(target, `${JSON.stringify(policy, null, 2)}\n`, 'utf-8');
  logger.info(`[bootstrap] ${relPath} missing, created from template ${POLICY_TEMPLATE_FILE} (default_action -> ${POLICY_DEFAULT_ACTION})`);
}

/**
 * 启动引导：补齐共享目录的 config/ 与 policy/ 目录及模板文件
 * - <root>/config/worker.yaml 缺失时写入配置模板
 * - <root>/policy/policy.json 缺失时写入策略模板
 * 已存在的目录/文件不会被改动
 * @param root - HGFS 共享根目录
 */
export async function ensureSharedTemplates(root: string): Promise<void> {
  await ensureFileFromTemplate(root, WORKER_CONFIG_FILE, CONFIG_TEMPLATE_FILE, FALLBACK_CONFIG_TEMPLATE);
  await ensurePolicyFile(root, POLICY_FILE_REL);
}
