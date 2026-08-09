import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// 启动 MsgFerry Worker 进程（Windows）
// 用法: node scripts/start-worker.mjs 或 pnpm start:worker
// 只传 --hgfs-root（必填）；日志使能/目录可通过追加参数 --log-save / --log-dir 传入（默认关闭、<hgfs_root>/logs/worker）
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const workerEntry = join(repoRoot, 'dist', 'msgferry-worker', 'index.mjs');

const hgfsRoot = process.env.MSGFERRY_HGFS_ROOT ?? 'E:\\MyLinux\\VMware\\sharedir\\vm_share';

const child = spawn(process.execPath, [workerEntry, '--hgfs-root', hgfsRoot, ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: 'inherit',
});

child.on('error', (err) => {
  console.error(`[start-worker] 启动 Worker 失败: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  console.log(`[start-worker] Worker 已退出 (code=${code}, signal=${signal ?? 'null'})`);
  process.exit(code ?? 0);
});
