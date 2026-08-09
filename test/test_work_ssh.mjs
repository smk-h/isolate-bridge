/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : test_ssh.mjs
 * Author     : MsgFerry
 * Date       : 2026/08/10
 * Version    : 0.0.1
 * Description: 测试辅助脚本——针对真实 SSH 设备：创建 test/temp_ssh 共享目录并
 *              以 ssh2 执行器启动 Worker，验证真实设备的命令执行
 *
 * 用法：
 *   node test/test_ssh.mjs [options]
 *
 * 选项（均可由环境变量覆盖，命令行优先级更高）：
 *   --host <ip>                  SSH 主机，默认取 MSGFERRY_SSH_HOST
 *   --port <port>                SSH 端口，默认 22
 *   --username <name>            SSH 用户名，默认 root
 *   --password <pass>            SSH 密码，默认 root
 *   --device <name>              config 中设备名，默认 default
 *   --log-save 1|true            业务日志使能（可选，默认不落盘）
 *
 * 行为：
 *   1. 在项目根目录下创建 test/temp_ssh 目录作为 HGFS 共享根目录
 *      （与 mock 的 test/temp 隔离，互不干扰）
 *   2. 写入测试用宽松策略 policy/policy.json（default_action=allow、危险参数
 *      模式清空），放行多命令串联（cd /tmp && pwd && ls）等真实场景
 *   3. 写入 executor=ssh2 的 config/worker.yaml，登记目标设备 SSH 连接信息
 *   4. 启动 Worker（真实 SSH 模式），将 stderr 转发到当前进程
 *   5. 收到 SIGINT/SIGTERM 时优雅终止 Worker
 *
 * 前置条件：
 *   - 目标设备已开机且 SSH 可达（22 端口）
 *   - 已构建产物：pnpm build
 * ======================================================
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const tempDir = join(__dirname, 'temp');
const workerJs = resolve(projectRoot, 'dist', 'msgferry-worker', 'index.mjs');

// 解析命令行参数与环境变量（命令行优先，其次环境变量，最后内置默认值）
function resolveOpt(name, envName, fallback) {
  return name !== undefined ? name : (process.env[envName] ?? fallback);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const raw = {
    host: undefined,
    port: undefined,
    username: undefined,
    password: undefined,
    device: undefined,
    logSave: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--host':
        raw.host = args[++i];
        break;
      case '--port':
        raw.port = args[++i];
        break;
      case '--username':
        raw.username = args[++i];
        break;
      case '--password':
        raw.password = args[++i];
        break;
      case '--device':
        raw.device = args[++i];
        break;
      case '--log-save':
        raw.logSave = args[++i];
        break;
    }
  }
  return {
    host: resolveOpt(raw.host, 'MSGFERRY_SSH_HOST', '192.168.16.107'),
    port: resolveOpt(raw.port, 'MSGFERRY_SSH_PORT', '22'),
    username: resolveOpt(raw.username, 'MSGFERRY_SSH_USER', 'root'),
    password: resolveOpt(raw.password, 'MSGFERRY_SSH_PASS', 'root'),
    device: resolveOpt(raw.device, 'MSGFERRY_SSH_DEVICE', 'default'),
    logSave: raw.logSave ?? process.env.MSGFERRY_LOG_SAVE,
  };
}

const opts = parseArgs();

// 检查 Worker 编译产物
if (!existsSync(workerJs)) {
  console.error('[test_ssh] worker 产物不存在，请先构建：pnpm build');
  process.exit(1);
}

// 创建 test/temp_ssh 共享目录
console.log(`[test_ssh] 创建共享目录: ${tempDir}`);
mkdirSync(tempDir, { recursive: true });

// 写入测试用宽松策略：default_action=allow 且危险参数模式为空，
// 便于验证多命令串联（cd /tmp && pwd && ls、换行多条命令）等真实场景；
// 黑名单仍保留，危险命令（rm -rf / 等）依旧会被拦截。
const policyDir = join(tempDir, 'policy');
mkdirSync(policyDir, { recursive: true });
const testPolicy = {
  whitelist_prefixes: ['docker', 'kubectl', 'systemctl', 'journalctl', 'cat', 'ls', 'tail', 'pwd', 'echo', 'uname', 'hostname'],
  blacklist_patterns: ['rm -rf /', 'dd if=', 'mkfs', ':(){'],
  dangerous_param_patterns: [],
  default_action: 'allow',
};
writeFileSync(join(policyDir, 'policy.json'), JSON.stringify(testPolicy, null, 2), 'utf-8');
console.log('[test_ssh] 已写入测试宽松策略: policy/policy.json (default_action=allow, 不拦截串联/管道/重定向)');

// 写入测试用 worker 配置：executor=ssh2，登记目标设备 SSH 连接信息
const configDir = join(tempDir, 'config');
mkdirSync(configDir, { recursive: true });
const testConfig = `# 测试用 Worker 配置（真实 SSH 模式）
executor: ssh2
devices:
  ${opts.device}:
    host: ${opts.host}
    port: ${opts.port}
    username: ${opts.username}
    password: ${opts.password}
`;
writeFileSync(join(configDir, 'worker.yaml'), testConfig, 'utf-8');
console.log(`[test_ssh] 已写入测试配置: config/worker.yaml (executor=ssh2, device=${opts.device} ${opts.username}@${opts.host}:${opts.port})`);

// 组装 Worker 启动参数
const workerArgs = ['--hgfs-root', tempDir];
if (opts.logSave !== undefined) {
  workerArgs.push('--log-save', opts.logSave);
}

console.log(`[test_ssh] 启动 Worker: node ${workerJs} ${workerArgs.join(' ')}`);
console.log('[test_ssh]   每条命令会真实 SSH 到目标设备执行，请确认设备可达');

const worker = spawn('node', [workerJs, ...workerArgs], {
  stdio: ['pipe', 'inherit', 'inherit'],
});

worker.on('error', (err) => {
  console.error('[test_ssh] Worker 启动失败:', err.message);
  process.exit(1);
});

worker.on('exit', (code, signal) => {
  console.log(`[test_ssh] Worker 退出: code=${code} signal=${signal}`);
  process.exit(code ?? 0);
});

// 转发信号给 Worker
function forwardSignal(sig) {
  console.log(`[test_ssh] 收到 ${sig}，转发给 Worker...`);
  worker.kill(sig);
}

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

console.log('[test_ssh] Worker 已启动（真实 SSH 模式），等待 mcp-client 连接...');
console.log('[test_ssh] 按 Ctrl+C 退出');
console.log(`[test_ssh] 提示：mcp-client 需指向共享目录 test/temp_ssh，例如：`);
console.log(`[test_ssh]   MSGFERRY_HGFS_ROOT=${tempDir} node test/mcp-client.mjs`);
