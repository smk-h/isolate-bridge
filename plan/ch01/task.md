# MsgFerry shared 类型契约 Tasks（ch01）

## 文件清单

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `packages/shared/src/index.ts` | 包入口，清除 console.log 占位，改为 re-export 五个模块 |
| 新建 | `packages/shared/src/constants.ts` | 队列目录、心跳文件名、轮询退避、大输出阈值、保留期等常量 |
| 新建 | `packages/shared/src/status.ts` | TaskStatus / SessionStatus 枚举、终态集合、状态流转表 |
| 新建 | `packages/shared/src/errors.ts` | ErrorCode 枚举、描述表、可重试/不可重试归类集合 |
| 新建 | `packages/shared/src/tasks.ts` | CommandTask / SessionTask / BatchTask / BatchTaskSet / DependencyChain 类型 |
| 新建 | `packages/shared/src/utils.ts` | isTerminalStatus / isRetryableErrorCode / isCommandTask / isSessionTask / isValidStatusTransition / hasCircularDependency 纯函数 |
| 修改 | `packages/shared/package.json` | 确认无运行时 dependencies，仅保留 devDependencies |

## T1: 常量模块

**文件：** `packages/shared/src/constants.ts`
**依赖：** 无
**步骤：**
1. 定义 `QUEUE_DIRS` 常量对象，成员：`pending`、`processing`、`completed`、`failed`、`cancelled`、`outputs`、`policy`，全部 `as const`。
2. 定义 `HEARTBEAT_FILE = 'heartbeat.json' as const`。
3. 定义 `POLLING` 常量对象，成员：`initial_interval_ms: 500`、`max_interval_ms: 3000`，`as const`。
4. 定义 `OUTPUT` 常量对象，成员：`max_inline_bytes: 65536`，`as const`。
5. 定义 `HEARTBEAT` 常量对象，成员：`expiry_sec: 15`、`write_interval_sec: 5`，`as const`。
6. 定义 `RETENTION` 常量对象，成员：`result_ttl_sec: 600`，`as const`。
7. 定义 `WAIT` 常量对象，成员：`default_max_wait_ms: 30000`，`as const`。

**验证：** `cd packages/shared && npx tsc --noEmit` 编译通过；该文件无 import，无副作用。

## T2: 状态模块

**文件：** `packages/shared/src/status.ts`
**依赖：** 无
**步骤：**
1. 定义 `TaskStatus` 常量对象（`Pending`/`Processing`/`Completed`/`Failed`/`Cancelled`，值为对应小写字符串），`as const`，并派生 `type TaskStatus`。
2. 定义 `SessionStatus` 常量对象（`Creating`/`Running`/`Closed`/`Aborted`），`as const`，并派生 `type SessionStatus`。
3. 定义 `TERMINAL_STATUSES` 为 `TaskStatus` 终态值的只读数组：`['completed', 'failed', 'cancelled'] as const`。
4. 定义 `VALID_TRANSITIONS` 为只读 `Record<TaskStatus, readonly TaskStatus[]>`：
   - `pending` → `['processing']`
   - `processing` → `['completed', 'failed', 'cancelled']`
   - `completed` / `failed` / `cancelled` → `[]`（终态无后继）

**验证：** `npx tsc --noEmit` 编译通过；无 import，无副作用。

## T3: 错误码模块

**文件：** `packages/shared/src/errors.ts`
**依赖：** 无
**步骤：**
1. 定义 `ErrorCode` 常量对象，成员：`BlockedByPolicy: 'blocked_by_policy'`、`ExecutionTimeout: 'execution_timeout'`、`SshConnectionFailed: 'ssh_connection_failed'`、`DeviceOffline: 'device_offline'`、`WorkerOffline: 'worker_offline'`、`DuplicateSubmit: 'duplicate_submit'`、`OrphanedResult: 'orphaned_result'`、`OverflowReadFailed: 'overflow_read_failed'`、`Unknown: 'unknown'`，`as const`，派生 `type ErrorCode`。
2. 定义 `ERROR_CODE_DESCRIPTIONS` 为 `Record<ErrorCode, string>`，为每个错误码配中文简短描述。
3. 定义 `RETRYABLE_ERROR_CODES` 为只读 Set，成员：`DeviceOffline`、`WorkerOffline`、`ExecutionTimeout`、`SshConnectionFailed`。
4. 定义 `NON_RETRYABLE_ERROR_CODES` 为只读 Set，成员：`BlockedByPolicy`、`DuplicateSubmit`、`OrphanedResult`、`OverflowReadFailed`、`Unknown`。

**验证：** `npx tsc --noEmit` 编译通过；两个 Set 的并集等于全部错误码（可肉眼核对）。

## T4: 任务类型模块

**文件：** `packages/shared/src/tasks.ts`
**依赖：** T2（status 模块的 `TaskStatus`、`SessionStatus`）
**步骤：**
1. import `{ TaskStatus, SessionStatus } from './status.js'`（NodeNext ESM 扩展名）。
2. 定义 `CommandTask` 接口，字段按 plan.md「核心数据结构」定义：`kind: 'command'`、`task_id`、`batch_id: string | null`、`depends_on: string[]`、`cmd`、`timeout_sec`、`submit_time`、`start_time`、`end_time`、`stdout`、`stderr`、`stdout_size`、`stderr_size`、`truncated`、`stdout_overflow_path: string | null`、`stderr_overflow_path: string | null`、`max_inline_bytes`、`exit_code: number | null`、`error_msg: string | null`、`status: TaskStatus`、`worker_pid: number | null`、`policy_blocked`。
3. 定义 `SessionTask` 接口，字段按 plan.md：`kind: 'session'`、`session_id`、`cmd`、`timeout_sec`、`submit_time`、`start_time`、`end_time`、`status: SessionStatus`、`stdin_dir`、`stdout_dir`、`close_marker: string | null`、`error_msg: string | null`、`worker_pid: number | null`。
4. 定义 `BatchTask` 接口 `extends CommandTask`，将 `batch_id` 收窄为 `string`（非空）。
5. 定义 `DependencyChain` 类型 = `Record<string, string[]>`。
6. 定义 `BatchTaskSet` 接口：`batch_id: string`、`tasks: BatchTask[]`、`dependency: DependencyChain`。

**验证：** `npx tsc --noEmit` 编译通过；CommandTask 字段与架构文档「2.3」逐一对照无遗漏。

## T5: 纯函数工具模块

**文件：** `packages/shared/src/utils.ts`
**依赖：** T2（status）、T3（errors）、T4（tasks）
**步骤：**
1. import `{ TaskStatus, TERMINAL_STATUSES, VALID_TRANSITIONS } from './status.js'`。
2. import `{ ErrorCode, RETRYABLE_ERROR_CODES } from './errors.js'`。
3. import `{ CommandTask, SessionTask, DependencyChain } from './tasks.js'`。
4. 实现 `isTerminalStatus(status: TaskStatus): boolean`：检查 `TERMINAL_STATUSES` 是否包含 `status`。
5. 实现 `isRetryableErrorCode(code: ErrorCode): boolean`：检查 `RETRYABLE_ERROR_CODES` 是否包含 `code`。
6. 实现 `isCommandTask(task: CommandTask | SessionTask): task is CommandTask`：返回 `task.kind === 'command'`。
7. 实现 `isSessionTask(task: CommandTask | SessionTask): task is SessionTask`：返回 `task.kind === 'session'`。
8. 实现 `isValidStatusTransition(from: TaskStatus, to: TaskStatus): boolean`：查询 `VALID_TRANSITIONS[from]` 是否包含 `to`。
9. 实现 `hasCircularDependency(chain: DependencyChain): boolean`：基于 DFS，对 `chain` 的每个 key 做深度遍历，若访问到已在当前递归栈中的节点则返回 true（存在环）；遍历完所有起点无环则返回 false。

**验证：** `npx tsc --noEmit` 编译通过；所有函数无 IO、无 console 调用。

## T6: 包入口改造

**文件：** `packages/shared/src/index.ts`
**依赖：** T1-T5
**步骤：**
1. 先用 `read_file` 读取现有 `index.ts` 内容，识别其当前编码（UTF-8 无 BOM、LF）。
2. 删除 `export const PACKAGE_NAME`、`console.log("Hello, I'm shared")`、现有 `QUEUE_DIRS` 占位定义。
3. 改为 `export * from './constants.js'`、`export * from './status.js'`、`export * from './errors.js'`、`export * from './tasks.js'`、`export * from './utils.js'` 五行 re-export（NodeNext ESM 扩展名）。
4. 按原编码（UTF-8 无 BOM、LF）写回，不得转换编码。

**验证：** `npx tsc --noEmit` 编译通过；写一个临时脚本 `node -e "import('@smai-kit/msgferry-shared').then(m => console.log(Object.keys(m).length > 0)"` 在 workspace 根运行，确认 re-export 生效；确认该脚本只用于验证，不留入仓库。

## T7: package.json 依赖核对

**文件：** `packages/shared/package.json`
**依赖：** T6
**步骤：**
1. 读取 `packages/shared/package.json`，确认 `dependencies` 字段不存在或为空对象 `{}`。
2. 确认 `devDependencies` 仅含 `typescript` 与 `@types/node`。
3. 若 `dependencies` 误含运行时依赖则删除该字段。

**验证：** `cat packages/shared/package.json` 输出无 `dependencies` 字段或为 `{}`。

## 执行顺序

```
T1（constants）──┐
T2（status）─────┼──→ T4（tasks）──→ T5（utils）──→ T6（index）──→ T7（package.json）
T3（errors）─────┘
```

T1、T2、T3 互不依赖可并行；T4 依赖 T2；T5 依赖 T2、T3、T4；T6 依赖全部；T7 收尾核对。