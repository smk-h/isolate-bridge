import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// 启动 MsgFerry Worker 进程（Windows）
// 用法: node scripts/start-worker.mjs 或 pnpm start:worker
// 必传 --hgfs-root（默认取 MSGFERRY_LOCAL_ROOT 环境变量，再回退到内置默认值）。
// 业务日志：写死使能（--log-save 1），目录走默认值（<hgfs_root>/logs/worker）。
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const workerEntry = join(repoRoot, 'dist', 'msgferry-worker', 'index.mjs');

const hgfsRoot = process.env.MSGFERRY_LOCAL_ROOT ?? 'E:\\MyLinux\\VMware\\sharedir\\vm_share';

// 命令行透传：--hgfs-root 必填，--log-save 1 写死使能业务日志，其余参数原样透传给 Worker 子进程
const child = spawn(
  process.execPath,
  [workerEntry, '--hgfs-root', hgfsRoot, '--log-save', '1', ...process.argv.slice(2)],
  {
    cwd: repoRoot,
    stdio: 'inherit',
  },
);

child.on('error', (err) => {
  console.error(`[start-worker] 启动 Worker 失败: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  console.log(`[start-worker] Worker 已退出 (code=${code}, signal=${signal ?? 'null'})`);
  process.exit(code ?? 0);
});
