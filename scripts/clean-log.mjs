import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

// 清理 MsgFerry 业务日志（mcp-server 与 worker 默认目录：logs/mcp-server、logs/worker）
// 用法: pnpm clean-log 或 node scripts/clean-log.mjs [--hgfs-root <路径>]
// 目录解析优先级:
//   --hgfs-root 参数 > MSGFERRY_HGFS_ROOT 环境变量 > 当前工作目录
//   LOG_DIR 环境变量可显式覆盖日志目录（绝对路径原样使用，相对路径基于 hgfs_root 解析），
//   此时仅清理 LOG_DIR 指向的目录
const argv = process.argv.slice(2);
const flagIdx = argv.indexOf('--hgfs-root');
const hgfsRoot =
  (flagIdx !== -1 && flagIdx + 1 < argv.length ? argv[flagIdx + 1] : undefined) ??
  process.env.MSGFERRY_HGFS_ROOT ??
  process.cwd();

const logDirRaw = process.env.LOG_DIR;
// 未设置 LOG_DIR 时清理 mcp-server 与 worker 两个默认目录
const logDirs = logDirRaw
  ? [isAbsolute(logDirRaw) ? logDirRaw : join(hgfsRoot, logDirRaw)]
  : [join(hgfsRoot, 'logs', 'mcp-server'), join(hgfsRoot, 'logs', 'worker')];

for (const logDir of logDirs) {
  if (!existsSync(logDir)) {
    console.log(`[clean-log] no log dir, nothing to clean: ${logDir}`);
    continue;
  }
  rmSync(logDir, { recursive: true, force: true });
  console.log(`[clean-log] removed business log dir: ${logDir}`);
}
