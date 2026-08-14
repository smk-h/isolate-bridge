/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : test_worker_single.mjs
 * Author     : MsgFerry
 * Date       : 2026/08/12
 * Version    : 0.0.1
 * Description: 测试辅助脚本——单独测试 Worker（无需启动 MCP Server）
 *
 * 与 mcp-client 不同，本脚本不通过 MCP Server 提交任务，而是**直接操作共享目录**：
 * 在 Worker 的 HGFS 共享根目录下写入任务文件（shared 模式写 pending/，exchange
 * 模式写 outbound/），并轮询结果目录（shared 读 completed|failed/，exchange 读
 * inbound/），从而在**同一台主机 + 同一共享目录**下单独验证 Worker 的执行链路，
 * 把「生成任务 / 获取结果」的职责从 MCP 侧独立出来。
 *
 * 用法：
 *   node test/test_worker_single.mjs [options] [--cmd "命令1" --cmd "命令2" ...]
 *
 * 选项：
 *   --exchange              文件交换服务器模式（默认 shared 共享目录模式）
 *   --root <path>           共享根目录（默认 test/temp，与 test_work_mock.mjs 一致）
 *   --device <name>         目标设备名（写入任务的 device 字段，默认不填走默认设备）
 *   --cmd <str>             待提交命令（可多次传入，每次一个任务；缺省用内置默认命令集）
 *   --timeout <sec>         任务超时秒数（默认 10）
 *   --wait <ms>             等待结果的最大毫秒数（默认 30000，超时则打印当前状态）
 *   --poll <ms>             结果轮询间隔毫秒（默认 500）
 *   --keep                  测试结束后不清理已生成的任务/结果（默认清理 pending 与结果）
 *
 * 两种模式（与 test_work_mock.mjs / test_work_ssh.mjs 保持一致）：
 *   shared（默认）：
 *     Worker --hgfs-root 指向 test/temp，脚本往 test/temp/pending 写任务、
 *     从 test/temp/completed|failed 读结果，双方共用同一目录。
 *   exchange：
 *     脚本与 Worker 共用模拟交换服务器的挂载根 test/temp_server/nfs/vm_share
 *     （须先用 --exchange 启动 test_work_mock.mjs / test_work_ssh.mjs），
 *     脚本往 outbound/ 写任务、从 inbound/ 读 result_<id>.json 结果。
 *
 * 行为：
 *   1. 检查共享根目录（存在 Worker 心跳则打印，便于确认 Worker 已就绪）
 *   2. 按 queue_mode 写入任务文件到 pending/（shared）或 outbound/（exchange）
 *   3. 轮询结果目录直至拿到全部终态结果或超时
 *   4. 打印每个任务的执行结果（status / exit_code / stdout / stderr / error_msg）
 *   5. 汇总通过/失败统计；--keep 时可保留任务与结果文件供人工检查
 *
 * 前置条件：
 *   - Worker 已启动且 --hgfs-root 指向本脚本的共享根目录
 *     （shared：node test/test_work_mock.mjs；ssh2：node test/test_work_ssh.mjs）
 *   - 已构建产物：pnpm build（exchange 模式另需 scripts/sync-mock.mjs 配对）
 * ======================================================
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tempDir = join(__dirname, 'temp');                // shared 共享根目录（与 test_work_mock 一致）
const serverMount = join(__dirname, 'temp_server', 'nfs', 'vm_share'); // exchange 挂载根
const HEARTBEAT_FILE = 'heartbeat.json';

// 默认测试命令集：覆盖单命令、串联（&&）、换行多条、回显等常见场景，
// 便于在没有 MCP Server 的前提下快速验证 Worker 的完整执行链路。
const DEFAULT_CMDS = [
  'echo hello_from_worker_single',
  'pwd && ls -la',
  'echo line1 && echo line2',
];

/** 解析命令行参数 */
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    exchange: false,
    root: undefined,
    device: undefined,
    cmds: [],
    timeoutSec: 10,
    waitMs: 30000,
    pollMs: 500,
    keep: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--exchange':
        opts.exchange = true;
        break;
      case '--root':
        opts.root = args[++i];
        break;
      case '--device':
        opts.device = args[++i];
        break;
      case '--cmd':
        opts.cmds.push(args[++i]);
        break;
      case '--timeout':
        opts.timeoutSec = Number(args[++i]);
        break;
      case '--wait':
        opts.waitMs = Number(args[++i]);
        break;
      case '--poll':
        opts.pollMs = Number(args[++i]);
        break;
      case '--keep':
        opts.keep = true;
        break;
      default:
        console.error(`[test_worker_single] 未知参数: ${args[i]}`);
        process.exit(1);
    }
  }
  // 未显式传 --cmd 时使用内置默认命令集
  if (opts.cmds.length === 0) {
    opts.cmds = [...DEFAULT_CMDS];
  }
  return opts;
}

/**
 * 生成北京时间（CST）格式的任务产生时间字符串，与 shared/timestamp.ts 保持一致
 * 格式: YYYY-MM-DD HH:mm:ss.SSS（如 2026-08-14 08:12:07.123）
 */
function beijingSubmitTime(tsMs = Date.now()) {
  const d = new Date(tsMs);
  // 转成北京时区（CST, UTC+8）的各字段
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}.${ms}`;
}

/**
 * 生成任务文件基名（文件名时间部分 + 任务 id 前 8 位），与 shared/timestamp.ts 保持一致
 * 格式: yyyymmdd-hhmmssxxx-{task_id 前 8 位}
 */
function taskFileBaseName(submitTime, taskId) {
  const timePart = submitTime.replaceAll('-', '').replaceAll(':', '').replaceAll('.', '').replace(' ', '-');
  const shortId = taskId.slice(0, 8);
  return `${timePart}-${shortId}`;
}

/** 生成任务文件完整文件名（含 .json 后缀） */
function taskFileName(submitTime, taskId) {
  return `${taskFileBaseName(submitTime, taskId)}.json`;
}

/** 构造一个 pending 状态的 CommandTask 结构体（与 shared/tasks.ts 保持一致） */
function makeTask(cmd, device, timeoutSec) {
  const taskId = randomUUID();
  return {
    kind: 'command',
    task_id: taskId,
    batch_id: null,
    depends_on: [],
    cmd,
    device,                                  // 未指定则为 undefined，走默认设备
    timeout_sec: timeoutSec,
    submit_time: beijingSubmitTime(),        // 北京时区时间字符串（YYYY-MM-DD HH:mm:ss.SSS）
    start_time: 0,
    end_time: 0,
    stdout: '',
    stderr: '',
    stdout_size: 0,
    stderr_size: 0,
    truncated: false,
    stdout_overflow_path: null,
    stderr_overflow_path: null,
    max_inline_bytes: 65536,
    exit_code: null,
    error_msg: null,
    status: 'pending',
    worker_pid: null,
    policy_blocked: false,
  };
}

/** 读取共享根目录下的 Worker 心跳（存在则打印，便于确认 Worker 已就绪） */
function printHeartbeat(root) {
  const hbPath = join(root, HEARTBEAT_FILE);
  if (!existsSync(hbPath)) {
    console.log(`[test_worker_single] 未检测到心跳文件 ${HEARTBEAT_FILE}（Worker 可能尚未就绪或心跳目录不同）`);
    return;
  }
  try {
    const hb = JSON.parse(readFileSync(hbPath, 'utf-8'));
    console.log(`[test_worker_single] 检测到 Worker 心跳: pid=${hb.pid} processed=${hb.processed_count} queue_depth=${hb.queue_depth} last_beat=${new Date(hb.last_beat).toISOString()}`);
  } catch {
    console.log(`[test_worker_single] 心跳文件存在但解析失败: ${hbPath}`);
  }
}

/**
 * 写任务文件到对应队列目录
 * shared → pending/<任务文件名>.json；exchange → outbound/<任务文件名>.json
 * 文件名采用与 Worker 一致的规范命名：yyyymmdd-hhmmssxxx-{task_id 前 8 位}.json
 */
function writeTasks(root, tasks, exchange) {
  const dir = exchange ? 'outbound' : 'pending';
  const targetDir = join(root, dir);
  if (!existsSync(targetDir)) {
    console.error(`[test_worker_single] 任务目录不存在: ${targetDir}`);
    console.error(`[test_worker_single] 请先启动 Worker（它会自动创建队列目录）或手动创建。`);
    process.exit(1);
  }
  for (const task of tasks) {
    const fileName = taskFileName(task.submit_time, task.task_id);
    writeFileSync(join(targetDir, fileName), JSON.stringify(task, null, 2), 'utf-8');
    console.log(`[test_worker_single] 已写入任务: ${dir}/${fileName}`);
  }
}

/**
 * 扫描结果目录，收集各任务终态结果
 * shared → completed/ 与 failed/ 下规范命名的任务文件；exchange → inbound/ 下 result_*.json
 * 结果文件名采用 Worker 规范命名（yyyymmdd-hhmmssxxx-{task_id 前 8 位}.json），
 * 需读取文件内容按完整 task_id 匹配（与 Worker findTaskFileByTaskId 一致）。
 */
function collectResults(root, tasks, exchange) {
  const taskIds = new Set(tasks.map((t) => t.task_id));
  const found = new Map();
  const dirs = exchange ? ['inbound'] : ['completed', 'failed'];
  for (const dir of dirs) {
    const fullDir = join(root, dir);
    if (!existsSync(fullDir)) {
      continue;
    }
    for (const name of readdirSync(fullDir)) {
      if (!name.endsWith('.json') || name.endsWith('.tmp')) {
        continue;
      }
      try {
        const content = readFileSync(join(fullDir, name), 'utf-8');
        const parsed = JSON.parse(content);
        // 统一以文件内容中的完整 task_id 为准（结果文件内嵌完整 task_id，
        // shared 用规范任务文件名，exchange 用 result_ 前缀文件名，均可忽略）。
        const fileTaskId = parsed.task_id;
        if (fileTaskId && taskIds.has(fileTaskId)) {
          found.set(fileTaskId, parsed);
        }
      } catch (err) {
        console.error(`[test_worker_single] 读取结果失败 ${dir}/${name}: ${err.message}`);
      }
    }
  }
  return found;
}

/** 打印单个任务结果 */
function printResult(task, result) {
  const { task_id, cmd } = task;
  console.log(`\n  [任务 ${task_id.slice(0, 8)}]`);
  console.log(`    命令   : ${cmd.replace(/\n/g, ' \\n ')}`);
  if (!result) {
    console.log(`    状态   : 未拿到终态结果`);
    return;
  }
  console.log(`    状态   : ${result.status}`);
  if (result.status === 'cancelled') {
    console.log(`    已取消 : true`);
    return;
  }
  console.log(`    exit   : ${result.exit_code}`);
  console.log(`    stdout : ${(result.stdout ?? '').replace(/\n/g, '\\n')}`);
  console.log(`    stderr : ${(result.stderr ?? '').replace(/\n/g, '\\n')}`);
  if (result.error_msg) {
    console.log(`    error  : ${result.error_msg}`);
  }
  if (result.truncated) {
    console.log(`    大输出截断，溢出文件: stdout=${result.stdout_overflow_path} stderr=${result.stderr_overflow_path}`);
  }
  if (result.duration_ms !== undefined) {
    console.log(`    耗时   : ${result.duration_ms}ms`);
  }
}

/** 清理已提交任务的 pending/outbound 文件（保留结果便于人工检查，除非 --keep） */
function cleanupTasks(root, tasks, exchange) {
  const dir = exchange ? 'outbound' : 'pending';
  const targetDir = join(root, dir);
  for (const task of tasks) {
    const p = join(targetDir, taskFileName(task.submit_time, task.task_id));
    if (existsSync(p)) {
      rmSync(p, { force: true });
    }
  }
}

/**
 * 主流程：生成任务 → 等待 Worker 消费 → 获取结果 → 汇总
 */
async function main() {
  const opts = parseArgs();
  const root = opts.root ?? (opts.exchange ? serverMount : tempDir);
  const queueMode = opts.exchange ? 'exchange' : 'shared';

  console.log(`[test_worker_single] 模式      : ${queueMode === 'exchange' ? 'exchange（文件交换服务器）' : 'shared（共享目录）'}`);
  console.log(`[test_worker_single] 共享根目录: ${root}`);
  if (opts.device) {
    console.log(`[test_worker_single] 目标设备  : ${opts.device}`);
  }
  console.log(`[test_worker_single] 任务数    : ${opts.cmds.length}`);

  if (!existsSync(root)) {
    console.error(`[test_worker_single] 共享根目录不存在: ${root}`);
    console.error(`[test_worker_single] 请先启动 Worker（node test/test_work_mock.mjs${opts.exchange ? ' --exchange' : ''}）。`);
    process.exit(1);
  }

  printHeartbeat(root);

  // 1. 构造并写入任务
  const tasks = opts.cmds.map((cmd) => makeTask(cmd, opts.device, opts.timeoutSec));
  writeTasks(root, tasks, opts.exchange);

  // 2. 轮询等待结果
  const deadline = Date.now() + opts.waitMs;
  let results;
  while (Date.now() < deadline) {
    results = collectResults(root, tasks, opts.exchange);
    if (results.size === tasks.length) {
      break;
    }
    await sleep(opts.pollMs);
  }

  // 3. 打印结果
  console.log(`\n[test_worker_single] ${results.size}/${tasks.length} 个任务已拿到终态结果`);
  let pass = 0;
  let fail = 0;
  for (const task of tasks) {
    const result = results.get(task.task_id);
    printResult(task, result);
    if (result && result.status === 'completed') {
      pass++;
    } else {
      fail++;
    }
  }

  // 4. 汇总
  console.log(`\n[test_worker_single] 汇总: 完成=${pass} 失败=${fail}`);

  // 5. 清理（--keep 保留，便于人工检查；默认清理待办任务文件）
  if (!opts.keep) {
    cleanupTasks(root, tasks, opts.exchange);
    console.log(`[test_worker_single] 已清理 pending/outbound 任务文件（结果保留在 completed|failed/inbound）`);
  } else {
    console.log(`[test_worker_single] --keep 已设置，保留任务与结果文件`);
  }

  // 有未拿到结果的任务时返回非 0，方便 CI/脚本判断
  process.exit(fail > 0 ? 1 : 0);
}

/** 延时工具 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error('[test_worker_single] 运行失败:', err);
  process.exit(1);
});
