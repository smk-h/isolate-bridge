# MsgFerry mcp-server Tasks（ch03）

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `packages/mcp-server/src/config.ts` | 启动配置解析与校验 |
| 新建 | `packages/mcp-server/src/queue.ts` | 内网侧 HGFS 队列文件操作封装 |
| 新建 | `packages/mcp-server/src/backoff.ts` | 退避纯函数（与 worker 同构） |
| 新建 | `packages/mcp-server/src/tools.ts` | 四个 MCP 工具的核心业务逻辑 |
| 新建 | `packages/mcp-server/src/server.ts` | McpServer 创建、工具注册、StdioServerTransport 连接 |
| 新建 | `packages/mcp-server/src/main.ts` | 进程入口，组装模块，信号处理，优雅退出 |
| 修改 | `packages/mcp-server/src/index.ts` | 包入口，清除 console.log 占位，re-export main |

## T1: 配置模块

**文件：** `packages/mcp-server/src/config.ts`
**依赖：** @smai-kit/msgferry-shared（WAIT、POLLING 常量作为默认值）
**步骤：**
1. 文件头注释（与 worker 的 config.ts 同风格：版权块 + file name + author + date + version + description）。
2. import `{ WAIT, POLLING } from '@smai-kit/msgferry-shared'`，import `{ existsSync, accessSync, constants } from 'node:fs'`。
3. 定义 `McpServerConfig` 接口：`{ hgfs_root: string; max_wait_ms: number; polling: { initial_interval_ms: number; max_interval_ms: number } }`。
4. 实现 `getArg(argv: string[], flag: string, envKey?: string): string | undefined`：从 argv 解析 `--flag value`，未提供则查 env，均无返回 undefined。与 worker 的 getArg 同构。
5. 实现 `parseConfig(argv: string[], env: NodeJS.ProcessEnv): McpServerConfig`：
   - 解析 `--hgfs-root` / `MSGFERRY_HGFS_ROOT`
   - 解析 `--max-wait` / `MSGFERRY_MAX_WAIT_MS`（默认 WAIT.default_max_wait_ms）
   - 解析 `--polling-initial` / `MSGFERRY_POLLING_INITIAL`（默认 POLLING.initial_interval_ms）
   - 解析 `--polling-max` / `MSGFERRY_POLLING_MAX`（默认 POLLING.max_interval_ms）
   - 返回 McpServerConfig 对象
6. 实现 `validateConfig(config: McpServerConfig): void`：
   - `hgfs_root` 为空抛 `Error('hgfs_root is required')`
   - `hgfs_root` 不存在抛 `Error('hgfs_root does not exist: ...')`
   - `hgfs_root` 不可读写抛 `Error('hgfs_root is not readable/writable: ...')`（用 accessSync R_OK|W_OK）

**验证：** `cd packages/mcp-server && npx tsc --noEmit` 编译通过；临时脚本传入 `['node','main','--hgfs-root','/tmp/test-hgfs']`，断言 config.hgfs_root='/tmp/test-hgfs'、max_wait_ms=30000、polling.initial_interval_ms=500、polling.max_interval_ms=3000。

## T2: 队列模块

**文件：** `packages/mcp-server/src/queue.ts`
**依赖：** @smai-kit/msgferry-shared（QUEUE_DIRS、HEARTBEAT_FILE、CommandTask）；Node.js fs/promises、path
**步骤：**
1. 文件头注释（同风格）。
2. import `{ QUEUE_DIRS, HEARTBEAT_FILE } from '@smai-kit/msgferry-shared'`，import type `{ CommandTask } from '@smai-kit/msgferry-shared'`，import `{ join } from 'node:path'`，import `{ open, readFile, writeFile, readdir, mkdir, stat, rename } from 'node:fs/promises'`。
3. 定义 `Heartbeat` 接口：`{ pid: number; last_beat: number; processed_count: number; queue_depth: number; shutdown_at: number | null }`（与 worker 同构，mcp-server 不依赖 worker 包）。
4. 定义常量 `TMP_SUFFIX = '.tmp'`、`JSON_SUFFIX = '.json'`、`CANCELLED_RESULT_SUFFIX = '.result'`。
5. 实现 `initQueueDirs(root: string): Promise<void>`：对 QUEUE_DIRS 的七个目录名逐个 `mkdir(join(root, dir), { recursive: true })`。
6. 实现 `submitTask(root: string, task: CommandTask): Promise<void>`：原子写入 `pending/<task_id>.json`——先写 `.tmp` 再 rename。
7. 实现 `taskExists(root: string, taskId: string): Promise<'pending' | 'processing' | null>`：
   - stat `pending/<taskId>.json`，存在返回 'pending'
   - stat `processing/<taskId>.json`，存在返回 'processing'
   - 均不存在返回 null
   - stat 失败捕获异常返回 null
8. 实现 `readResult(root: string, taskId: string): Promise<CommandTask | null>`：
   - 依次尝试读 `completed/<taskId>.json`、`failed/<taskId>.json`、`cancelled/<taskId>.result`
   - 第一个读取成功的返回 CommandTask，全部不存在返回 null
   - 读取用 try-catch，文件不存在时 catch 返回 null
9. 实现 `readTaskFromDir(root: string, dir: 'pending' | 'processing', taskId: string): Promise<CommandTask | null>`：读 `<root>/<dir>/<taskId>.json`，不存在返回 null。
10. 实现 `checkCancelMarker(root: string, taskId: string): Promise<boolean>`：stat `cancelled/<taskId>` 是否存在（不带 .json 后缀，与 worker 的 checkCancelled 一致）。
11. 实现 `writeCancelMarker(root: string, taskId: string): Promise<void>`：原子写入 `cancelled/<taskId>` 空文件（.tmp → rename）。
12. 实现 `readHeartbeat(root: string): Promise<Heartbeat | null>`：读 `heartbeat.json`，不存在或解析失败返回 null。
13. 实现 `readOverflowOutput(root: string, relPath: string): Promise<string | null>`：拼接 `join(root, relPath)` 后 readFile，失败返回 null。

**验证：** `npx tsc --noEmit` 编译通过；临时脚本创建临时目录，调 initQueueDirs 确认七个目录创建；构造 CommandTask 调 submitTask 确认 pending/ 出现文件；调 taskExists 确认返回 'pending'；在 completed/ 手动放一个结果文件，调 readResult 确认返回；调 readHeartbeat 无文件时返回 null。

## T3: 退避模块

**文件：** `packages/mcp-server/src/backoff.ts`
**依赖：** 无
**步骤：**
1. 文件头注释（同风格）。
2. 定义 `BackoffState` 接口：`{ readonly current_interval_ms: number; reset(): void; next(): number }`。
3. 实现 `createBackoff(initial: number, max: number): BackoffState`：
   - 内部 `let current = initial`
   - `get current_interval_ms()` 返回 current
   - `reset()` 将 current 重置为 initial
   - `next()` 返回当前 current 后将 current 翻倍（`Math.min(current * 2, max)`）
4. 导出 createBackoff。

**验证：** `npx tsc --noEmit` 编译通过；临时脚本调 `createBackoff(500, 3000)`，连续 next() 返回 500/1000/2000/3000/3000，reset() 后返回 500。

## T4: 工具逻辑模块

**文件：** `packages/mcp-server/src/tools.ts`
**依赖：** T1（McpServerConfig 类型）、T2（queue 模块全部函数）、T3（createBackoff）；@smai-kit/msgferry-shared（CommandTask、TaskStatus、ErrorCode、HEARTBEAT、POLLING、WAIT、OUTPUT 常量）；Node.js crypto（randomUUID）
**步骤：**
1. 文件头注释（同风格）。
2. import `{ randomUUID } from 'node:crypto'`。
3. import `{ CommandTask, TaskStatus, ErrorCode, HEARTBEAT, POLLING, WAIT, OUTPUT } from '@smai-kit/msgferry-shared'`。
4. import `{ McpServerConfig } from './config.js'`。
5. import `{ submitTask, taskExists, readResult, readTaskFromDir, checkCancelMarker, writeCancelMarker, readHeartbeat, readOverflowOutput } from './queue.js'`。
6. import `{ createBackoff } from './backoff.js'`。
7. 定义参数与返回类型接口：`SubmitSshTaskParams`、`SubmitSshTaskResult`、`QueryTaskStatusResult`、`CancelTaskResult`、`CheckBridgeHealthResult`（字段见 plan.md 核心数据结构）。
8. 定义辅助函数 `sleep(ms: number): Promise<void>`。
9. 定义辅助函数 `makeCommandTask(taskId: string, cmd: string, timeoutSec: number): CommandTask`：组装初始 CommandTask（kind='command'，status='pending'，submit_time=Date.now()，其余执行字段为零值/null，max_inline_bytes=OUTPUT.max_inline_bytes）。
10. 定义辅助函数 `readOverflowIfTruncated(root: string, task: CommandTask): Promise<{ stdout: string; stderr: string; truncated: boolean; error_msg: string | null }>`：若 task.truncated 则按 stdout_overflow_path/stderr_overflow_path 调 readOverflowOutput 拼回；读取失败则保留 truncated=true 并在 error_msg 追加 'overflow_read_failed'。
11. 实现 `submitSshTask(config: McpServerConfig, root: string, params: SubmitSshTaskParams): Promise<SubmitSshTaskResult>`：
    - taskId = params.task_id ?? randomUUID()
    - timeoutSec = params.timeout_sec ?? 30
    - 幂等检查：`const existing = await taskExists(root, taskId)`；若非 null，返回 `{ task_id: taskId, status: existing, error_code: ErrorCode.DuplicateSubmit, ... }`
    - Worker 存活检查：`const hb = await readHeartbeat(root)`；若 null 或 `Date.now() - hb.last_beat > HEARTBEAT.expiry_sec * 1000` 或 `hb.shutdown_at !== null`，返回 `{ task_id: taskId, status: 'timeout', error_code: ErrorCode.WorkerOffline, ... }`
    - 组装 task = makeCommandTask(taskId, params.cmd, timeoutSec)
    - `await submitTask(root, task)`
    - 阻塞轮询：createBackoff(POLLING.initial_interval_ms, POLLING.max_interval_ms)，deadline = Date.now() + config.max_wait_ms
    - 循环：`const result = await readResult(root, taskId)`；若非 null 则 break；检查 `checkCancelMarker(root, taskId)` 若 true 则 break（返回 cancelled）；若 `Date.now() > deadline` 则 writeCancelMarker + 返回 execution_timeout；否则 `await sleep(backoff.next())`
    - 命中结果后调 readOverflowIfTruncated 拼回大输出
    - 计算 duration_ms = Date.now() - task.submit_time
    - 返回 SubmitSshTaskResult（含 status/exit_code/stdout/stderr/error_msg/truncated/stdout_size/stderr_size/duration_ms）
12. 实现 `queryTaskStatus(root: string, taskId: string): Promise<QueryTaskStatusResult>`：
    - `const result = await readResult(root, taskId)`；若非 null（completed/failed/cancelled.result），调 readOverflowIfTruncated 拼回，返回完整状态
    - `const cancelled = await checkCancelMarker(root, taskId)`；若 true 返回 `{ task_id, status: 'cancelled' }`
    - `const processing = await readTaskFromDir(root, 'processing', taskId)`；若非 null 返回 `{ task_id, status: 'processing' }`
    - `const pending = await readTaskFromDir(root, 'pending', taskId)`；若非 null 返回 `{ task_id, status: 'pending' }`
    - 全无返回 `{ task_id, error_code: 'not_found' }`
13. 实现 `cancelTask(root: string, taskId: string): Promise<CancelTaskResult>`：
    - 先调 queryTaskStatus 检查任务是否存在；若 error_code='not_found' 返回 `{ task_id, cancelled: false, error_code: 'not_found' }`
    - `await writeCancelMarker(root, taskId)`
    - 返回 `{ task_id, cancelled: true }`
14. 实现 `checkBridgeHealth(root: string): Promise<CheckBridgeHealthResult>`：
    - `const hb = await readHeartbeat(root)`
    - 若 null 返回 `{ online: false, reason: 'no_heartbeat' }`
    - 若 `hb.shutdown_at !== null` 返回 `{ online: false, reason: 'worker_shutdown', heartbeat: hb }`
    - age_sec = (Date.now() - hb.last_beat) / 1000
    - 若 `age_sec > HEARTBEAT.expiry_sec` 返回 `{ online: false, reason: 'heartbeat_expired', heartbeat: hb, age_sec }`
    - 否则返回 `{ online: true, heartbeat: hb, age_sec }`
15. 导出全部四个函数。

**验证：** `npx tsc --noEmit` 编译通过；临时脚本创建临时 HGFS 目录并 initQueueDirs，调 checkBridgeHealth 无 heartbeat.json 时返回 online=false + reason=no_heartbeat；手动写 heartbeat.json（shutdown_at=null, last_beat=Date.now()）后返回 online=true；构造 cancelled/ 取消标记后调 cancelTask 确认写入；调 queryTaskStatus 对不存在的 task_id 返回 not_found。

## T5: MCP 服务模块

**文件：** `packages/mcp-server/src/server.ts`
**依赖：** T4（tools 模块全部函数）、T1（McpServerConfig 类型）；@modelcontextprotocol/server（McpServer、StdioServerTransport）；zod
**步骤：**
1. 文件头注释（同风格）。
2. import `{ McpServer } from '@modelcontextprotocol/server'`；import `{ StdioServerTransport } from '@modelcontextprotocol/server/stdio'`。
3. import `{ z } from 'zod'`。
4. import `{ McpServerConfig } from './config.js'`。
5. import `{ submitSshTask, queryTaskStatus, cancelTask, checkBridgeHealth } from './tools.js'`。
6. 定义常量 `SERVER_NAME = '@smai-kit/msgferry-mcp-server'`、`SERVER_VERSION = '0.0.1'`。
7. 定义辅助函数 `makeTextResult(text: string): { content: [{ type: 'text'; text: string }] }`。
8. 定义辅助函数 `makeErrorResult(errorCode: string, errorMsg: string): { content: [...]; isError: true; structuredContent: { error_code: string; error_msg: string } }`。
9. 实现 `createMcpServer(config: McpServerConfig, root: string): McpServer`：
    - `const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })`
    - 注册 `submit_ssh_task`：
      - inputSchema: `z.object({ cmd: z.string().describe('待执行 SSH 命令'), timeout_sec: z.number().optional().describe('超时秒数，默认 30'), task_id: z.string().optional().describe('自定义任务标识，未提供则自动生成') })`
      - 回调：`async (args) => { try { const result = await submitSshTask(config, root, args); const text = JSON.stringify(result, null, 2); return { content: [{ type: 'text', text }], structuredContent: result }; } catch (e) { return makeErrorResult('unknown', String(e)); } }`
    - 注册 `query_task_status`：
      - inputSchema: `z.object({ task_id: z.string().describe('任务唯一标识') })`
      - 回调：`async (args) => { try { const result = await queryTaskStatus(root, args.task_id); return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result }; } catch (e) { return makeErrorResult('unknown', String(e)); } }`
    - 注册 `cancel_task`：
      - inputSchema: `z.object({ task_id: z.string().describe('任务唯一标识') })`
      - 回调：`async (args) => { try { const result = await cancelTask(root, args.task_id); return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result }; } catch (e) { return makeErrorResult('unknown', String(e)); } }`
    - 注册 `check_bridge_health`：
      - inputSchema: `z.object({})`
      - 回调：`async () => { try { const result = await checkBridgeHealth(root); return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result }; } catch (e) { return makeErrorResult('unknown', String(e)); } }`
    - 返回 server
10. 实现 `startServer(server: McpServer): Promise<void>`：
    - `const transport = new StdioServerTransport()`
    - `await server.connect(transport)`
    - console.error('[mcp-server] stdio transport connected') 到 stderr
11. 导出 createMcpServer、startServer。

**验证：** `npx tsc --noEmit` 编译通过；临时脚本调 createMcpServer 获取实例，断言 `typeof server.registerTool === 'function'`（验证工具已注册需通过实际 stdio 测试在 T6 集成验证）。

## T6: 主进程模块

**文件：** `packages/mcp-server/src/main.ts`
**依赖：** T1（parseConfig、validateConfig）、T2（initQueueDirs）、T5（createMcpServer、startServer）；@smai-kit/msgferry-shared
**步骤：**
1. 文件头注释（同风格）。
2. import `{ parseConfig, validateConfig } from './config.js'`。
3. import `{ initQueueDirs } from './queue.js'`。
4. import `{ createMcpServer, startServer } from './server.js'`。
5. 实现 `async function main(): Promise<void>`：
    - `const config = parseConfig(process.argv, process.env)`
    - `validateConfig(config)`（校验失败抛错，main 的 catch 中 process.exit(1)）
    - `console.error('[mcp-server] starting...')` 到 stderr
    - `await initQueueDirs(config.hgfs_root)`
    - `const server = createMcpServer(config, config.hgfs_root)`
    - `await startServer(server)`
    - `console.error('[mcp-server] ready, hgfs_root=' + config.hgfs_root)` 到 stderr
    - 信号处理：`process.on('SIGINT', gracefulShutdown)`、`process.on('SIGTERM', gracefulShutdown)`
    - 定义 `async function gracefulShutdown(): Promise<void>`：`await server.close()`、`process.exit(0)`
6. 作为主模块运行时自动调用 main：`if (import.meta.url === \`file://${process.argv[1]}\`) { main().catch((err) => { console.error('[mcp-server] fatal:', err); process.exit(1); }); }`
7. 导出 main。

**验证：** `npx tsc --noEmit` 编译通过；临时脚本创建临时 HGFS 目录，启动 main（`node dist/main.js --hgfs-root /tmp/test-hgfs`），观察：stderr 输出 starting/ready，七个子目录创建，进程不立即退出（等待 stdio），发 SIGTERM 后进程退出码 0。

## T7: 包入口改造

**文件：** `packages/mcp-server/src/index.ts`
**依赖：** T6
**步骤：**
1. 读取现有 index.ts 识别编码（UTF-8 无 BOM、LF）。
2. 删除 `export const PACKAGE_NAME`、`console.log("Hello, I'm mcp-server")`、现有注释块中的占位描述。
3. 改为：
   - 文件头注释（同风格，description 改为「@smai-kit/msgferry-mcp-server 包入口，re-export 全部模块」）
   - `export { main } from './main.js'`
   - `export * from './config.js'`
   - `export * from './queue.js'`
   - `export * from './backoff.js'`
   - `export * from './tools.js'`
   - `export * from './server.js'`
4. 按原编码写回（UTF-8 无 BOM、LF）。

**验证：** `npx tsc --noEmit` 编译通过；临时脚本 `import * as m from '@smai-kit/msgferry-mcp-server'`，断言 `typeof m.main === 'function'` 且 `typeof m.parseConfig === 'function'`、`typeof m.createMcpServer === 'function'` 等符号可访问。

## 执行顺序

```
T1（config）───┐
T2（queue）────┼──→ T4（tools）──→ T5（server）──→ T6（main）──→ T7（index）
T3（backoff）──┘
```

T1、T2、T3 互不依赖可并行；T4 依赖 T1/T2/T3；T5 依赖 T4；T6 依赖 T5；T7 收尾。
