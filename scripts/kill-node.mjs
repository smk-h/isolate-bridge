import { execFileSync } from 'node:child_process';

// 扫描并杀死 Windows 下的 node 进程
// 用法: node scripts/kill-node.mjs [--dry-run] [--name <进程名>]
//   --dry-run 只列出进程不杀死
//   --name    指定进程名（默认 node.exe，Windows 上 node 进程名通常为 node.exe）
// 提示: 该脚本会同时杀死执行本脚本之外的所有 node.exe，包括 pm2、tsx、nodemon 等衍进程。
//       如需保留本脚本进程自身可加 --keep-self，但 node 单行执行时进程名同样是 node.exe。
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const nameFlagIdx = argv.indexOf('--name');
const procName = nameFlagIdx !== -1 && nameFlagIdx + 1 < argv.length ? argv[nameFlagIdx + 1] : 'node.exe';

function listPids(procName) {
  const stdout = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${procName}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const pids = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.replace(/^"|"$/g, '').split('","');
    if (cols.length >= 2 && /^\d+$/.test(cols[1])) pids.push(Number(cols[1]));
  }
  return pids;
}

// 排除脚本自身进程，避免强杀自己导致循环中断
const pids = listPids(procName).filter((pid) => pid !== process.pid);
console.log(`[kill-node] 发现 ${pids.length} 个 ${procName} 进程(已排除自身): ${pids.join(', ') || '(无)'}`);

if (pids.length === 0) process.exit(0);

if (dryRun) {
  console.log('[kill-node] --dry-run 模式，未执行杀死操作');
  process.exit(0);
}

for (const pid of pids) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'inherit', windowsHide: true });
  } catch (err) {
    console.error(`[kill-node] 杀死进程 ${pid} 失败: ${err.message}`);
  }
}
console.log(`[kill-node] 已尝试强制杀死 ${pids.length} 个进程`);
