/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : mcp-client.mjs
 * Author     : MsgFerry
 * Date       : 2026/08/08
 * Version    : 0.0.1
 * Description: 测试辅助脚本——以 MCP SDK Client 身份启动并连接 MCP Server，调用工具
 *
 * 用法：
 *   node test/mcp-client.mjs [options]
 *
 * 选项：
 *   --hgfs-root <path>    HGFS 共享根目录，默认 test/temp
 *   --max-wait <ms>       任务最大等待时长，默认 30000
 *
 * 行为：
 *   1. 通过 StdioClientTransport 启动并连接 MCP Server 子进程
 *   2. 完成 initialize 握手
 *   3. 列出全部工具（tools/list）
 *   4. 依次调用四个工具并打印结果：
 *      - check_bridge_health
 *      - submit_ssh_task（docker ps）
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
const mcpJs = resolve(projectRoot, 'dist', 'mcp-server', 'index.mjs');

// 解析命令行参数
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    hgfsRoot: join(__dirname, 'temp'),
    maxWait: '30000',
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--hgfs-root':
        opts.hgfsRoot = args[++i];
        break;
      case '--max-wait':
        opts.maxWait = args[++i];
        break;
    }
  }
  return opts;
}

const opts = parseArgs();

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

async function main() {
  separator('启动 MCP Server 并连接');
  console.log(`  脚本路径: ${mcpJs}`);
  console.log(`  共享目录: ${opts.hgfsRoot}`);
  console.log(`  最大等待: ${opts.maxWait}ms`);

  // StdioClientTransport 会自动 spawn MCP Server 子进程
  const transport = new StdioClientTransport({
    command: 'node',
    args: [
      mcpJs,
      '--hgfs-root', opts.hgfsRoot,
      '--max-wait', opts.maxWait,
    ],
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

  // 2. submit_ssh_task
  separator('工具调用 2: submit_ssh_task');
  const taskId = randomUUID();
  console.log(`  提交命令: docker ps, task_id=${taskId}`);
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
  const submitResult = await client.callTool({
    name: 'submit_ssh_task',
    arguments: {
      cmd: 'docker ps',
      timeout_sec: 10,
      task_id: taskId,
    },
  });
  printResult('submit_ssh_task', submitResult, (sc) => {
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

  // 3. query_task_status
  separator('工具调用 3: query_task_status');
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
      task_id: taskId,
    },
  });
  printResult('query_task_status', queryResult, (sc) => {
    return sc?.task_id === taskId
      && sc?.status === 'completed'
      && typeof sc?.exit_code === 'number';
  });

  // 4. cancel_task（对一个不存在的 task_id 调用，预期 not_found）
  separator('工具调用 4: cancel_task');
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
