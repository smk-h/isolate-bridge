/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : mcp-client.mjs
 * Author     : MsgFerry
 * Date       : 2026/08/08
 * Version    : 0.1.0
 * Description: 测试辅助脚本——以 MCP SDK Client 身份启动并连接 MCP Server，调用工具
 *
 * 用法：
 *   node test/mcp-client.mjs [--exchange] [--device <name>] [--verbose]
 *
 * 说明：默认只打印摘要（工具名、命令、断言 PASS/FAIL、关键字段），
 *   --verbose 时打印完整期望/实际返回 JSON、工具详情与 MCP Server 全量日志。
 *
 * 说明：脚本内部会自动为 MCP Server 子进程主动赋值全部所需环境变量，
 *   无需在外部自行配置。配置以 JSON 对象 MCP_CONFIG 为统一来源，其内容
 *   即 dist/msgferry-mcp-server/.opencode/opencode.json 的 mcp 部分：
 *     - 普通模式从 mcp.msgferry-bridge.environment 解析
 *     - exchange 模式从 mcp.msgferry-bridge-exchange.environment 解析
 *   与真实使用基本一致，行为更可控。
 *
 *   --device <name>  可选，目标设备名（透传给 submit_ssh_task 的 device 参数）；
 *                    未指定时走默认设备。设备连接信息在 test/config 的 ssh2
 *                    配置模板 devices 块中静态配置（含 default / board-107）。
 *
 * 环境变量解析优先级：外部环境变量 > 测试覆盖默认值 > opencode.json 环境值。
 * 测试仅覆盖少数键使文件落在 test/vm_share（shared）/ test/msgferry/vm_share（exchange）且用 cp 模拟交换服务器：
 *   MSGFERRY_LOCAL_ROOT         内网本地根目录，shared 默认 test/vm_share；
 *                               exchange 默认 test/msgferry/vm_share。
 *                               若外部设置了该变量指向其他路径（如 $HOME），
 *                               脚本会打印告警提示测试文件不落在默认目录
 *   MSGFERRY_MAX_WAIT_MS        任务最大等待时长（来自 opencode.json）
 *   MSGFERRY_POLLING_INITIAL    轮询起步间隔（来自 opencode.json）
 *   MSGFERRY_POLLING_MAX        轮询退避上限（来自 opencode.json）
 *   LOG_SAVE                    是否启用 MCP Server 业务日志落盘（来自 opencode.json）
 *   LOG_DIR                     业务日志目录，缺省 <local_root>/logs/mcp-server
 *
 * --exchange 模式（文件交换服务器模式）：
 *   - 内网本地目录为 test/msgferry/vm_share，模拟交换服务器为 test/vm_share
 *   - MSGFERRY_SYNC_PUSH_CMD / PULL_CMD 默认用 scripts/sync-mock.mjs（cp 模拟
 *     file_transfer），沿用 opencode.json 的 {local_root} 模板写法；
 *     真实环境可外部覆盖回 file_transfer 命令
 *   - 需先以 --exchange 启动 test_work.mjs（worker 指向 test/vm_share）
 *
 * 行为：
 *   1. 通过 StdioClientTransport 启动并连接 MCP Server 子进程
 *   2. 完成 initialize 握手
 *   3. 列出全部工具（tools/list）
 *   4. 依次调用四个工具并打印结果：
 *      - check_bridge_health
 *      - submit_ssh_task（单条命令）
 *      - submit_ssh_task（多条命令串联：换行分隔，验证 && / ; 等价场景）
 *      - submit_ssh_task（多个独立任务连续提交）
 *      - query_task_status
 *      - cancel_task
 *   5. 测试完成后优雅退出
 *
 * 前置条件：
 *   - shared：test/vm_share 为共享根目录（由 test_work.mjs 创建）
 *   - exchange：内网本地 test/msgferry/vm_share（含 outbound/inbound 单向信箱）由 MCP Server 在连接成功后自动创建
 *   - Worker 进程已启动且心跳已写入
 * ======================================================
 */

import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const mcpJs = resolve(projectRoot, 'dist', 'msgferry-mcp-server', 'index.mjs');

// =====================================================
// 统一配置源：内联 dist/msgferry-mcp-server/.opencode/opencode.json 的 mcp 部分，
// 并把 MCP 侧路径与模拟同步命令的测试覆盖值直接配置在 environment 中：
//   - shared：MSGFERRY_LOCAL_ROOT = test/vm_share（与 Worker 共享根一致）
//   - exchange：MSGFERRY_LOCAL_ROOT = test/msgferry/vm_share（内网本地根，与服务器隔离）
//     MSGFERRY_SYNC_MOCK_SERVER = test/vm_share（模拟交换服务器根 = Worker 挂载根）
//     MSGFERRY_SYNC_PUSH_CMD / PULL_CMD 用 scripts/sync-mock.mjs（cp 模拟 file_transfer）
// 后续解析只做「外部环境变量 > MCP_CONFIG 默认值」，外部未设置即用这里的值。
// =====================================================
const testShareRoot = join(__dirname, 'vm_share');                // 共享根 / 模拟交换服务器根
const testMcpLocalRoot = join(__dirname, 'msgferry', 'vm_share'); // 内网本地根（exchange）
const syncMockCmd = `node ${join(projectRoot, 'scripts', 'sync-mock.mjs')}`;

const MCP_CONFIG = {
  mcp: {
    'msgferry-bridge': {
      environment: {
        MSGFERRY_LOCAL_ROOT: testShareRoot,
        MSGFERRY_MAX_WAIT_MS: '30000',
        MSGFERRY_POLLING_INITIAL: '500',
        MSGFERRY_POLLING_MAX: '3000',
        LOG_SAVE: '1',
      },
    },
    'msgferry-bridge-exchange': {
      environment: {
        MSGFERRY_LOCAL_ROOT: testMcpLocalRoot,
        MSGFERRY_MAX_WAIT_MS: '120000',
        MSGFERRY_POLLING_INITIAL: '500',
        MSGFERRY_POLLING_MAX: '3000',
        MSGFERRY_SYNC_PUSH_CMD: `${syncMockCmd} -pd {local_root}/{src} {dst}`,
        MSGFERRY_SYNC_PULL_CMD: `${syncMockCmd} -g inbound {local_root}/inbound`,
        MSGFERRY_SYNC_TIMEOUT_MS: '30000',
        MSGFERRY_SYNC_RETRIES: '3',
        MSGFERRY_SYNC_MOCK_SERVER: testShareRoot,
        LOG_SAVE: '1',
      },
    },
  },
};

// 解析配置：路径/同步命令等默认值统一取自 MCP_CONFIG，只叠加外部环境变量覆盖
// （优先级：外部 process.env > MCP_CONFIG environment），外部未设置即用 MCP_CONFIG 里的值。
function parseOpts() {
  const exchange = process.argv.includes('--exchange');
  const serverKey = exchange ? 'msgferry-bridge-exchange' : 'msgferry-bridge';
  const baseEnv = MCP_CONFIG.mcp[serverKey].environment;

  /**
   * 解析单个环境变量：
   * 优先级：外部 process.env > MCP_CONFIG 默认值。
   */
  function pick(name) {
    if (process.env[name] !== undefined && process.env[name] !== '') {
      return process.env[name];
    }
    const v = baseEnv[name];
    return v !== undefined && v !== '' ? v : undefined;
  }

  const opts = { exchange, verbose: process.argv.includes('--verbose') };
  opts.localRoot = pick('MSGFERRY_LOCAL_ROOT');
  opts.maxWait = pick('MSGFERRY_MAX_WAIT_MS');
  opts.pollingInitial = pick('MSGFERRY_POLLING_INITIAL');
  opts.pollingMax = pick('MSGFERRY_POLLING_MAX');
  opts.logSave = pick('LOG_SAVE');
  opts.logDir = pick('LOG_DIR');
  opts.syncTimeoutMs = pick('MSGFERRY_SYNC_TIMEOUT_MS');
  opts.syncRetries = pick('MSGFERRY_SYNC_RETRIES');

  // 目标设备名：可选 --device <name>，透传给 submit_ssh_task（未指定走默认设备）
  const deviceArg = process.argv.indexOf('--device');
  opts.device = deviceArg !== -1 && deviceArg + 1 < process.argv.length
    ? process.argv[deviceArg + 1]
    : undefined;

  if (exchange) {
    // 同步命令与模拟交换服务器根均从 MCP_CONFIG 读取，外部可覆盖回真实 file_transfer
    opts.syncPushCmd = pick('MSGFERRY_SYNC_PUSH_CMD');
    opts.syncPullCmd = pick('MSGFERRY_SYNC_PULL_CMD');
    opts.syncMockServer = pick('MSGFERRY_SYNC_MOCK_SERVER');
  }
  return opts;
}

/**
 * 组装传给 MCP Server 子进程的环境变量
 * StdioClientTransport 默认只继承白名单环境变量（HOME / PATH / USER 等），
 * MSGFERRY_* / LOG_SAVE / LOG_DIR 不会自动透传，需在此显式指定。
 * 值统一取自 MCP_CONFIG（environment 默认值 + 外部环境变量覆盖），
 * 无需用户在运行 `node test/mcp-client.mjs` 前自行配置任何环境变量。
 */
function buildServerEnv(opts) {
  const env = {
    MSGFERRY_LOCAL_ROOT: opts.localRoot,
    MSGFERRY_MAX_WAIT_MS: opts.maxWait,
    MSGFERRY_POLLING_INITIAL: opts.pollingInitial,
    MSGFERRY_POLLING_MAX: opts.pollingMax,
    // 业务日志：LOG_SAVE 默认落盘，LOG_DIR 缺省由 MCP Server 解析到
    // <local_root>/logs/mcp-server（也可在此显式覆盖）
    LOG_SAVE: opts.logSave,
  };
  if (opts.logDir !== undefined) {
    env.LOG_DIR = opts.logDir;
  }
  // 文件交换服务器模式：注入同步命令（cp 模拟）与同步参数
  if (opts.exchange) {
    env.MSGFERRY_SYNC_PUSH_CMD = opts.syncPushCmd;
    env.MSGFERRY_SYNC_PULL_CMD = opts.syncPullCmd;
    env.MSGFERRY_SYNC_TIMEOUT_MS = opts.syncTimeoutMs;
    env.MSGFERRY_SYNC_RETRIES = opts.syncRetries;
    env.MSGFERRY_SYNC_MOCK_SERVER = opts.syncMockServer;
    // 内网本地根：sync-mock 定位本地任务文件的基准
    env.MSGFERRY_SYNC_MOCK_LOCAL = opts.localRoot;
  }
  return env;
}

const opts = parseOpts();

// 安全校验：测试脚本默认应使用测试目录作为共享根目录
// （shared=test/vm_share，exchange=test/msgferry/vm_share）。
// 若外部环境变量 MSGFERRY_LOCAL_ROOT 被设置为其他路径（如家目录/共享挂载点），
// 测试文件将不落在默认目录，此处打印告警以便及时发现。
const expectedRoot = opts.exchange ? join(__dirname, 'msgferry', 'vm_share') : join(__dirname, 'vm_share');
if (opts.localRoot !== expectedRoot) {
  console.warn(`\n[警告] MSGFERRY_LOCAL_ROOT 被外部环境变量覆盖，当前为: ${opts.localRoot}`);
  console.warn(`        测试文件将不落在 ${expectedRoot}，可能导致测试数据写到非预期目录。`);
  console.warn(`        如需使用默认测试目录，请先取消设置 MSGFERRY_LOCAL_ROOT 环境变量。\n`);
}

// 打印最终生效的环境变量，便于排查（--verbose 时显示，默认静默）
if (opts.verbose) {
  console.log('[mcp-client] 生效的环境变量:');
  for (const [k, v] of Object.entries(buildServerEnv(opts))) {
    console.log(`  ${k}=${v}`);
  }
}

// 检查 MCP Server 编译产物
if (!existsSync(mcpJs)) {
  console.error('[mcp-client] mcp-server 产物不存在，请先构建：pnpm build');
  process.exit(1);
}

// 检查内网本地根目录：shared 模式内网直接读写该目录，连接前必须已存在；
// exchange 模式内网本地目录（含 outbound/inbound 单向信箱）由 MCP Server 在
// 连接成功后识别到 exchange 模式时自动创建（见 server.ts），故连接前不强制要求。
if (!opts.exchange && !existsSync(opts.localRoot)) {
  console.error(`[mcp-client] 共享目录不存在: ${opts.localRoot}`);
  console.error('[mcp-client] 请先运行: node test/test_work.mjs');
  process.exit(1);
}

// 交换模式：检查模拟交换服务器与同步脚本
if (opts.exchange) {
  if (!existsSync(opts.syncMockServer)) {
    console.error(`[mcp-client] 模拟交换服务器目录不存在: ${opts.syncMockServer}`);
    console.error('[mcp-client] 请先运行: node test/test_work.mjs --exchange');
    process.exit(1);
  }
  if (!existsSync(join(projectRoot, 'scripts', 'sync-mock.mjs'))) {
    console.error('[mcp-client] 同步模拟脚本不存在: scripts/sync-mock.mjs');
    process.exit(1);
  }
}

/** 分隔线 */
function separator(title) {
  console.log('\n' + '='.repeat(60));
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

/**
 * 打印期望返回值（仅 --verbose 时输出）
 * @param {string} label - 工具名称
 * @param {object} expected - 期望的 structuredContent 结构
 */
function printExpected(label, expected) {
  if (!opts.verbose) return;
  console.log(`\n  [期望返回值]`);
  console.log('  ' + JSON.stringify(expected, null, 2).replace(/\n/g, '\n  '));
}

/**
 * 构造单行摘要（默认模式打印关键字段，避免整份 JSON 刷屏）
 * @param {object} sc - structuredContent
 * @returns {string} 单行摘要
 */
function compactSummary(sc) {
  if (!sc) return '(无 structuredContent)';
  const parts = [];
  if (sc.task_id) parts.push(`task_id=${sc.task_id.slice(0, 8)}`);
  if (sc.online !== undefined) parts.push(`online=${sc.online}`);
  if (sc.status) parts.push(`status=${sc.status}`);
  if (sc.cancelled !== undefined) parts.push(`cancelled=${sc.cancelled}`);
  if (sc.exit_code !== undefined) parts.push(`exit=${sc.exit_code}`);
  if (sc.duration_ms !== undefined) parts.push(`dur=${sc.duration_ms}ms`);
  if (sc.error_code) parts.push(`error_code=${sc.error_code}`);
  if (sc.error_msg) parts.push(`error=${sc.error_msg}`);
  if (sc.stdout) parts.push(`stdout=${sc.stdout.replace(/\n/g, ' ').slice(0, 80)}`);
  if (sc.stderr) parts.push(`stderr=${sc.stderr.replace(/\n/g, ' ').slice(0, 80)}`);
  return parts.join('  ') || JSON.stringify(sc);
}

/**
 * 打印实际返回值并断言
 * @param {string} label - 工具名称
 * @param {object} result - MCP CallToolResult
 * @param {function|null} assertFn - 断言函数，接收 structuredContent，返回 true/false
 */
function printResult(label, result, assertFn) {
  const sc = result.structuredContent;
  if (opts.verbose) {
    console.log(`\n  [实际返回值]`);
    console.log('  ' + JSON.stringify(sc, null, 2).replace(/\n/g, '\n  '));
  } else {
    console.log(`  ${compactSummary(sc)}`);
  }

  if (assertFn) {
    const passed = assertFn(sc);
    console.log(`  [断言] ${passed ? 'PASS' : 'FAIL'}`);
    if (!passed && opts.verbose) {
      console.log('  期望字段未全部满足，请检查上方实际返回值');
    }
  }
}

/**
 * 提交命令并打印结果（复用 submit_ssh_task 的期望/断言，供单条/多条场景共用）
 * @param {Client} client - MCP Client
 * @param {string} cmd - 待执行命令
 * @param {object} extra - 附加参数（timeout_sec / task_id 等）
 * @returns {object} 实际返回的 structuredContent
 */
async function runSubmitTask(client, cmd, extra = {}) {
  const taskId = extra.task_id ?? randomUUID();
  const device = extra.device ?? opts.device;
  console.log(`\n  提交命令: ${cmd.replace(/\n/g, ' \\n ')}, task_id=${taskId}${device ? `, device=${device}` : ''}`);
  printExpected('submit_ssh_task', {
    task_id: '<string>',
    status: '<completed | failed | cancelled | timeout>',
    exit_code: '<number | null>',
    stdout: '<string>',
    stderr: '<string>',
    error_msg: '<string | null>',
    truncated: '<boolean>',
    stdout_size: '<number>',
    stderr_size: '<number>',
    duration_ms: '<number>',
    error_code: '<可选: worker_offline | duplicate_submit | execution_timeout | sync_failed>',
  });
  const result = await client.callTool({
    name: 'submit_ssh_task',
    arguments: {
      cmd,
      timeout_sec: extra.timeout_sec ?? 10,
      task_id: taskId,
      ...(device ? { device } : {}),
    },
  });
  printResult('submit_ssh_task', result, (sc) => {
    return sc?.task_id === taskId
      && sc?.status === 'completed'
      && typeof sc?.exit_code === 'number'
      && typeof sc?.stdout === 'string'
      && typeof sc?.stderr === 'string'
      && typeof sc?.truncated === 'boolean'
      && typeof sc?.stdout_size === 'number'
      && typeof sc?.stderr_size === 'number'
      && typeof sc?.duration_ms === 'number';
  });
  return result.structuredContent;
}

async function main() {
  separator('启动 MCP Server 并连接');
  console.log(`  脚本路径: ${mcpJs}`);
  console.log(`  共享目录: ${opts.localRoot}`);
  console.log(`  最大等待: ${opts.maxWait}ms`);
  console.log(`  轮询间隔: ${opts.pollingInitial}ms ~ ${opts.pollingMax}ms`);
  console.log(`  同步模式: ${opts.exchange ? 'exchange（cp 模拟文件交换服务器）' : 'shared（共享目录）'}`);

  // StdioClientTransport 会自动 spawn MCP Server 子进程
  // 配置全部由 env 注入（MSGFERRY_* / LOG_SAVE / LOG_DIR），不再传命令行参数
  const transport = new StdioClientTransport({
    command: 'node',
    args: [mcpJs],
    env: buildServerEnv(opts),
    stderr: 'pipe',
  });

  // 转发 MCP Server 的 stderr：--verbose 全量转发；默认只转发含 error/warn/fail 的行，
  // 避免业务日志刷屏
  transport.stderr?.on('data', (d) => {
    const text = d.toString();
    if (opts.verbose || /error|warn|fail/i.test(text)) {
      process.stderr.write('[mcp-server] ' + text);
    }
  });

  const client = new Client(
    { name: 'test-mcp-client', version: '0.0.1' },
    { capabilities: {} },
  );

  await client.connect(transport);
  console.log('  Client 已连接');

  // 列出工具
  separator('tools/list');
  const toolsResult = await client.listTools();
  const toolNames = toolsResult.tools.map((t) => t.name);
  console.log('  注册的工具:', toolNames.join(', '));
  if (opts.verbose) {
    for (const tool of toolsResult.tools) {
      console.log(`\n  --- ${tool.name} ---`);
      console.log(`  title: ${tool.title ?? '(无)'}`);
      console.log(`  description: ${tool.description ?? '(无)'}`);
    }
  }

  // 1. check_bridge_health
  separator('工具调用 1: check_bridge_health');
  printExpected('check_bridge_health', {
    online: '<boolean>',
    reason: '<可选: no_heartbeat | heartbeat_expired | worker_shutdown>',
    heartbeat: '<可选: { pid, last_beat, processed_count, queue_depth, shutdown_at }>',
    age_sec: '<可选: number>',
  });
  const healthResult = await client.callTool({
    name: 'check_bridge_health',
    arguments: {},
  });
  printResult('check_bridge_health', healthResult, (sc) => {
    return typeof sc?.online === 'boolean';
  });

  // 2. submit_ssh_task（单条命令）
  separator('工具调用 2: submit_ssh_task（单条命令）');
  await runSubmitTask(client, 'uname -a', { timeout_sec: 10 });

  // 3. submit_ssh_task（多条命令串联：换行分隔，验证 cd && pwd && ls 的真实场景）
  separator('工具调用 3: submit_ssh_task（多条命令串联）');
  const multiLineCmd = 'cd /tmp/ && pwd && ls\necho "asd"';
  await runSubmitTask(client, multiLineCmd, { timeout_sec: 10 });

  // 4. submit_ssh_task（多个独立任务连续提交）
  separator('工具调用 4: submit_ssh_task（多任务连续提交）');
  const multiTaskCmds = [
    'ls -la /tmp',
    'cat /etc/hostname',
    'tail -3 /etc/os-release',
  ];
  const multiTaskResults = [];
  for (const cmd of multiTaskCmds) {
    const sc = await runSubmitTask(client, cmd, { timeout_sec: 10 });
    multiTaskResults.push(sc);
  }
  const allCompleted = multiTaskResults.every(
    (sc) => sc?.status === 'completed' && typeof sc?.stdout === 'string',
  );
  console.log(`\n  [多任务断言] ${allCompleted ? 'PASS' : 'FAIL'}（共 ${multiTaskResults.length} 个任务全部 completed）`);

  // 5. query_task_status（回查最后一个任务的终态结果）
  separator('工具调用 5: query_task_status');
  const queryTaskId = multiTaskResults[multiTaskResults.length - 1]?.task_id ?? randomUUID();
  printExpected('query_task_status', {
    task_id: '<string>',
    status: '<pending | processing | completed | failed | cancelled>',
    exit_code: '<可选: number | null>',
    stdout: '<可选: string>',
    stderr: '<可选: string>',
    error_msg: '<可选: string | null>',
    truncated: '<可选: boolean>',
    error_code: '<可选: not_found>',
  });
  const queryResult = await client.callTool({
    name: 'query_task_status',
    arguments: {
      task_id: queryTaskId,
    },
  });
  printResult('query_task_status', queryResult, (sc) => {
    return sc?.task_id === queryTaskId
      && sc?.status === 'completed'
      && typeof sc?.exit_code === 'number';
  });

  // 6. cancel_task（对一个不存在的 task_id 调用，预期 not_found）
  separator('工具调用 6: cancel_task');
  if (opts.exchange) {
    // 交换服务器模式：cancel 为尽力而为，无法可靠判断任务是否从未存在（本地无记录时
    // 也会推一个 cancel marker），因此对“已提交任务”验证取消成功、对随机 id 验证不报错。
    const cancelTaskId = multiTaskResults[0]?.task_id ?? randomUUID();
    console.log(`  对已提交任务 task_id=${cancelTaskId} 调用 cancel_task（exchange 模式预期 cancelled=true）`);
    printExpected('cancel_task (exchange 已提交任务)', {
      task_id: '<string>',
      cancelled: '<boolean>',
      error_code: '<可选: not_found>',
    });
    const cancelResult = await client.callTool({
      name: 'cancel_task',
      arguments: {
        task_id: cancelTaskId,
      },
    });
    printResult('cancel_task (exchange 已提交任务)', cancelResult, (sc) => {
      return sc?.task_id === cancelTaskId
        && sc?.cancelled === true;
    });
  } else {
    const cancelTaskId = randomUUID();
    console.log(`  对 task_id=${cancelTaskId} 调用 cancel_task（预期 not_found）`);
    printExpected('cancel_task (不存在的任务)', {
      task_id: '<string>',
      cancelled: '<boolean>',
      error_code: '<可选: not_found>',
    });
    const cancelResult = await client.callTool({
      name: 'cancel_task',
      arguments: {
        task_id: cancelTaskId,
      },
    });
    printResult('cancel_task (不存在的任务)', cancelResult, (sc) => {
      return sc?.task_id === cancelTaskId
        && sc?.cancelled === false
        && sc?.error_code === 'not_found';
    });
  }

  // 清理
  separator('测试完成，优雅退出');
  await client.close();

  console.log('\n测试全部完成。');
}

main().catch((err) => {
  console.error('[mcp-client] 致命错误:', err);
  process.exit(1);
});
