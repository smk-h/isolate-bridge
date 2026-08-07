# MsgFerry shared 类型契约 Plan（ch01）

## 架构概览

ch01 聚焦 `packages/shared` 这一层。shared 包是纯契约层：定义类型、枚举、常量与无副作用纯函数，不引入任何运行时 IO 或第三方依赖。内外网两侧 package（mcp-server、worker）在编译期引用 shared，保证对任务 JSON 的读写契约完全一致。

shared 包内部按职责划分为五个模块：

1. **常量模块**：队列目录名、心跳文件名、轮询退避参数、大输出阈值、心跳过期阈值、结果保留时长、内网默认最大等待时长。纯 `as const` 字面量，运行时只读。
2. **状态模块**：任务状态枚举、会话状态枚举、终态集合、状态流转合法性表。状态流转以只读 Map 表达，便于纯函数查询。
3. **错误码模块**：系统级错误码枚举、错误码描述表、可重试/不可重试归类集合。
4. **任务类型模块**：单命令任务结构体 `CommandTask`、session 交互式任务结构体 `SessionTask`、批量任务类型 `BatchTask`、批量任务集合 `BatchTaskSet`、依赖约束类型 `DependencyChain`。两类任务为独立接口，各自携带 `kind` 判别字段供运行时判别，但不合并为联合类型。
5. **纯函数工具模块**：终态判定 `isTerminalStatus`、错误码归类 `isRetryableErrorCode`、任务类型判别 `isCommandTask` / `isSessionTask`、状态流转校验 `isValidStatusTransition`、批量依赖校验 `hasCircularDependency`。全部为纯函数，无 IO。

## 核心数据结构

### CommandTask（单命令任务结构体）

对应 F1，覆盖架构文档「2.3」全部字段：

```typescript
interface CommandTask {
  kind: 'command';              // 判别字段，固定值
  task_id: string;              // 任务唯一标识（UUID 字符串）
  batch_id: string | null;      // 批量归属，无批次为 null
  depends_on: string[];         // 依赖的 task_id 列表，空数组表示无依赖
  cmd: string;                  // 待执行 SSH 命令
  timeout_sec: number;          // 超时上限（秒）
  submit_time: number;          // 提交时间戳（ms epoch）
  start_time: number;           // 开始执行时间戳，未开始为 0
  end_time: number;             // 结束时间戳，未结束为 0
  stdout: string;               // 内联 stdout（截断至 max_inline_bytes）
  stderr: string;               // 内联 stderr（截断）
  stdout_size: number;          // stdout 实际字节数
  stderr_size: number;          // stderr 实际字节数
  truncated: boolean;           // 是否发生截断
  stdout_overflow_path: string | null;  // 大输出溢出指针，无溢出为 null
  stderr_overflow_path: string | null;
  max_inline_bytes: number;     // 内联上限阈值（默认 65536）
  exit_code: number | null;     // 退出码，未执行为 null
  error_msg: string | null;     // 错误信息
  status: TaskStatus;           // 任务状态
  worker_pid: number | null;    // 执行 Worker 的 PID
  policy_blocked: boolean;      // 是否被安全策略拦截
}
```

### SessionTask（交互式会话任务结构体）

对应 F5，远期 session 能力的类型骨架：

```typescript
interface SessionTask {
  kind: 'session';              // 判别字段，固定值
  session_id: string;           // 会话唯一标识
  cmd: string;                  // 初始命令
  timeout_sec: number;          // 会话超时上限
  submit_time: number;
  start_time: number;
  end_time: number;
  status: SessionStatus;        // 会话状态
  stdin_dir: string;            // stdin 摆渡目录约定
  stdout_dir: string;           // stdout 摆渡目录约定
  close_marker: string | null;  // 会话关闭标记，未关闭为 null
  error_msg: string | null;
  worker_pid: number | null;
}
```

### TaskStatus（任务状态枚举）

对应 F2：

```typescript
const TaskStatus = {
  Pending: 'pending',
  Processing: 'processing',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;
type TaskStatus = typeof TaskStatus[keyof typeof TaskStatus];
```

### SessionStatus（会话状态枚举）

对应 F5：

```typescript
const SessionStatus = {
  Creating: 'creating',
  Running: 'running',
  Closed: 'closed',
  Aborted: 'aborted',
} as const;
type SessionStatus = typeof SessionStatus[keyof typeof SessionStatus];
```

### ErrorCode（错误码枚举）

对应 F3：

```typescript
const ErrorCode = {
  BlockedByPolicy: 'blocked_by_policy',
  ExecutionTimeout: 'execution_timeout',
  SshConnectionFailed: 'ssh_connection_failed',
  DeviceOffline: 'device_offline',
  WorkerOffline: 'worker_offline',
  DuplicateSubmit: 'duplicate_submit',
  OrphanedResult: 'orphaned_result',
  OverflowReadFailed: 'overflow_read_failed',
  Unknown: 'unknown',
} as const;
type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];
```

### BatchTask / BatchTaskSet / DependencyChain（批量任务类型）

对应 F4：

```typescript
// 批量任务：CommandTask 的 batch_id 非空形态，约束其必须属于某批次
interface BatchTask extends CommandTask {
  batch_id: string;             // 覆盖父字段，去除 null
}

// 依赖链：task_id → 其依赖的 task_id 列表
type DependencyChain = Record<string, string[]>;

// 批量任务集合：同一批次内 task_id 唯一
interface BatchTaskSet {
  batch_id: string;
  tasks: BatchTask[];           // 同批次任务集合
  dependency: DependencyChain;   // 依赖关系图
}
```

### 队列目录与运行参数常量

对应 F6：

```typescript
const QUEUE_DIRS = {
  pending: 'pending',
  processing: 'processing',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  outputs: 'outputs',
  policy: 'policy',
} as const;

const HEARTBEAT_FILE = 'heartbeat.json';

const POLLING = {
  initial_interval_ms: 500,
  max_interval_ms: 3000,
  // 有任务后复位到 initial
} as const;

const OUTPUT = {
  max_inline_bytes: 65536,
} as const;

const HEARTBEAT = {
  expiry_sec: 15,        // 心跳过期阈值
  write_interval_sec: 5, // Worker 心跳写入间隔
} as const;

const RETENTION = {
  result_ttl_sec: 600,   // 结果文件保留 10 分钟
} as const;

const WAIT = {
  default_max_wait_ms: 30000, // 内网默认最大等待时长
} as const;
```

### 错误码描述表

```typescript
const ERROR_CODE_DESCRIPTIONS: Record<ErrorCode, string> = {
  [ErrorCode.BlockedByPolicy]: '命令被安全策略拦截',
  [ErrorCode.ExecutionTimeout]: '任务执行超时',
  [ErrorCode.SshConnectionFailed]: 'SSH 连接失败',
  [ErrorCode.DeviceOffline]: '设备离线',
  [ErrorCode.WorkerOffline]: 'Worker 心跳过期，离线',
  [ErrorCode.DuplicateSubmit]: '任务重复提交',
  [ErrorCode.OrphanedResult]: '孤儿结果：内网已取消但 Worker 回写',
  [ErrorCode.OverflowReadFailed]: '大输出指针文件读取失败',
  [ErrorCode.Unknown]: '未知错误',
};
```

### 纯函数接口

对应 F7：

```typescript
// 终态判定
function isTerminalStatus(status: TaskStatus): boolean;

// 错误码归类：可重试
function isRetryableErrorCode(code: ErrorCode): boolean;

// 任务类型判别
function isCommandTask(task: CommandTask | SessionTask): task is CommandTask;
function isSessionTask(task: CommandTask | SessionTask): task is SessionTask;

// 状态流转合法性
function isValidStatusTransition(from: TaskStatus, to: TaskStatus): boolean;

// 循环依赖检测（纯函数，输入依赖图，输出是否存在环）
function hasCircularDependency(chain: DependencyChain): boolean;
```

## 模块设计

### 常量模块（constants.ts）

**职责：** 集中定义队列目录名、心跳文件名、轮询退避参数、大输出阈值、心跳过期阈值、结果保留时长、内网默认最大等待时长。
**对外接口：** 导出 `QUEUE_DIRS`、`HEARTBEAT_FILE`、`POLLING`、`OUTPUT`、`HEARTBEAT`、`RETENTION`、`WAIT` 七个只读常量对象。
**依赖：** 无（纯字面量声明）。

### 状态模块（status.ts）

**职责：** 定义 `TaskStatus` 与 `SessionStatus` 枚举、终态集合 `TERMINAL_STATUSES`、合法状态流转表 `VALID_TRANSITIONS`。
**对外接口：** 导出枚举、终态集合、流转表。
**依赖：** 无。

### 错误码模块（errors.ts）

**职责：** 定义 `ErrorCode` 枚举、错误码描述表 `ERROR_CODE_DESCRIPTIONS`、可重试错误码集合 `RETRYABLE_ERROR_CODES`、不可重试错误码集合 `NON_RETRYABLE_ERROR_CODES`。
**对外接口：** 导出枚举、描述表、两个归类集合。
**依赖：** 无。

### 任务类型模块（tasks.ts）

**职责：** 定义 `CommandTask`、`SessionTask`、`BatchTask`、`BatchTaskSet`、`DependencyChain` 类型。
**对外接口：** 导出上述类型与接口。
**依赖：** status 模块（引用 `TaskStatus`、`SessionStatus`）、常量模块（`OUTPUT.max_inline_bytes` 作为 `CommandTask.max_inline_bytes` 的默认值文档说明，类型层不强制注入）。

### 纯函数工具模块（utils.ts）

**职责：** 实现 `isTerminalStatus`、`isRetryableErrorCode`、`isCommandTask`、`isSessionTask`、`isValidStatusTransition`、`hasCircularDependency` 六个纯函数。
**对外接口：** 导出上述函数。
**依赖：** status 模块、errors 模块、tasks 模块（类型引用）。

### 包入口（index.ts）

**职责：** 统一 re-export 上述五个模块的全部公开符号，清掉现有占位 `console.log`。
**对外接口：** `export *` from './constants' 等。
**依赖：** 五个模块。

## 模块交互

shared 包内部模块间的调用关系为单向无环依赖：

```
index.ts
  ├── re-export constants.ts   （无依赖）
  ├── re-export status.ts      （无依赖）
  ├── re-export errors.ts      （无依赖）
  ├── re-export tasks.ts       → 依赖 status
  └── re-export utils.ts       → 依赖 status、errors、tasks
```

任务类型（tasks.ts）引用状态枚举（status.ts）来标注 `CommandTask.status` 字段类型；纯函数（utils.ts）引用状态、错误码、任务类型来实现判定逻辑。常量模块独立，不依赖其他模块。

shared 包对外不主动调用任何模块——它只提供定义，由 mcp-server 与 worker 在各自代码中 import 后使用。shared 自身不包含 `main` 入口，不注册任何运行时回调。

## 文件组织

```
packages/shared/
├── package.json           — 已存在，无运行时 dependencies
├── tsconfig.json          — 已存在，继承 tsconfig.base.json
└── src/
    ├── index.ts           — 包入口，re-export 全部模块，清除现有 console.log 占位
    ├── constants.ts       — 队列目录、心跳文件名、轮询退避、大输出阈值、保留期等常量
    ├── status.ts          — TaskStatus / SessionStatus 枚举、终态集合、状态流转表
    ├── errors.ts           — ErrorCode 枚举、描述表、可重试/不可重试归类集合
    ├── tasks.ts            — CommandTask / SessionTask / BatchTask / BatchTaskSet / DependencyChain 类型
    └── utils.ts            — isTerminalStatus / isRetryableErrorCode / isCommandTask / isSessionTask / isValidStatusTransition / hasCircularDependency 纯函数
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 枚举实现方式 | `const 对象 + 派生 type` 而非 `enum` | ESM 下 `enum` 会产生运行时对象，与 N1「零副作用」边界暧昧；`as const` 字面量编译后内联为只读常量，运行时开销极低，且与 `literal type` 联动更好 |
| CommandTask 与 SessionTask 关系 | 两个独立接口，各自携带 `kind: 'command' \| 'session'` 判别字段，不合并为联合类型 | 用户明确选择「两个独立接口」；保留 `kind` 字段使 F7 的 `isCommandTask` / `isSessionTask` 判别函数有运行时依据，但类型层不强约束两者互斥 |
| 批量任务类型 | `BatchTask extends CommandTask`，将 `batch_id` 收窄为非空 string | 复用单命令任务全部字段，只在批量场景收窄 nullable 字段，避免重复定义 |
| 循环依赖检测 | 纯函数 `hasCircularDependency(chain)`，基于 DFS | 类型层无法静态检测任意环，改由运行时纯函数在 Worker 消费前校验；shared 只提供函数，不调用 |
| 状态流转表 | 只读 `Record<from, TaskStatus[]>` 映射表 | 查询 O(1)，纯数据驱动，比 switch-case 更易扩展；流转规则集中可见 |
| 错误码归类 | 两个显式 Set（`RETRYABLE_ERROR_CODES`、`NON_RETRYABLE_ERROR_CODES`） | 归类规则显式列举，新增错误码时必须显式归类，避免遗漏；比「按命名前缀推断」更安全 |
| 常量模块组织 | 按语义分组成 `QUEUE_DIRS`、`POLLING`、`OUTPUT`、`HEARTBEAT`、`RETENTION`、`WAIT` 六组 | 避免扁平大常量对象，消费侧按需 import 具名组，tree-shaking 友好 |
| `index.ts` 改造 | 清除 `console.log` 占位，改为 `export *` 聚合 | 现有 `console.log` 违反 N1「零运行时副作用」，必须移除 |

## 编码规范

**编程语言：** TypeScript（ESM 模块，NodeNext 模块解析，目标 ES2022）

**适用的语言规范技能：** ts-lang-spec

**文件编码规则（语言规范技能优先，以下为兜底）：**
- **新建文件**：UTF-8 无 BOM、LF 换行。语言规范技能另有要求时从其规定。
- **修改已有文件**（硬规则，不得覆盖）：必须保持原文件编码与换行符不变。`packages/shared/src/index.ts` 为已有文件，须先识别其现有编码（当前为 UTF-8 无 BOM、LF），修改后按原编码写回。

开发阶段编写代码时，必须遵循 ts-lang-spec 技能中定义的编码风格、命名约定、注释规范等要求。开发执行者应在开始编码前自动调用该技能，并严格遵守上述文件编码规则。
