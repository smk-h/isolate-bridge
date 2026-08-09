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
 *   node test/mcp-client.mjs
 *
 * 说明：脚本内部会自动为 MCP Server 子进程主动赋值全部所需环境变量，
 *   无需在外部自行配置。外部环境变量存在时以外部为准，否则用内置默认值：
 *   MSGFERRY_HGFS_ROOT         HGFS 共享根目录，默认 test/temp
 *   MSGFERRY_MAX_WAIT_MS       任务最大等待时长，默认 30000
 *   MSGFERRY_POLLING_INITIAL   轮询起步间隔，默认 500
 *   MSGFERRY_POLLING_MAX       轮询退避上限，默认 3000
 *   LOG_SAVE                   是否启用 MCP Server 业务日志落盘，默认 1
 *   LOG_DIR                    业务日志目录，缺省 <hgfs_root>/logs/mcp-server
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
 *   - test/temp 目录已由 test_work.mjs 创建
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

// 解析配置：外部环境变量存在时以外部为准，否则脚本内部主动赋值内置默认值，
// 保证 `node test/mcp-client.mjs` 无需任何外部配置即可直接运行。
// （注：MCP Server 已收敛为纯环境变量注入，不再解析命令行参数。）
function resolveEnvVar(name, fallback) {
  return process.env[name] !== undefined && process.env[name] !== ''
    ? process.env[name]
    : fallback;
}

function parseOpts() {
  const opts = {
    hgfsRoot: resolveEnvVar('MSGFERRY_HGFS_ROOT', join(__dirname, 'temp')),
    maxWait: resolveEnvVar('MSGFERRY_MAX_WAIT_MS', '30000'),
    pollingInitial: resolveEnvVar('MSGFERRY_POLLING_INITIAL', '500'),
    pollingMax: resolveEnvVar('MSGFERRY_POLLING_MAX', '3000'),
    logSave: resolveEnvVar('LOG_SAVE', '1'),
    logDir: resolveEnvVar('LOG_DIR', undefined),
  };
  return opts;
}

/**
 * 组装传给 MCP Server 子进程的环境变量
 * StdioClientTransport 默认只继承白名单环境变量（HOME / PATH / USER 等），
 * MSGFERRY_* / LOG_SAVE / LOG_DIR 不会自动透传，需在此显式指定。
 * 脚本在内部为全部所需环境变量主动赋值（外部未设置则用内置默认值），
 * 无需用户在运行 `node test/mcp-client.mjs` 前自行配置任何环境变量。
 */
function buildServerEnv(opts) {
  const env = {
    // HGFS 共享根目录（必填）与等待/轮询可调参数，均由脚本主动赋值
    MSGFERRY_HGFS_ROOT: opts.hgfsRoot,
    MSGFERRY_MAX_WAIT_MS: opts.maxWait,
    MSGFERRY_POLLING_INITIAL: opts.pollingInitial,
    MSGFERRY_POLLING_MAX: opts.pollingMax,
    // 业务日志：LOG_SAVE 默认落盘，LOG_DIR 缺省由 MCP Server 解析到
    // <hgfs_root>/logs/mcp-server（也可在此显式覆盖）
    LOG_SAVE: opts.logSave,
  };
  if (opts.logDir !== undefined) {
    env.LOG_DIR = opts.logDir;
  }
  return env;
}

const opts = parseOpts();

// 打印最终生效的环境变量，便于排查（外部覆盖 / 内置默认一目了然）
console.log('[mcp-client] 生效的环境变量:');
for (const [k, v] of Object.entries(buildServerEnv(opts))) {
  console.log(`  ${k}=${v}`);
}

// 检查 MCP Server 编译产物
if (!existsSync(mcpJs)) {
  console.error('[mcp-client] mcp-server 产物不存在，请先构建：pnpm build');
  process.exit(1);
}

// 检查共享目录
if (!existsSync(opts.hgfsRoot)) {
  console.error(`[mcp-client] 共享目录不存在: ${opts.hgfsRoot}`);
  console.error('[mcp-client] 请先运行: node test/test_work.mjs');
  process.exit(1);
}

/** 分隔线 */
function separator(title) {
  console.log('\n' + '='.repeat(60));
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

/**
 * 打印期望返回值
 * @param {string} label - 工具名称
 * @param {object} expected - 期望的 structuredContent 结构
 */
function printExpected(label, expected) {
  console.log(`\n  [期望返回值]`);
  console.log('  ' + JSON.stringify(expected, null, 2).replace(/\n/g, '\n  '));
}

/**
 * 打印实际返回值并断言
 * @param {string} label - 工具名称
 * @param {object} result - MCP CallToolResult
 * @param {function|null} assertFn - 断言函数，接收 structuredContent，返回 true/false
 */
function printResult(label, result, assertFn) {
  const sc = result.structuredContent;
  console.log(`\n  [实际返回值]`);
  console.log('  ' + JSON.stringify(sc, null, 2).replace(/\n/g, '\n  '));

  if (assertFn) {
    const passed = assertFn(sc);
    console.log(`\n  [断言] ${passed ? 'PASS' : 'FAIL'}`);
    if (!passed) {
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
  console.log(`\n  提交命令: ${cmd.replace(/\n/g, ' \\n ')}, task_id=${taskId}`);
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
    error_code: '<可选: worker_offline | duplicate_submit | execution_timeout>',
  });
  const result = await client.callTool({
    name: 'submit_ssh_task',
    arguments: {
      cmd,
      timeout_sec: extra.timeout_sec ?? 10,
      task_id: taskId,
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
  console.log(`  共享目录: ${opts.hgfsRoot}`);
  console.log(`  最大等待: ${opts.maxWait}ms`);
  console.log(`  轮询间隔: ${opts.pollingInitial}ms ~ ${opts.pollingMax}ms`);

  // StdioClientTransport 会自动 spawn MCP Server 子进程
  // 配置全部由 env 注入（MSGFERRY_* / LOG_SAVE / LOG_DIR），不再传命令行参数
  const transport = new StdioClientTransport({
    command: 'node',
    args: [mcpJs],
    env: buildServerEnv(opts),
    stderr: 'pipe',
  });

  // 转发 MCP Server 的 stderr 到当前进程
  transport.stderr?.on('data', (d) => {
    process.stderr.write('[mcp-server] ' + d.toString());
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
  for (const tool of toolsResult.tools) {
    console.log(`\n  --- ${tool.name} ---`);
    console.log(`  title: ${tool.title ?? '(无)'}`);
    console.log(`  description: ${tool.description ?? '(无)'}`);
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
  await runSubmitTask(client, 'docker ps', { timeout_sec: 10 });

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

  // 清理
  separator('测试完成，优雅退出');
  await client.close();

  console.log('\n测试全部完成。');
}

main().catch((err) => {
  console.error('[mcp-client] 致命错误:', err);
  process.exit(1);
});
