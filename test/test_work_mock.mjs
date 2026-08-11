/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : test_work_mock.mjs
 * Author     : MsgFerry
 * Date       : 2026/08/08
 * Version    : 0.0.3
 * Description: 测试辅助脚本——创建测试共享目录并启动 Worker 进程（mock 执行器）
 *
 * 用法：
 *   node test/test_work_mock.mjs [options]
 *
 * 选项：
 *   --exchange              文件交换服务器模式（默认 shared 共享目录模式）
 *   --log-save 1|true       业务日志使能（可选，默认不落盘）
 *   --log-dir <path>        业务日志目录（可选，默认 <temp>/logs/worker）
 *
 * 两种模式：
 *   shared（默认）：
 *     创建 test/temp 作为 HGFS 共享根目录，Worker 直接轮询该目录；
 *     写入宽松策略 + mock 配置，mcp-client 指向同一 test/temp。
 *   exchange：
 *     当前没有真实文件交换服务器，用 cp 命令模拟：
 *       - test/temp         内网本地目录（MCP 侧，含 outbound/inbound 镜像；由 MCP Server 连接时自动创建）
 *       - test/temp_server  模拟文件交换服务器根（sync-mock 的 MSGFERRY_SYNC_MOCK_SERVER）
 *       - test/temp_server/nfs/vm_share  Worker 挂载根（模拟真实 Y: 盘上的 nfs/vm_share）
 *     Worker --hgfs-root 指向 test/temp_server/nfs/vm_share（模板前缀 nfs/vm_share/ 的落点），
 *     配置 queue_mode: exchange，Worker 扫 outbound/ 领任务、结果写 inbound/；
 *     内网 MCP 侧通过 scripts/sync-mock.mjs（cp 模拟 file_transfer）完成
 *     单文件上传 + 整目录拉回，模板前缀（vm_share/、nfs/vm_share/）由同步命令承担。
 *     注：内网本地目录（test/temp 下的 outbound/inbound）不再由本脚本创建，
 *     而是由内网 MCP Server 在 MCP client 连接成功后识别到 exchange 模式时自动补齐。
 *
 * 行为：
 *   1. 创建测试目录（shared 用 test/temp，exchange 建 test/temp_server/nfs/vm_share）
 *   2. 写入测试用宽松策略 policy/policy.json（default_action=allow），
 *      放行多命令串联（cd /tmp && pwd && ls）、换行多条命令等真实场景
 *   3. 写入 Worker 配置（mock 模式 + queue_mode），executor 从配置文件读取
 *   4. 启动 Worker 进程（mock 模式），将 stderr 转发到当前进程
 *   5. 收到 SIGINT/SIGTERM 时优雅终止 Worker 并清理
 * ======================================================
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const tempDir = join(__dirname, 'temp');             // 内网本地 / 共享根目录
const serverDir = join(__dirname, 'temp_server');    // 模拟文件交换服务器根（sync-mock 的 MSGFERRY_SYNC_MOCK_SERVER）
const serverMount = join(serverDir, 'nfs', 'vm_share'); // Worker 挂载根（模拟真实 Y: 盘上的 nfs/vm_share）
const workerJs = resolve(projectRoot, 'dist', 'msgferry-worker', 'index.mjs');

// 解析命令行参数
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    exchange: false,
    logSave: undefined,
    logDir: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--exchange':
        opts.exchange = true;
        break;
      case '--log-save':
        opts.logSave = args[++i];
        break;
      case '--log-dir':
        opts.logDir = args[++i];
        break;
    }
  }
  return opts;
}

const opts = parseArgs();

// 检查 Worker 编译产物
if (!existsSync(workerJs)) {
  console.error('[test_work_mock] worker 产物不存在，请先构建：pnpm build');
  process.exit(1);
}

// exchange 模式：worker 读写模拟交换服务器挂载根（test/temp_server/nfs/vm_share），
// 内网本地目录（test/temp）与之隔离；sync-mock 服务器根仍为 test/temp_server。
const workerRoot = opts.exchange ? serverMount : tempDir;

console.log(`[test_work_mock] 模式: ${opts.exchange ? 'exchange（cp 模拟文件交换服务器）' : 'shared（共享目录）'}`);
if (opts.exchange) {
  console.log(`[test_work_mock] 内网本地目录(MSGFERRY_LOCAL_ROOT): ${tempDir}`);
  console.log(`[test_work_mock] 模拟交换服务器根(MSGFERRY_SYNC_MOCK_SERVER): ${serverDir}`);
  console.log(`[test_work_mock] Worker 挂载根(--hgfs-root): ${workerRoot}`);
}
console.log(`[test_work_mock] 创建共享目录: ${workerRoot}`);
mkdirSync(workerRoot, { recursive: true });
// 注意：内网本地目录（test/temp 下的 outbound/inbound 单向信箱）不再由 Worker 侧创建，
// 而是由内网 MCP Server 在 MCP client 连接成功后识别到 exchange 模式时自动补齐（见 server.ts）。
// 这里只负责创建 Worker 侧的挂载根与交换服务器根，内网侧目录由 MCP Server 自行确保。

// 写入测试用宽松策略：default_action=allow 且不拦截 && / ; / | / > 等参数模式，
// 便于 mcp-client 验证多命令串联（cd /tmp && pwd && ls、换行多条命令）等真实场景。
// 黑名单仍保留，危险命令（rm -rf / 等）依旧会被拦截；策略安全细节由 worker 单测覆盖。
const policyDir = join(workerRoot, 'policy');
mkdirSync(policyDir, { recursive: true });
const testPolicy = {
  whitelist_prefixes: ['docker', 'kubectl', 'systemctl', 'journalctl', 'cat', 'ls', 'tail'],
  blacklist_patterns: ['rm -rf /', 'dd if=', 'mkfs', ':(){'],
  dangerous_param_patterns: [],
  default_action: 'allow',
};
writeFileSync(join(policyDir, 'policy.json'), JSON.stringify(testPolicy, null, 2), 'utf-8');
console.log('[test_work_mock] 已写入测试宽松策略: policy/policy.json (default_action=allow, 不拦截串联/管道/重定向)');

// 写入测试用 worker 配置：mock 模式（executor 从配置文件读取）
// exchange 模式额外配置 queue_mode: exchange（worker 扫 outbound/、结果写 inbound/）
const configDir = join(workerRoot, 'config');
mkdirSync(configDir, { recursive: true });
const queueModeLine = opts.exchange ? 'queue_mode: exchange\n' : '';
const testConfig = `# 测试用 Worker 配置（mock 模式）
executor: mock
${queueModeLine}`;
writeFileSync(join(configDir, 'worker.yaml'), testConfig, 'utf-8');
console.log(`[test_work_mock] 已写入测试配置: config/worker.yaml (executor=mock${opts.exchange ? ', queue_mode=exchange' : ''})`);

// 组装 Worker 启动参数
const workerArgs = ['--hgfs-root', workerRoot];
if (opts.logSave !== undefined) {
  workerArgs.push('--log-save', opts.logSave);
}
if (opts.logDir !== undefined) {
  workerArgs.push('--log-dir', opts.logDir);
}

console.log(`[test_work_mock] 启动 Worker: node ${workerJs} ${workerArgs.join(' ')}`);

const worker = spawn('node', [workerJs, ...workerArgs], {
  stdio: ['pipe', 'inherit', 'inherit'],
});

worker.on('error', (err) => {
  console.error('[test_work_mock] Worker 启动失败:', err.message);
  process.exit(1);
});

worker.on('exit', (code, signal) => {
  console.log(`[test_work_mock] Worker 退出: code=${code} signal=${signal}`);
  process.exit(code ?? 0);
});

// 转发信号给 Worker
function forwardSignal(sig) {
  console.log(`[test_work_mock] 收到 ${sig}，转发给 Worker...`);
  worker.kill(sig);
}

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

console.log('[test_work_mock] Worker 已启动，等待 mcp-client 连接...');
console.log('[test_work_mock] 按 Ctrl+C 退出');
if (opts.exchange) {
  console.log('[test_work_mock] 提示：mcp-client 请用 --exchange 模式，例如：');
  console.log(`[test_work_mock]   node test/mcp-client.mjs --exchange`);
} else {
  console.log(`[test_work_mock] 提示：mcp-client 指向共享目录 test/temp，例如：`);
  console.log(`[test_work_mock]   MSGFERRY_LOCAL_ROOT=${tempDir} node test/mcp-client.mjs`);
}
