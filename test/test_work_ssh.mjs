/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : test_ssh.mjs
 * Author     : MsgFerry
 * Date       : 2026/08/10
 * Version    : 0.0.1
 * Description: 测试辅助脚本——针对真实 SSH 设备：创建共享目录并以 ssh2 执行器
 *              启动 Worker，验证真实设备的命令执行；支持 exchange 文件交换服务器模式
 *
 * 用法：
 *   node test/test_ssh.mjs [options]
 *
 * 选项（均可由环境变量覆盖，命令行优先级更高）：
 *   --exchange                  文件交换服务器模式（默认 shared 共享目录模式）
 *   --host <ip>                  SSH 主机，默认取 MSGFERRY_SSH_HOST
 *   --port <port>                SSH 端口，默认 22
 *   --username <name>            SSH 用户名，默认 root
 *   --password <pass>            SSH 密码，默认 root
 *   --device <name>              config 中设备名，默认 default；
 *                                传 local 自动使用本机 OpenSSH server 做模拟测试
 *                                （host=127.0.0.1, username=$USER，端口默认 22 可 --port 覆盖）
 *   --log-save 1|true            业务日志使能（可选，默认不落盘）
 *   --log-dir <path>             业务日志目录（可选，默认 <temp>/logs/worker）
 *
 * 两种模式：
 *   shared（默认）：创建 test/temp 作为 HGFS 共享根目录，Worker 直接轮询该目录，
 *     写入 executor=ssh2 + devices 配置，mcp-client 指向同一 test/temp。
 *   exchange：与 mock 脚本相同的文件交换服务器布局（cp 模拟 file_transfer）：
 *     - test/temp                    内网本地目录（MCP 侧，含 outbound/inbound 镜像）
 *     - test/temp_server             模拟文件交换服务器根（sync-mock 的 MSGFERRY_SYNC_MOCK_SERVER）
 *     - test/temp_server/nfs/vm_share Worker 挂载根（模拟真实 Y: 盘上的 nfs/vm_share）
 *     Worker --hgfs-root 指向 test/temp_server/nfs/vm_share，
 *     配置 queue_mode: exchange + executor=ssh2 + devices；mcp-client 需用 --exchange 配对。
 *
 * 行为：
 *   1. 创建共享目录（shared 用 test/temp；exchange 额外建 test/temp_server/nfs/vm_share
 *      及 test/temp 的 outbound/inbound）
 *   2. 写入测试用宽松策略 policy/policy.json（default_action=allow、危险参数
 *      模式清空），放行多命令串联（cd /tmp && pwd && ls）等真实场景
 *   3. 写入 executor=ssh2 的 config/worker.yaml（exchange 加 queue_mode: exchange），
 *      登记目标设备 SSH 连接信息
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
import { userInfo } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const tempDir = join(__dirname, 'temp');                // 内网本地 / 共享根目录
const serverDir = join(__dirname, 'temp_server');       // 模拟文件交换服务器根（sync-mock 的 MSGFERRY_SYNC_MOCK_SERVER）
const serverMount = join(serverDir, 'nfs', 'vm_share'); // Worker 挂载根（模拟真实 Y: 盘上的 nfs/vm_share）
const workerJs = resolve(projectRoot, 'dist', 'msgferry-worker', 'index.mjs');

// 解析命令行参数与环境变量（命令行优先，其次环境变量，最后内置默认值）
function resolveOpt(name, envName, fallback) {
  return name !== undefined ? name : (process.env[envName] ?? fallback);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const raw = {
    exchange: false,
    host: undefined,
    port: undefined,
    username: undefined,
    password: undefined,
    device: undefined,
    logSave: undefined,
    logDir: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--exchange':
        raw.exchange = true;
        break;
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
      case '--log-dir':
        raw.logDir = args[++i];
        break;
    }
  }
  return {
    exchange: raw.exchange,
    host: resolveOpt(raw.host, 'MSGFERRY_SSH_HOST', '192.168.16.107'),
    port: resolveOpt(raw.port, 'MSGFERRY_SSH_PORT', '22'),
    username: resolveOpt(raw.username, 'MSGFERRY_SSH_USER', 'root'),
    password: resolveOpt(raw.password, 'MSGFERRY_SSH_PASS', 'root'),
    device: resolveOpt(raw.device, 'MSGFERRY_SSH_DEVICE', 'default'),
    logSave: raw.logSave ?? process.env.MSGFERRY_LOG_SAVE,
    logDir: raw.logDir ?? process.env.MSGFERRY_LOG_DIR,
    passwordExplicit: raw.password !== undefined || process.env.MSGFERRY_SSH_PASS !== undefined,
  };
}

const opts = parseArgs();

// 本机模拟设备：设备名为 local 时，自动改用本机 OpenSSH server（host=127.0.0.1,
// username=$USER），无需准备外部真实设备即可做 SSH 模拟测试。
// 端口默认 22，可 --port 覆盖；密码默认用空串（多数发行版 root 免密，若需密码
// 可用 --password 显式传入），用户名优先取当前系统用户，支持 --username 覆盖。
if (opts.device === 'local') {
  const localUser = process.env.USER || userInfo().username || 'root';
  opts.host = '127.0.0.1';
  opts.username = localUser;
  // 密码默认用空串（多数发行版 root 免密/密钥登录）；若通过 --password 或
  // MSGFERRY_SSH_PASS 显式传入则保留，否则置空走免密/密钥认证。
  if (!opts.passwordExplicit) {
    opts.password = '';
  }
  // 端口沿用 --port / MSGFERRY_SSH_PORT，默认 22（本机 OpenSSH 标准端口）
  console.log('[test_ssh] 本机模拟设备 local：连接本机 OpenSSH server ' + localUser + '@127.0.0.1:' + opts.port);
}

// 检查 Worker 编译产物
if (!existsSync(workerJs)) {
  console.error('[test_ssh] worker 产物不存在，请先构建：pnpm build');
  process.exit(1);
}

// exchange 模式：worker 读写模拟交换服务器挂载根（test/temp_server/nfs/vm_share），
// 内网本地目录（test/temp）与之隔离；sync-mock 服务器根仍为 test/temp_server。
// shared 模式：worker 直接轮询 test/temp 共享目录。
const workerRoot = opts.exchange ? serverMount : tempDir;

console.log(`[test_ssh] 模式: ${opts.exchange ? 'exchange（cp 模拟文件交换服务器）' : 'shared（共享目录）'}`);
if (opts.exchange) {
  console.log(`[test_ssh] 内网本地目录(MSGFERRY_HGFS_ROOT): ${tempDir}`);
  console.log(`[test_ssh] 模拟交换服务器根(MSGFERRY_SYNC_MOCK_SERVER): ${serverDir}`);
  console.log(`[test_ssh] Worker 挂载根(--hgfs-root): ${workerRoot}`);
}
console.log(`[test_ssh] 创建共享目录: ${workerRoot}`);
mkdirSync(workerRoot, { recursive: true });
if (opts.exchange) {
  // 内网本地目录也建好 outbound/inbound，mcp-server 启动时会自动补齐 sent/
  mkdirSync(join(tempDir, 'outbound'), { recursive: true });
  mkdirSync(join(tempDir, 'inbound'), { recursive: true });
}

// 写入测试用宽松策略：default_action=allow 且危险参数模式为空，
// 便于验证多命令串联（cd /tmp && pwd && ls、换行多条命令）等真实场景；
// 黑名单仍保留，危险命令（rm -rf / 等）依旧会被拦截。
const policyDir = join(workerRoot, 'policy');
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
const configDir = join(workerRoot, 'config');
mkdirSync(configDir, { recursive: true });
// exchange 模式额外配置 queue_mode: exchange（worker 扫 outbound/、结果写 inbound/）
const queueModeLine = opts.exchange ? 'queue_mode: exchange\n' : '';
const testConfig = `# 测试用 Worker 配置（真实 SSH 模式）
executor: ssh2
${queueModeLine}devices:
  ${opts.device}:
    host: ${opts.host}
    port: ${opts.port}
    username: ${opts.username}
    password: ${opts.password}
`;
writeFileSync(join(configDir, 'worker.yaml'), testConfig, 'utf-8');
console.log(`[test_ssh] 已写入测试配置: config/worker.yaml (executor=ssh2${opts.exchange ? ', queue_mode=exchange' : ''}, device=${opts.device} ${opts.username}@${opts.host}:${opts.port})`);

// 组装 Worker 启动参数
const workerArgs = ['--hgfs-root', workerRoot];
if (opts.logSave !== undefined) {
  workerArgs.push('--log-save', opts.logSave);
}
if (opts.logDir !== undefined) {
  workerArgs.push('--log-dir', opts.logDir);
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
if (opts.exchange) {
  console.log('[test_ssh] 提示：mcp-client 请用 --exchange 模式，例如：');
  console.log('[test_ssh]   node test/mcp-client.mjs --exchange');
} else {
  console.log(`[test_ssh] 提示：mcp-client 需指向共享目录 test/temp，例如：`);
  console.log(`[test_ssh]   MSGFERRY_HGFS_ROOT=${tempDir} node test/mcp-client.mjs`);
}
if (opts.device === 'local') {
  console.log('[test_ssh] 提示：当前为本机模拟设备 local（连本机 OpenSSH server），' +
    '无需外部真实设备即可跑 ssh_shell_login / ssh_shell_exec / SFTP 上传下载');
  console.log('[test_ssh]   前置条件：本机已安装并启动 OpenSSH server（sudo apt install openssh-server && sudo systemctl start ssh）');
}
