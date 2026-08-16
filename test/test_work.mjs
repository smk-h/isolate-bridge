/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : test_work.mjs
 * Author     : MsgFerry
 * Date       : 2026/08/16
 * Version    : 0.1.0
 * Description: 测试辅助脚本——从 test/config 模板创建测试共享目录并启动 Worker 进程
 *
 * 合并自原 test_work_mock.mjs / test_work_ssh.mjs：
 *   Worker 的 executor / queue_mode / devices 全部由 <hgfs-root>/config/worker.yaml
 *   决定，脚本只负责按模式复制对应配置模板 + 宽松策略，再启动 Worker。
 *
 * 用法：
 *   node test/test_work.mjs [options]
 *
 * 选项：
 *   --executor mock|ssh2      执行器类型（默认 mock）：决定使用哪份 config 模板
 *   --exchange                文件交换服务器模式（默认 shared 共享目录模式）
 *   --log-save 1|true         业务日志使能（可选，默认不落盘）
 *   --log-dir <path>          业务日志目录（可选，默认 <temp>/logs/worker）
 *
 * 配置模板（test/config/）：
 *   worker.mock.shared.yaml / worker.mock.exchange.yaml
 *   worker.ssh2.shared.yaml / worker.ssh2.exchange.yaml
 *   policy.test.json          （宽松策略：default_action=allow、放行串联/管道）
 *   设备信息在 ssh2 模板的 devices 块中静态配置（default / board-107 两套），
 *   连哪台设备由任务 device 字段决定（mcp-client 用 --device <name> 指定）。
 *
 * 两种模式：
 *   shared（默认）：
 *     创建 test/vm_share 作为 HGFS 共享根目录，Worker 直接轮询该目录；
 *     复制 shared 模板 + 宽松策略，mcp-client 指向同一 test/vm_share。
 *   exchange：
 *     当前没有真实文件交换服务器，用 cp 命令模拟：
 *       - test/msgferry/vm_share  内网本地目录（MCP 侧，含 outbound/inbound 镜像；由 MCP Server 连接时自动创建）
 *       - test/vm_share           模拟文件交换服务器根 / Worker 挂载根（sync-mock 的 MSGFERRY_SYNC_MOCK_SERVER）
 *     Worker --hgfs-root 指向 test/vm_share，复制 exchange 模板（queue_mode=exchange），
 *     Worker 扫 outbound/ 领任务、结果写 inbound/；
 *     内网 MCP 侧通过 scripts/sync-mock.mjs（cp 模拟 file_transfer）完成
 *     单文件上传 + 整目录拉回。
 *     注：内网本地目录（test/msgferry/vm_share 下的 outbound/inbound）由内网 MCP Server
 *     在 MCP client 连接成功后识别到 exchange 模式时自动补齐（见 server.ts）。
 *
 * 行为：
 *   1. 创建测试目录 test/vm_share（shared 与 exchange 均作为共享根/交换服务器挂载根）
 *   2. 从 test/config 复制对应配置模板到 <root>/config/worker.yaml
 *   3. 复制 test/config/policy.test.json 到 <root>/policy/policy.json（宽松策略）
 *   4. 启动 Worker 进程（executor 由配置决定），将 stderr 转发到当前进程
 *   5. 收到 SIGINT/SIGTERM 时优雅终止 Worker
 * ======================================================
 */

import { spawn } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const configDir = join(__dirname, 'config');            // 配置模板目录
const vmShareDir = join(__dirname, 'vm_share');         // 共享根 / 模拟交换服务器根（Worker --hgfs-root）
const workerJs = resolve(projectRoot, 'dist', 'msgferry-worker', 'index.mjs');

// 解析命令行参数
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    executor: 'mock',
    exchange: false,
    logSave: undefined,
    logDir: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--executor':
        opts.executor = args[++i];
        break;
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

// 校验 executor 类型：决定使用哪份 config 模板
if (opts.executor !== 'mock' && opts.executor !== 'ssh2') {
  console.error(`[test_work] 非法 executor: ${opts.executor}（仅支持 mock | ssh2）`);
  process.exit(1);
}
const queueMode = opts.exchange ? 'exchange' : 'shared';

// 检查 Worker 编译产物
if (!existsSync(workerJs)) {
  console.error('[test_work] worker 产物不存在，请先构建：pnpm build');
  process.exit(1);
}

// 检查配置模板存在
const configTemplate = join(configDir, `worker.${opts.executor}.${queueMode}.yaml`);
const policyTemplate = join(configDir, 'policy.test.json');
if (!existsSync(configTemplate) || !existsSync(policyTemplate)) {
  console.error(`[test_work] 配置模板缺失，请检查 test/config/：${configTemplate}`);
  process.exit(1);
}

// 两种模式的 Worker 挂载根均为 test/vm_share：
//   shared：它就是共享根目录，Worker 直接轮询；
//   exchange：它就是模拟交换服务器根（Worker 读写 outbound/inbound），
//             内网本地目录（test/msgferry/vm_share）与之隔离，由 MCP 侧维护。
const workerRoot = vmShareDir;

console.log(`[test_work] 模式: executor=${opts.executor} ${opts.exchange ? 'exchange（cp 模拟文件交换服务器）' : 'shared（共享目录）'}`);
if (opts.exchange) {
  console.log(`[test_work] 模拟交换服务器根(MSGFERRY_SYNC_MOCK_SERVER): ${vmShareDir}`);
  console.log(`[test_work] Worker 挂载根(--hgfs-root): ${workerRoot}`);
}
console.log(`[test_work] 创建共享目录: ${workerRoot}`);
mkdirSync(workerRoot, { recursive: true });
// 注意：内网本地目录（test/msgferry/vm_share 下的 outbound/inbound 单向信箱）不在此创建，
// 而是由内网 MCP Server 在 MCP client 连接成功后识别到 exchange 模式时自动补齐（见 server.ts）。
// 这里只负责创建 Worker 侧的共享根/挂载根，内网侧目录由 MCP Server 自行确保。

// 复制配置模板（executor/queue_mode/devices 全部静态，由 Worker 从 config/worker.yaml 读取）
const configTarget = join(workerRoot, 'config', 'worker.yaml');
mkdirSync(dirname(configTarget), { recursive: true });
copyFileSync(configTemplate, configTarget);
console.log(`[test_work] 已复制配置: ${configTemplate} -> ${configTarget}`);

// 复制宽松测试策略：default_action=allow 且不拦截串联/管道/重定向，
// 便于验证多命令串联（cd /tmp && pwd && ls、换行多条命令）等真实场景；
// 黑名单仍保留，危险命令（rm -rf / 等）依旧会被拦截。
const policyTarget = join(workerRoot, 'policy', 'policy.json');
mkdirSync(dirname(policyTarget), { recursive: true });
copyFileSync(policyTemplate, policyTarget);
console.log('[test_work] 已复制宽松策略: policy/policy.json (default_action=allow, 不拦截串联/管道/重定向)');

// 组装 Worker 启动参数
const workerArgs = ['--hgfs-root', workerRoot];
if (opts.logSave !== undefined) {
  workerArgs.push('--log-save', opts.logSave);
}
if (opts.logDir !== undefined) {
  workerArgs.push('--log-dir', opts.logDir);
}

console.log(`[test_work] 启动 Worker: node ${workerJs} ${workerArgs.join(' ')}`);

const worker = spawn('node', [workerJs, ...workerArgs], {
  stdio: ['pipe', 'inherit', 'inherit'],
});

worker.on('error', (err) => {
  console.error('[test_work] Worker 启动失败:', err.message);
  process.exit(1);
});

worker.on('exit', (code, signal) => {
  console.log(`[test_work] Worker 退出: code=${code} signal=${signal}`);
  process.exit(code ?? 0);
});

// 转发信号给 Worker
function forwardSignal(sig) {
  console.log(`[test_work] 收到 ${sig}，转发给 Worker...`);
  worker.kill(sig);
}

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

console.log('[test_work] Worker 已启动，等待 mcp-client 连接...');
console.log('[test_work] 按 Ctrl+C 退出');
if (opts.exchange) {
  console.log('[test_work] 提示：mcp-client 请用 --exchange 模式，例如：');
  console.log('[test_work]   node test/mcp-client.mjs --exchange');
} else {
  console.log(`[test_work] 提示：mcp-client 指向共享目录 test/vm_share，例如：`);
  console.log(`[test_work]   MSGFERRY_LOCAL_ROOT=${vmShareDir} node test/mcp-client.mjs`);
}