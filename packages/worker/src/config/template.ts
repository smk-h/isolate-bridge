/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : template.ts
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: 配置文件模板引导——启动时自动补齐 <root>/config/worker.yaml
 *   策略：检测目标文件是否存在，存在则跳过，不存在则从随产物分发的
 *   config.example.yaml 复制并重命名；模板文件缺失时走内联兜底。
 * ======================================================
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WORKER_CONFIG_FILE } from '@smai-kit/msgferry-shared';
import { logger } from '../log/index.js';

/** 随产物分发的配置模板文件名 */
const CONFIG_TEMPLATE_FILE = 'config.example.yaml';

/** 兜底配置模板（模板文件缺失时使用，内容与 config.example.yaml 保持一致，YAML 支持注释） */
const FALLBACK_CONFIG_TEMPLATE = `# Worker 配置文件示例（YAML 格式，支持注释）。
# 由 Worker 启动时自动写入共享目录 config/worker.yaml。
# worker 启动时只需 --hgfs-root 指向同一共享目录，其余参数自动从这里读取；
# 日志使能与目录通过命令行 --log-save / --log-dir 传递，不在本文件体现。
# 配置文件未定义的项走内置默认值。
# policy_file 建议省略或写相对共享根目录的路径（policy/policy.json），
# Worker 会依据 --hgfs-root 自动解析为绝对路径，避免示例绝对路径在重启后污染配置。

# 队列模式：shared（共享目录，免同步，默认）| exchange（文件交换服务器单向信箱）
# exchange 模式下 worker 扫描 outbound/ 领取任务，结果回写 inbound/，
# 心跳额外落 inbound/heartbeat.json；结果保留期建议调大到 3600。
queue_mode: shared

# SSH 执行器：mock（本地模拟）| ssh2（真实 SSH）
executor: ssh2

# 任务执行模式（通过此开关在「一次性命令」与「交互式 shell」之间切换）：
#   command：一次性命令（默认）——使用 SSH exec 通道执行单条命令，请求-响应式。
#   shell  ：交互式 shell ——使用 SSH shell 通道 + pty 执行命令，
#            适用于目标设备不支持 exec 通道、仅支持交互式登录 shell 的场景。
exec_mode: command

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
# 交换服务器模式（queue_mode: exchange）下内网拉回周期可能较长，
# 建议调大到 3600，避免结果没拉回就被 GC 清掉。
result_ttl_sec: 600

# stdout/stderr 内联字节数上限（超过则落 outputs/ 子目录）
max_inline_bytes: 65536
`;

/**
 * 解析模板文件所在目录（Worker 安装/产物目录）
 * - rollup 产物：index.mjs 与 config.example.yaml 同目录
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
 * 确保共享根目录下的配置文件就位：不存在时创建父目录并写入模板，已存在则跳过
 * @param root - HGFS 共享根目录
 */
export async function ensureConfigTemplate(root: string): Promise<void> {
  const target = join(root, WORKER_CONFIG_FILE);
  try {
    await access(target);
    return;
  } catch {
    // 目标文件不存在，继续复制模板
  }
  await mkdir(dirname(target), { recursive: true });
  const content = await loadTemplate(CONFIG_TEMPLATE_FILE, FALLBACK_CONFIG_TEMPLATE);
  await writeFile(target, content, 'utf-8');
  logger.info(`[bootstrap] ${WORKER_CONFIG_FILE} missing, created from template ${CONFIG_TEMPLATE_FILE}`);
}
