/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : test_work.mjs
 * Author     : MsgFerry
 * Date       : 2026/08/08
 * Version    : 0.0.1
 * Description: 测试辅助脚本——创建 test/temp 共享目录并启动 Worker 进程
 *
 * 用法：
 *   node test/test_work.mjs [options]
 *
 * 选项：
 *   --executor mock|ssh2   SSH 执行器选择，默认 mock
 *   --ssh-host <host>      SSH 主机（ssh2 模式必填）
 *   --ssh-port <port>      SSH 端口，默认 22
 *   --ssh-user <user>      SSH 用户名
 *   --ssh-key <path>       SSH 私钥路径
 *   --ssh-password <pass>  SSH 密码
 *
 * 行为：
 *   1. 在项目根目录下创建 test/temp 目录作为 HGFS 共享根目录
 *   2. 写入测试用宽松策略 policy/policy.json（default_action=allow），
 *      放行多命令串联（cd /tmp && pwd && ls）、换行多条命令等真实场景
 *   3. 启动 Worker 进程（mock 模式），将 stderr 转发到当前进程
 *   4. 收到 SIGINT/SIGTERM 时优雅终止 Worker 并清理
 * ======================================================
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const tempDir = join(__dirname, 'temp');
const workerJs = resolve(projectRoot, 'dist', 'msgferry-worker', 'index.mjs');

// 解析命令行参数
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    executor: 'mock',
    sshHost: undefined,
    sshPort: undefined,
    sshUser: undefined,
    sshKey: undefined,
    sshPassword: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--executor':
        opts.executor = args[++i];
        break;
      case '--ssh-host':
        opts.sshHost = args[++i];
        break;
      case '--ssh-port':
        opts.sshPort = args[++i];
        break;
      case '--ssh-user':
        opts.sshUser = args[++i];
        break;
      case '--ssh-key':
        opts.sshKey = args[++i];
        break;
      case '--ssh-password':
        opts.sshPassword = args[++i];
        break;
    }
  }
  return opts;
}

const opts = parseArgs();

// 检查 Worker 编译产物
if (!existsSync(workerJs)) {
  console.error('[test_work] worker 产物不存在，请先构建：pnpm build');
  process.exit(1);
}

// 创建 test/temp 共享目录
console.log(`[test_work] 创建共享目录: ${tempDir}`);
mkdirSync(tempDir, { recursive: true });

// 写入测试用宽松策略：default_action=allow 且不拦截 && / ; / | / > 等参数模式，
// 便于 mcp-client 验证多命令串联（cd /tmp && pwd && ls、换行多条命令）等真实场景。
// 黑名单仍保留，危险命令（rm -rf / 等）依旧会被拦截；策略安全细节由 worker 单测覆盖。
const policyDir = join(tempDir, 'policy');
mkdirSync(policyDir, { recursive: true });
const testPolicy = {
  whitelist_prefixes: ['docker', 'kubectl', 'systemctl', 'journalctl', 'cat', 'ls', 'tail'],
  blacklist_patterns: ['rm -rf /', 'dd if=', 'mkfs', ':(){'],
  dangerous_param_patterns: [],
  default_action: 'allow',
};
writeFileSync(join(policyDir, 'policy.json'), JSON.stringify(testPolicy, null, 2), 'utf-8');
console.log('[test_work] 已写入测试宽松策略: policy/policy.json (default_action=allow, 不拦截串联/管道/重定向)');

// 组装 Worker 启动参数
// 只传 --hgfs-root / --executor，不显式传 audit/policy 路径：
// audit_log_dir / policy_file 由 Worker 依据共享根目录相对定位（<root>/logs/worker、<root>/policy/policy.json），
// 即使 bootstrap 首次生成的 config/worker.json 里带的是相对路径，多次重启也始终指向 test/temp 下的正确位置。
const workerArgs = ['--hgfs-root', tempDir, '--executor', opts.executor];
if (opts.sshHost) {
  workerArgs.push('--ssh-host', opts.sshHost);
}
if (opts.sshPort) {
  workerArgs.push('--ssh-port', opts.sshPort);
}
if (opts.sshUser) {
  workerArgs.push('--ssh-user', opts.sshUser);
}
if (opts.sshKey) {
  workerArgs.push('--ssh-key', opts.sshKey);
}
if (opts.sshPassword) {
  workerArgs.push('--ssh-password', opts.sshPassword);
}

console.log(`[test_work] 启动 Worker: node ${workerJs} ${workerArgs.join(' ')}`);
console.log(`[test_work]   audit_log_dir / policy_file 由 Worker 依据 --hgfs-root 相对定位（<root>/logs/worker、<root>/policy/policy.json）`);

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
