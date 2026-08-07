# MsgFerry mcp-server Plan（ch03）

## 架构概览

`packages/mcp-server` 是内网 MCP Server，由 Claude Code 通过 MCP 配置拉起（stdio 协议）。按职责划分为六个模块，各模块单向依赖，无环：

1. **配置模块（config）**：解析启动参数与环境变量，产出 McpServerConfig 配置对象。校验 HGFS 根目录存在且可读写。
2. **队列模块（queue）**：封装内网侧的 HGFS 文件操作——原子提交任务（.tmp → rename）、检查任务存在性、读取结果文件、写入取消标记、读取心跳、读取大输出溢出文件。全部基于 Node.js fs API，不使用 fs.watch。与 worker 的 queue 模块互补：worker 写结果、mcp-server 读结果。
3. **退避模块（backoff）**：复用与 worker 相同的指数退避纯函数模式，用于提交后阻塞轮询等待结果时的间隔控制。
4. **工具逻辑模块（tools）**：实现四个 MCP 工具的核心业务逻辑（submit_ssh_task、query_task_status、cancel_task、check_bridge_health），不含 MCP 协议层，只接收参数、调用 queue 模块、返回结构化结果。
5. **MCP 服务模块（server）**：创建 McpServer 实例，注册四个工具（inputSchema 用 zod 定义），连接 StdioServerTransport，处理 stdio 通信与生命周期。
6. **主进程模块（main）**：进程入口，组装配置→队列初始化→创建 server→连接 transport，处理信号与优雅退出。

## 核心数据结构

### McpServerConfig（启动配置）

```typescript
interface McpServerConfig {
  hgfs_root: string;                  // HGFS 共享根目录绝对路径
  max_wait_ms: number;                // 内网提交后阻塞等待结果的最大时长，覆盖 WAIT.default_max_wait_ms
  polling: {
    initial_interval_ms: number;      // 覆盖 POLLING.initial_interval_ms
    max_interval_ms: number;          // 覆盖 POLLING.max_interval_ms
  };
}
```

### Heartbeat（心跳内容，复用 worker 定义）

mcp-server 侧只读取心跳，引用 worker 包的 `Heartbeat` 类型（或自行定义结构相同的接口，因为 mcp-server 不直接依赖 worker 包）：

```typescript
interface Heartbeat {
  pid: number;
  last_beat: number;                  // ms epoch
  processed_count: number;
  queue_depth: number;
  shutdown_at: number | null;         // Worker 优雅退出时写入
}
```

### 工具响应结构

四个工具的返回值统一为 MCP `CallToolResult` 格式（`{ content: TextContent[], structuredContent }`），`structuredContent` 为结构化数据对象：

- **submit_ssh_task 响应**：`{ task_id, status, exit_code, stdout, stderr, error_msg, truncated, stdout_size, stderr_size, duration_ms }`
- **query_task_status 响应**：`{ task_id, status, exit_code?, stdout?, stderr?, error_msg?, truncated? }` 或 `{ task_id, error: 'not_found' }`
- **cancel_task 响应**：`{ task_id, cancelled: true }` 或 `{ task_id, error: 'not_found' }`
- **check_bridge_health 响应**：`{ online: boolean, reason?: string, heartbeat?: Heartbeat, age_sec?: number }`

### 工具错误响应

工具调用异常或前置检查失败时，返回 `isError: true` 的 `CallToolResult`，`structuredContent` 含 `error_code` 字段（值为 shared 的 `ErrorCode` 枚举成员）与 `error_msg` 字段。

## 模块设计

### config 模块（config.ts）

**职责：** 解析命令行参数（process.argv）与环境变量，产出 McpServerConfig；校验 HGFS 根目录存在且可读写。
**对外接口：**
- `parseConfig(argv: string[], env: NodeJS.ProcessEnv): McpServerConfig`
- `validateConfig(config: McpServerConfig): void`（校验失败抛错）

**配置来源：**
- `--hgfs-root` / `MSGFERRY_HGFS_ROOT`（必填）
- `--max-wait` / `MSGFERRY_MAX_WAIT_MS`（可选，默认 WAIT.default_max_wait_ms）
- `--polling-initial` / `MSGFERRY_POLLING_INITIAL`（可选，默认 POLLING.initial_interval_ms）
- `--polling-max` / `MSGFERRY_POLLING_MAX`（可选，默认 POLLING.max_interval_ms）

**依赖：** @smai-kit/msgferry-shared（WAIT、POLLING 常量作为默认值来源）。

### queue 模块（queue.ts）

**职责：** 封装内网侧的 HGFS 文件操作。与 worker 的 queue 模块互补——mcp-server 负责写 pending、读 completed/failed/cancelled、写 cancelled 取消标记、读 heartbeat、读 outputs 大输出。
**对外接口：**
- `initQueueDirs(root: string): Promise<void>`——创建子目录（复用 worker 的同名函数逻辑，或直接引用 worker 包）
- `submitTask(root: string, task: CommandTask): Promise<void>`——原子写入 `pending/<task_id>.json`（.tmp → rename）
- `taskExists(root: string, taskId: string): Promise<'pending' | 'processing' | null>`——检查 pending/ 与 processing/ 是否存在同 task_id
- `readResult(root: string, taskId: string): Promise<CommandTask | null>`——依次检查 completed/failed/cancelled/<id>.result，找到则读取返回
- `readTaskFromDir(root: string, dir: 'pending' | 'processing', taskId: string): Promise<CommandTask | null>`——从指定目录读取任务文件
- `checkCancelMarker(root: string, taskId: string): Promise<boolean>`——检查 cancelled/<task_id> 取消标记是否存在
- `writeCancelMarker(root: string, taskId: string): Promise<void>`——写入 cancelled/<task_id> 取消标记（.tmp → rename）
- `readHeartbeat(root: string): Promise<Heartbeat | null>`——读取 heartbeat.json，不存在返回 null
- `readOverflowOutput(root: string, relPath: string): Promise<string | null>`——按相对路径读取 outputs/ 大输出文件，失败返回 null

**依赖：** @smai-kit/msgferry-shared（QUEUE_DIRS、HEARTBEAT_FILE、CommandTask、TaskStatus）；Node.js fs/promises。

### backoff 模块（backoff.ts）

**职责：** 指数退避纯函数，与 worker 的 backoff 模块逻辑完全相同。为避免 mcp-server 直接依赖 worker 包，独立实现一份（或从 worker 包 re-export）。
**对外接口：** `createBackoff(initial: number, max: number): BackoffState`
**依赖：** 无。

### tools 模块（tools.ts）

**职责：** 实现四个 MCP 工具的核心业务逻辑，不含 MCP 协议层。
**对外接口：**
- `submitSshTask(config: McpServerConfig, root: string, params: SubmitSshTaskParams): Promise<SubmitSshTaskResult>`
- `queryTaskStatus(root: string, taskId: string): Promise<QueryTaskStatusResult>`
- `cancelTask(root: string, taskId: string): Promise<CancelTaskResult>`
- `checkBridgeHealth(root: string): Promise<CheckBridgeHealthResult>`

**参数与返回类型：**
```typescript
interface SubmitSshTaskParams {
  cmd: string;
  timeout_sec?: number;        // 默认 30
  task_id?: string;            // 默认自动生成 UUID
}

interface SubmitSshTaskResult {
  task_id: string;
  status: TaskStatus | 'timeout';
  exit_code: number | null;
  stdout: string;
  stderr: string;
  error_msg: string | null;
  truncated: boolean;
  stdout_size: number;
  stderr_size: number;
  duration_ms: number;
  error_code?: ErrorCode;      // 前置检查失败时填充
}

interface QueryTaskStatusResult {
  task_id: string;
  status: TaskStatus;
  exit_code?: number | null;
  stdout?: string;
  stderr?: string;
  error_msg?: string | null;
  truncated?: boolean;
  error_code?: 'not_found';
}

interface CancelTaskResult {
  task_id: string;
  cancelled: boolean;
  error_code?: 'not_found';
}

interface CheckBridgeHealthResult {
  online: boolean;
  reason?: 'no_heartbeat' | 'heartbeat_expired' | 'worker_shutdown';
  heartbeat?: Heartbeat;
  age_sec?: number;
}
```

**依赖：** config（McpServerConfig 类型）、queue 模块、backoff 模块；@smai-kit/msgferry-shared（CommandTask、TaskStatus、ErrorCode、HEARTBEAT、POLLING、WAIT、OUTPUT 常量）；Node.js crypto（UUID 生成）。

### server 模块（server.ts）

**职责：** 创建 McpServer 实例，注册四个工具（inputSchema 用 zod 定义），连接 StdioServerTransport。
**对外接口：**
- `createMcpServer(config: McpServerConfig, root: string): McpServer`——创建并注册工具的 McpServer 实例
- `startServer(server: McpServer): Promise<void>`——创建 StdioServerTransport 并连接

**工具注册：**
- `submit_ssh_task`：inputSchema `{ cmd: z.string(), timeout_sec: z.number().optional(), task_id: z.string().optional() }`
- `query_task_status`：inputSchema `{ task_id: z.string() }`
- `cancel_task`：inputSchema `{ task_id: z.string() }`
- `check_bridge_health`：inputSchema `{}`（无参数）

每个工具的回调内部调用 tools 模块的对应函数，捕获异常转为 `isError: true` 的 CallToolResult，保证进程不崩溃。

**依赖：** @modelcontextprotocol/server（McpServer、StdioServerTransport）；zod；tools 模块；config 模块。

### main 模块（main.ts）

**职责：** 进程入口，组装配置→队列初始化→创建 server→连接 transport，处理信号与优雅退出。
**对外接口：** `main(): Promise<void>`
**依赖：** config、queue、server 模块；@smai-kit/msgferry-shared。

## 模块交互

启动流程与工具调用数据流：

```
main 启动
  │
  ├── parseConfig → validateConfig → McpServerConfig
  ├── initQueueDirs(hgfs_root)
  ├── createMcpServer(config, hgfs_root)
  │     ├── new McpServer({ name, version })
  │     └── registerTool × 4（回调闭包捕获 config 与 root）
  └── startServer(server)
        └── new StdioServerTransport() → server.connect(transport)
             │
             ▼
  stdio 监听 Claude Code 请求：
    Claude Code 调用 submit_ssh_task:
      1. tools.submitSshTask(config, root, { cmd, timeout_sec, task_id })
      2.   taskExists(root, task_id) → 存在则返回 duplicate_submit
      3.   readHeartbeat(root) → 过期则返回 worker_offline
      4.   submitTask(root, task) → 原子写 pending/<id>.json
      5.   backoff 轮询 readResult(root, task_id)
      6.   命中 → truncated 时 readOverflowOutput 拼回 → 返回结果
      7.   超时 → writeCancelMarker → 返回 execution_timeout

    Claude Code 调用 query_task_status:
      1. tools.queryTaskStatus(root, task_id)
      2.   readResult(root, task_id) → 命中返回
      3.   checkCancelMarker → 存在返回 cancelled
      4.   readTaskFromDir(processing) → 存在返回 processing
      5.   readTaskFromDir(pending) → 存在返回 pending
      6.   全无 → 返回 not_found

    Claude Code 调用 cancel_task:
      1. tools.cancelTask(root, task_id)
      2.   先检查任务是否存在（同 query 流程）
      3.   writeCancelMarker(root, task_id)
      4.   返回 cancelled: true

    Claude Code 调用 check_bridge_health:
      1. tools.checkBridgeHealth(root)
      2.   readHeartbeat(root)
      3.   判断 online/reason/age_sec → 返回

  信号处理（SIGINT/SIGTERM）：
    ├── server.close()
    └── process.exit(0)
```

模块依赖图（单向无环）：

```
main
 ├── config → shared
 ├── queue → shared
 ├── backoff
 ├── tools → config, queue, backoff, shared
 └── server → tools, config, MCP SDK, zod
```

## 文件组织

```
packages/mcp-server/
├── package.json           — 已存在，dependencies 含 @modelcontextprotocol/server 与 shared
├── tsconfig.json          — 已存在，继承 tsconfig.base.json
└── src/
    ├── index.ts           — 包入口，re-export main，清除现有 console.log 占位
    ├── main.ts            — 进程入口，组装模块，信号处理，优雅退出
    ├── config.ts          — 启动配置解析与校验
    ├── queue.ts           — 内网侧 HGFS 队列文件操作封装
    ├── backoff.ts         — 退避纯函数（与 worker 同构）
    ├── tools.ts           — 四个 MCP 工具的核心业务逻辑
    └── server.ts          — McpServer 创建、工具注册、StdioServerTransport 连接
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| MCP SDK 版本 | @modelcontextprotocol/server 2.0.0 | package.json 已声明 ^2.0.0，lock 文件锁定 2.0.0，含 McpServer 类与 StdioServerTransport |
| inputSchema 定义 | 使用 SDK 内置的 zod 4.4.3 | SDK 自带 zod 依赖，registerTool 原生支持 z.object 作为 inputSchema，无需额外引入 |
| UUID 生成 | Node.js 内置 crypto.randomUUID() | Node ≥ 20 原生支持，无需引入 uuid 第三方包 |
| backoff 模块 | 独立实现一份，与 worker 同构 | mcp-server 不直接依赖 worker 包（worker 含 ssh2 原生依赖，内网侧无需引入）；逻辑相同但物理隔离 |
| queue 模块 | 独立实现内网侧文件操作 | 与 worker 的 queue 互补（worker 写结果、mcp-server 读结果），不直接引用 worker 包避免依赖污染 |
| 日志输出 | console.error 到 stderr | MCP 协议通过 stdout 传输 JSON-RPC 消息，日志必须走 stderr 避免污染通道；SDK 文档亦建议 stderr logging |
| 错误处理 | 工具回调内 try-catch，转 isError CallToolResult | spec N6 要求单工具异常不崩溃进程，异常转为结构化错误响应返回 Claude Code |
| 取消标记格式 | cancelled/<task_id> 空文件 | 与 worker 的 checkCancelled 逻辑匹配（stat 检查存在性），空文件即可作为信号 |
| 大输出读取 | 按 overflow_path 相对路径拼接 root 后 readFile | worker 写入的是相对路径（outputs/<id>.stdout），mcp-server 拼接为绝对路径读取 |
| 心跳判断逻辑 | shutdown_at 非空→离线；last_beat 过期→离线 | heartbeat.json 的 shutdown_at 字段由 worker 优雅退出时写入，是比时间过期更明确的离线信号 |

## 编码规范

**编程语言：** TypeScript（ESM 模块，NodeNext 模块解析，目标 ES2022）

**适用的语言规范技能：** ts-lang-spec

**文件编码规则（语言规范技能优先，以下为兜底）：**
- **新建文件**：UTF-8 无 BOM、LF 换行。语言规范技能另有要求时从其规定。
- **修改已有文件**（硬规则，不得覆盖）：必须保持原文件编码与换行符不变。`packages/mcp-server/src/index.ts` 为已有文件，须先识别其现有编码（当前为 UTF-8 无 BOM、LF），修改后按原编码写回。

开发阶段编写代码时，必须遵循 ts-lang-spec 技能中定义的编码风格、命名约定、注释规范等要求。开发执行者应在开始编码前自动调用该技能，并严格遵守上述文件编码规则。
