# MsgFerry worker Tasks（ch02）

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `packages/worker/src/index.ts` | 包入口，清除 console.log 占位，re-export main |
| 新建 | `packages/worker/src/config.ts` | 启动配置解析与校验 |
| 新建 | `packages/worker/src/backoff.ts` | 退避纯函数 |
| 新建 | `packages/worker/src/queue.ts` | HGFS 队列文件操作封装 |
| 新建 | `packages/worker/src/policy.ts` | 命令安全策略校验与策略文件加载 |
| 新建 | `packages/worker/src/executor.ts` | SshExecutor 接口与 MockSshExecutor |
| 新建 | `packages/worker/src/audit.ts` | 审计日志滚动文件 |
| 新建 | `packages/worker/src/housekeeping.ts` | 心跳与 GC 周期循环 |
| 新建 | `packages/worker/src/main.ts` | 进程入口，组装模块，主循环，信号处理 |

## T1: 退避模块

**文件：** `packages/worker/src/backoff.ts`
**依赖：** 无
**步骤：**
1. 定义 `BackoffState` 接口：`{ current_interval_ms: number; reset(): void; next(): number }`。
2. 实现 `createBackoff(initial: number, max: number): BackoffState`：内部维护 `current` 变量，初始为 `initial`；`next()` 返回 `current` 后将 `current` 翻倍（不超 `max`）；`reset()` 将 `current` 重置为 `initial`。
3. 导出 `createBackoff`。

**验证：** `npx tsc --noEmit` 编译通过；写临时脚本调用 `createBackoff(500, 3000)`，连续 `next()` 返回 500/1000/2000/3000/3000，`reset()` 后返回 500。

## T2: 配置模块

**文件：** `packages/worker/src/config.ts`
**依赖：** @smai-kit/msgferry-shared（POLLING、HEARTBEAT、RETENTION、OUTPUT 常量作为默认值）
**步骤：**
1. 定义 `SshConfig` 接口：`{ host, port, username, private_key_path: string | null, password: string | null }`。
2. 定义 `WorkerConfig` 接口：`{ hgfs_root, executor_type: 'mock'|'ssh2', ssh_config: SshConfig|null, audit_log_dir, policy_file, polling: {initial_interval_ms, max_interval_ms}, heartbeat_interval_sec, result_ttl_sec, max_inline_bytes }`。
3. 实现 `parseConfig(argv: string[], env: NodeJS.ProcessEnv): WorkerConfig`：从 argv 解析 `--hgfs-root`、`--executor`、`--ssh-host`、`--ssh-port`、`--ssh-user`、`--ssh-key`、`--ssh-password`、`--audit-dir`、`--policy-file`、`--polling-initial`、`--polling-max`、`--heartbeat-interval`、`--result-ttl`、`--max-inline` 等参数；未提供的用 ch01 常量默认值填充；`audit_log_dir` 默认 `<hgfs_root>/logs`；`policy_file` 默认 `<hgfs_root>/policy/policy.json`。
4. 实现 `validateConfig(config: WorkerConfig): void`：校验 `hgfs_root` 存在且可读写（fs.accessSync），不存在则抛错；`executor_type='ssh2'` 时校验 `ssh_config` 非空且 host/port/username 齐全。

**验证：** `npx tsc --noEmit` 编译通过；临时脚本传入 `['node','main.ts','--hgfs-root','/tmp/test-hgfs']`，断言返回的 config.hgfs_root 与各默认值正确。

## T3: 队列模块

**文件：** `packages/worker/src/queue.ts`
**依赖：** T2（WorkerConfig 类型仅用于参数引用，实际依赖 shared 的 QUEUE_DIRS、HEARTBEAT_FILE、CommandTask、TaskStatus）；Node.js fs/promises
**步骤：**
1. import `{ QUEUE_DIRS, HEARTBEAT_FILE } from '@smai-kit/msgferry-shared'`，import `{ CommandTask, TaskStatus } from '@smai-kit/msgferry-shared'`，import `fs/promises` 与 `fs`（constants）。
2. 实现 `initQueueDirs(root: string): Promise<void>`：对 QUEUE_DIRS 的七个目录名逐个 `fs.mkdir(root + '/' + name, { recursive: true })`。
3. 实现 `listPending(root: string): Promise<string[]>`：读 `pending/` 目录，过滤 `.json` 结尾的文件名（排除 `.tmp`），返回 task_id 列表（去 `.json`）。
4. 实现 `readTask(root: string, taskId: string): Promise<CommandTask>`：读 `pending/<taskId>.json`，JSON.parse 返回。
5. 实现 `acquireLock(root: string, taskId: string, pid: number): Promise<boolean>`：用 `fs.open(root + '/processing/' + taskId + '.lock', 'wx')` 尝试创建（O_CREAT|O_EXCL 等价），成功则写入 `{worker_pid: pid, lock_time: Date.now()}` 后返回 true；EEXIST 则返回 false。
6. 实现 `transitionToProcessing(root: string, task: CommandTask, pid: number): Promise<void>`：更新 task.status 为 processing、worker_pid 为 pid、start_time 为 now；原子写入 `processing/<task_id>.json`（.tmp → rename）；删除 `pending/<task_id>.json`。
7. 实现 `writeOverflowOutput(root, taskId, stdout, stderr): Promise<{stdoutPath, stderrPath}>`：分别写 `outputs/<taskId>.stdout` 与 `outputs/<taskId>.stderr`（.tmp → rename），返回相对路径。
8. 实现 `writeResult(root: string, task: CommandTask, maxInline: number): Promise<void>`：若 `task.stdout_size > maxInline` 则调 writeOverflowOutput 并设置 truncated/overflow_path；原子写入 `completed/<id>.json` 或 `failed/<id>.json`（按 task.status 判断）。
9. 实现 `checkCancelled(root, taskId): Promise<boolean>`：stat `cancelled/<taskId>` 是否存在。
10. 实现 `writeCancelledResult(root, task): Promise<void>`：原子写入 `cancelled/<taskId>.result`。
11. 实现 `writeHeartbeat(root, hb): Promise<void>`：.tmp → rename 写 `heartbeat.json`。
12. 实现 `readHeartbeat(root): Promise<Heartbeat | null>`：读 `heartbeat.json`，不存在返回 null。
13. 实现 `gcResults(root, ttlSec): Promise<number>`：扫描 `completed/` 与 `failed/` 下所有文件，stat mtime 超过 ttlSec 的删除，返回清理数。
14. 定义 `LockFile` 与 `Heartbeat` 接口并导出。

**验证：** `npx tsc --noEmit` 编译通过；临时脚本创建临时目录，调 initQueueDirs 确认七个目录创建；写一个 task JSON 到 pending/，调 listPending 确认返回 task_id；调 acquireLock 确认 lock 文件创建；第二次调 acquireLock 确认返回 false。

## T4: 安全策略模块

**文件：** `packages/worker/src/policy.ts`
**依赖：** 无（不引入第三方 shell-quote，自行实现简易解析）
**步骤：**
1. 定义 `PolicyRule` 接口：`{ whitelist_prefixes: string[], blacklist_patterns: string[], dangerous_param_patterns: string[] }`。
2. 定义 `PolicyResult = { allowed: true } | { allowed: false; reason: 'whitelist_miss'|'blacklist_hit'|'param_blocked' }`。
3. 实现 `loadPolicy(file: string): Promise<PolicyRule>`：读 JSON 文件并解析为 PolicyRule；文件不存在则返回默认规则（whitelist 含 docker/kubectl/systemctl/journalctl/cat/ls/tail，blacklist 含 `rm -rf /`、`dd if=`、`mkfs`、`:(){`，dangerous_param 含 `;`、`&&`、`||`、`$()`、`` ` ``）。
4. 实现简易命令解析 `parseCmd(cmd: string): { head: string; args: string[] }`：按空格分割首词为 head，其余为 args（简易实现，不处理引号嵌套复杂场景，够用即可）。
5. 实现 `checkCommand(rule: PolicyRule, cmd: string): PolicyResult`：
   - 解析 head，若不在 whitelist_prefixes 则返回 `{allowed:false, reason:'whitelist_miss'}`
   - 若 cmd 命中任一 blacklist_patterns（子串匹配）则返回 `{allowed:false, reason:'blacklist_hit'}`
   - 若 args 中命中任一 dangerous_param_patterns（正则匹配）则返回 `{allowed:false, reason:'param_blocked'}`
   - 否则返回 `{allowed:true}`
6. 实现 `createPolicyWatcher(file: string, intervalMs: number, onChange: (rule: PolicyRule) => void): { stop: () => void }`：setInterval 定时 stat mtime，变化则重新 loadPolicy 并回调 onChange；返回带 stop 方法的句柄。

**验证：** `npx tsc --noEmit` 编译通过；临时脚本调 checkCommand 传入 `docker ps` 返回 allowed:true；`rm -rf /` 返回 blacklist_hit；`ls; rm` 返回 param_blocked；`reboot` 返回 whitelist_miss。

## T5: SSH 执行器模块

**文件：** `packages/worker/src/executor.ts`
**依赖：** T2（WorkerConfig 类型）
**步骤：**
1. 定义 `SshResult` 接口：`{ stdout: string, stderr: string, exit_code: number|null, timed_out: boolean }`。
2. 定义 `SshExecutor` 接口：`{ execute(cmd: string, timeout_sec: number): Promise<SshResult> }`。
3. 实现 `class MockSshExecutor implements SshExecutor`：
   - `execute(cmd, timeout_sec)`：打印 `[mock] executed: <cmd>` 到 stdout；返回 `{ stdout: '[mock] executed: ' + cmd + '\n', stderr: '', exit_code: 0, timed_out: false }`；用 `await new Promise(r => setTimeout(r, 10))` 模拟极短执行延时。
4. 实现 `createExecutor(config: WorkerConfig): SshExecutor`：`executor_type === 'mock'` 返回 `new MockSshExecutor()`；`'ssh2'` 暂时抛错 `new Error('ssh2 executor not implemented yet')`。

**验证：** `npx tsc --noEmit` 编译通过；临时脚本调 MockSshExecutor.execute('docker ps', 30)，断言 stdout 含 `[mock]`、exit_code 为 0。

## T6: 审计日志模块

**文件：** `packages/worker/src/audit.ts`
**依赖：** Node.js fs/promises、path
**步骤：**
1. 定义 `AuditEntry` 接口：`{ task_id, cmd_summary, policy_result: PolicyResult, ssh_target: string|null, exit_code: number|null, duration_ms, cancelled: boolean, timestamp: number }`。import PolicyResult from './policy.js'。
2. 实现 `class AuditLogger`：
   - `constructor(logDir: string, options?: { maxFileSize?: number; retentionDays?: number })`：默认 maxFileSize=10MB，retentionDays=30。
   - `log(entry: AuditEntry): Promise<void>`：将 entry 序列化为 JSON 行（每行一条），追加到当日日志文件 `<logDir>/<YYYY-MM-DD>.log`；若文件大小超过 maxFileSize 则滚动到 `<logDir>/<YYYY-MM-DD>_<n>.log`。
   - `flush(): Promise<void>`：空实现（当前是追加写无缓冲，预留接口）。
   - `close(): Promise<void>`：空实现（无文件句柄常驻，预留接口）。
   - `searchByTaskId(taskId: string): Promise<AuditEntry[]>`：遍历 logDir 下所有 `.log` 文件，逐行 JSON.parse，过滤 task_id 匹配的条目返回。
   - `gc(): Promise<number>`：遍历 logDir 下所有 `.log` 文件，stat mtime 超过 retentionDays*86400*1000 的删除，返回清理数。

**验证：** `npx tsc --noEmit` 编译通过；临时脚本创建临时 logDir，new AuditLogger，log 两条 entry，确认文件存在且内容为两行 JSON；searchByTaskId 确认返回 2 条；构造一个 31 天前的日志文件，调 gc 确认被清理。

## T7: 心跳与 GC 模块

**文件：** `packages/worker/src/housekeeping.ts`
**依赖：** T3（queue 模块的 writeHeartbeat、gcResults）
**步骤：**
1. import `{ writeHeartbeat, gcResults } from './queue.js'`。
2. 定义 `HeartbeatStatsGetter = () => { processedCount: number; queueDepth: number }`。
3. 实现 `startHeartbeatLoop(root: string, intervalSec: number, getStats: HeartbeatStatsGetter): { stop: () => Promise<void> }`：
   - setInterval 周期 = intervalSec*1000；每次回调构造 Heartbeat `{ pid: process.pid, last_beat: Date.now(), processed_count: getStats().processedCount, queue_depth: getStats().queueDepth, shutdown_at: null }` 调 writeHeartbeat；写入失败仅 console.warn 不抛。
   - stop() 清除 interval，返回 resolved Promise。
4. 实现 `startGcLoop(root: string, ttlSec: number, intervalSec: number): { stop: () => Promise<void> }`：
   - setInterval 周期 = intervalSec*1000；每次回调调 gcResults(root, ttlSec)；失败仅 console.warn。
   - stop() 清除 interval。
5. 导出 `startHeartbeatLoop`、`startGcLoop`。

**验证：** `npx tsc --noEmit` 编译通过；临时脚本创建临时目录，startHeartbeatLoop 运行 6s，确认 heartbeat.json 被写过至少一次且 last_beat 在 5s 内；startGcLoop 运行一次确认无异常。

## T8: 主进程模块

**文件：** `packages/worker/src/main.ts`
**依赖：** T1-T7 全部模块；@smai-kit/msgferry-shared
**步骤：**
1. import 全部模块：`parseConfig, validateConfig` from './config.js'，`createBackoff` from './backoff.js'，`{ initQueueDirs, listPending, readTask, acquireLock, transitionToProcessing, writeResult, checkCancelled, writeCancelledResult } from './queue.js'`，`{ loadPolicy, checkCommand, createPolicyWatcher } from './policy.js'`，`{ createExecutor } from './executor.js'`，`{ AuditLogger } from './audit.js'`，`{ startHeartbeatLoop, startGcLoop } from './housekeeping.js'`。import shared 的 TaskStatus、ErrorCode、OUTPUT、POLLING、HEARTBEAT、RETENTION 常量。
2. 实现 `async function processTask(config, root, task, pid, policyRule, executor, auditLogger): Promise<void>`：
   - `transitionToProcessing(root, task, pid)`
   - `const policyResult = checkCommand(policyRule, task.cmd)`；若 `!policyResult.allowed`：设 task.status=Failed、policy_blocked=true、error_msg='blocked_by_policy'、end_time=now，调 writeResult，调 auditLogger.log，return。
   - `const sshResult = await executor.execute(task.cmd, task.timeout_sec)`
   - 回填 task.stdout、stderr、stdout_size=Buffer.byteLength、stderr_size、exit_code、error_msg（stderr 非空时）
   - 设 task.status = sshResult.exit_code === 0 ? Completed : Failed，end_time=now
   - `if (await checkCancelled(root, task.task_id))`：设 status=Cancelled，调 writeCancelledResult，auditLogger.log(cancelled=true)，return
   - 调 writeResult(root, task, config.max_inline_bytes)，auditLogger.log
3. 实现 `async function main(): Promise<void>`：
   - `const config = parseConfig(process.argv, process.env)`，`validateConfig(config)`
   - `await initQueueDirs(config.hgfs_root)`
   - `let policyRule = await loadPolicy(config.policy_file)`；`const watcher = createPolicyWatcher(config.policy_file, 10000, (r) => policyRule = r)`
   - `const executor = createExecutor(config)`
   - `const auditLogger = new AuditLogger(config.audit_log_dir)`
   - `let processedCount = 0`；`const getStats = () => ({ processedCount, queueDepth: 0 })`（queueDepth 异步获取留 0）
   - `const heartbeatLoop = startHeartbeatLoop(config.hgfs_root, config.heartbeat_interval_sec, getStats)`
   - `const gcLoop = startGcLoop(config.hgfs_root, config.result_ttl_sec, 60)`
   - `let shuttingDown = false`
   - `process.on('SIGINT', () => { shuttingDown = true })`，`process.on('SIGTERM', () => { shuttingDown = true })`
   - `const backoff = createBackoff(config.polling.initial_interval_ms, config.polling.max_interval_ms)`
   - 主循环 `while (!shuttingDown)`：
     - `const tasks = await listPending(config.hgfs_root)`
     - 若 tasks.length === 0：`await sleep(backoff.next())`，continue
     - `backoff.reset()`
     - 对每个 taskId：try { acquireLock；若失败跳过；readTask；await processTask(...)；processedCount++ } catch (e) { console.error(e)，auditLogger.log 失败记录 } 
   - 退出流程：`heartbeatLoop.stop()`，`gcLoop.stop()`，`watcher.stop()`，`await writeHeartbeat(config.hgfs_root, {pid, last_beat: Date.now(), processed_count, queue_depth:0, shutdown_at: Date.now()})`，`await auditLogger.flush()`，`await auditLogger.close()`，`process.exit(0)`
4. 实现 `function sleep(ms: number): Promise<void>`。
5. 导出 `main`。

**验证：** `npx tsc --noEmit` 编译通过；临时脚本创建临时 HGFS 目录，写一个 `docker ps` 任务 JSON 到 pending/，启动 main（用 setTimeout 2s 后 process.kill(pid, 'SIGTERM')），观察：pending/ 文件消失，completed/ 出现结果 JSON 含 mock stdout，heartbeat.json 存在，进程退出码 0。

## T9: 包入口改造

**文件：** `packages/worker/src/index.ts`
**依赖：** T8
**步骤：**
1. 读取现有 index.ts 识别编码（UTF-8 无 BOM、LF）。
2. 删除 `export const PACKAGE_NAME`、`console.log`、现有 re-export。
3. 改为 `export { main } from './main.js'` 与 `export * from './config.js'`、`export * from './queue.js'`、`export * from './policy.js'`、`export * from './executor.js'`、`export * from './audit.js'`、`export * from './housekeeping.js'`、`export * from './backoff.js'`。
4. 按原编码写回。

**验证：** `npx tsc --noEmit` 编译通过；临时脚本 `import * as m from '@smai-kit/msgferry-worker'`，断言 `typeof m.main === 'function'`。

## 执行顺序

```
T1（backoff）───┐
T2（config）────┼──→ T3（queue）──→ T7（housekeeping）─┐
                 │                                    ├─→ T8（main）─→ T9（index）
T4（policy）─────┼──→ T6（audit）─────────────────────┤
T5（executor）───┘                                    │
```

T1、T2、T4、T5 互不依赖可并行；T3 依赖 T2；T6 依赖 T4；T7 依赖 T3；T8 依赖全部；T9 收尾。
