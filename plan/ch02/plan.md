# MsgFerry worker Plan（ch02）

## 架构概览

`packages/worker` 是常驻后台进程，按职责划分为八个模块。各模块单向依赖，无环：

1. **配置模块（config）**：解析启动参数与环境变量，产出 WorkerConfig 配置对象。校验 HGFS 根目录与 SSH 配置。
2. **队列模块（queue）**：封装 HGFS 共享目录的文件操作——原子提交（.tmp → rename）、锁抢占（O_CREAT|O_EXCL）、目录轮询、结果回写、大输出分包读写。全部基于 Node.js fs API，不使用 fs.watch。
3. **退避模块（backoff）**：纯函数模块，计算下一次轮询间隔（指数退避，有任务复位到 500ms，无任务增长到 3s 上限）。
4. **安全策略模块（policy）**：加载策略文件，提供命令校验接口——白名单前缀匹配、黑名单拦截、参数危险模式检测。策略文件变化通过定时 stat mtime 检测后重载。
5. **SSH 执行器模块（executor）**：定义 SshExecutor 接口，提供 MockSshExecutor 实现（打印命令信息并返回固定文本）。真实 ssh2 实现预留接口位，后续章节填充。
6. **审计日志模块（audit）**：滚动文件日志，每条任务记录关键字段，保留 30 天自动清理，支持按 task_id 检索。
7. **心跳与 GC 模块（housekeeping）**：周期性写心跳（heartbeat.json），周期性扫描 completed/failed 清理过期结果文件（保留 600s）。
8. **主进程模块（main）**：进程入口，组装上述模块，运行主循环，处理信号，优雅退出。

## 核心数据结构

### WorkerConfig（启动配置）

```typescript
interface WorkerConfig {
  hgfs_root: string;            // HGFS 共享根目录绝对路径
  executor_type: 'mock' | 'ssh2';  // SSH 执行器选择，默认 mock
  ssh_config: SshConfig | null;     // 真实模式必填，mock 模式 null
  audit_log_dir: string;          // 审计日志目录，默认 <hgfs_root>/logs
  policy_file: string;           // 策略文件路径，默认 <hgfs_root>/policy/policy.json
  polling: {
    initial_interval_ms: number;   // 覆盖 ch01 默认 500
    max_interval_ms: number;      // 覆盖 ch01 默认 3000
  };
  heartbeat_interval_sec: number;  // 覆盖 ch01 默认 5
  result_ttl_sec: number;         // 覆盖 ch01 默认 600
  max_inline_bytes: number;       // 覆盖 ch01 默认 65536
}

interface SshConfig {
  host: string;
  port: number;
  username: string;
  private_key_path: string | null;
  password: string | null;
}
```

### SshExecutor 接口

```typescript
interface SshExecutor {
  /**
   * 执行命令并返回结果
   * @param cmd - 待执行命令
   * @param timeout_sec - 超时秒数
   * @returns 执行结果，含 stdout/stderr/exit_code/timed_out
   */
  execute(cmd: string, timeout_sec: number): Promise<SshResult>;
}

interface SshResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
}
```

### LockFile（锁文件内容）

```typescript
interface LockFile {
  worker_pid: number;
  lock_time: number;    // ms epoch
}
```

### Heartbeat（心跳内容）

```typescript
interface Heartbeat {
  pid: number;
  last_beat: number;       // ms epoch
  processed_count: number;
  queue_depth: number;
  shutdown_at: number | null;  // 优雅退出时写入
}
```

### PolicyRule（策略规则）

```typescript
interface PolicyRule {
  whitelist_prefixes: string[];    // 命令首词白名单
  blacklist_patterns: string[];    // 危险命令黑名单（正则或子串）
  dangerous_param_patterns: string[];  // 危险参数模式（正则）
}

type PolicyResult =
  | { allowed: true }
  | { allowed: false; reason: 'whitelist_miss' | 'blacklist_hit' | 'param_blocked' };
```

### AuditEntry（审计日志条目）

```typescript
interface AuditEntry {
  task_id: string;
  cmd_summary: string;      // 前 200 字符
  policy_result: PolicyResult;
  ssh_target: string | null;  // mock 模式 null
  exit_code: number | null;
  duration_ms: number;
  cancelled: boolean;
  timestamp: number;        // ms epoch
}
```

### BackoffState（退避状态）

```typescript
interface BackoffState {
  current_interval_ms: number;
  reset(): void;            // 有任务时复位到 initial
  next(): number;           // 返回当前间隔并推进（不超 max）
}
```

## 模块设计

### config 模块（config.ts）

**职责：** 解析命令行参数（process.argv）与环境变量，产出 WorkerConfig；校验 HGFS 根目录存在且可读写，校验 SSH 配置完整性。
**对外接口：** `parseConfig(argv: string[], env: NodeJS.ProcessEnv): WorkerConfig`，`validateConfig(config: WorkerConfig): void`（校验失败抛错）。
**依赖：** @smai-kit/msgferry-shared（QUEUE_DIRS、POLLING、HEARTBEAT、RETENTION、OUTPUT 常量作为默认值来源）。

### queue 模块（queue.ts）

**职责：** 封装 HGFS 队列的全部文件操作。
**对外接口：**
- `initQueueDirs(root: string): Promise<void>`——创建子目录
- `listPending(root: string): Promise<string[]>`——列出 pending/ 下 .json 文件名（不含 .tmp）
- `readTask(root: string, taskId: string): Promise<CommandTask>`——从 pending/ 读任务
- `acquireLock(root: string, taskId: string, pid: number): Promise<boolean>`——O_CREAT|O_EXCL 创建 lock
- `transitionToProcessing(root: string, task: CommandTask, pid: number): Promise<void>`——写 processing/<id>.json + 删 pending/<id>.json
- `writeResult(root: string, task: CommandTask, maxInline: number): Promise<void>`——大输出分流 + 原子回写 completed/failed
- `writeOverflowOutput(root: string, taskId: string, stdout: string, stderr: string): Promise<{ stdoutPath: string; stderrPath: string }>`
- `checkCancelled(root: string, taskId: string): Promise<boolean>`——检查 cancelled/<id> 存在性
- `writeCancelledResult(root: string, task: CommandTask): Promise<void>`——写 cancelled/<id>.result
- `writeHeartbeat(root: string, hb: Heartbeat): Promise<void>`——.tmp → rename 原子写心跳
- `readHeartbeat(root: string): Promise<Heartbeat | null>`
- `gcResults(root: string, ttlSec: number): Promise<number>`——清理过期结果，返回清理数

**依赖：** @smai-kit/msgferry-shared（QUEUE_DIRS、HEARTBEAT_FILE、CommandTask、TaskStatus）。

### backoff 模块（backoff.ts）

**职责：** 纯函数计算退避间隔。
**对外接口：** `createBackoff(initial: number, max: number): BackoffState`。
**依赖：** 无。

### policy 模块（policy.ts）

**职责：** 加载策略文件，提供命令校验；定时 stat mtime 检测变化后重载。
**对外接口：**
- `loadPolicy(file: string): Promise<PolicyRule>`
- `checkCommand(rule: PolicyRule, cmd: string): PolicyResult`
- `createPolicyWatcher(file: string, intervalMs: number, onChange: (rule: PolicyRule) => void): { stop: () => void }`

**依赖：** 无（shell-quote 解析自行实现简易版，不引入第三方依赖）。

### executor 模块（executor.ts）

**职责：** 定义 SshExecutor 接口，提供 MockSshExecutor 实现。
**对外接口：**
- `interface SshExecutor`
- `class MockSshExecutor implements SshExecutor`——execute 打印 `[mock] executed: <cmd>` 到 stdout，返回固定文本，exit_code=0
- `createExecutor(config: WorkerConfig): SshExecutor`——按 executor_type 选择

**依赖：** WorkerConfig 类型。

### audit 模块（audit.ts）

**职责：** 滚动文件审计日志，保留 30 天，支持按 task_id 检索。
**对外接口：**
- `class AuditLogger`
  - `constructor(logDir: string, options?: { maxFileSize?: number; retentionDays?: number })`
  - `log(entry: AuditEntry): Promise<void>`
  - `flush(): Promise<void>`
  - `close(): Promise<void>`
  - `searchByTaskId(taskId: string): Promise<AuditEntry[]>`
  - `gc(): Promise<number>`——清理过期日志文件

**依赖：** AuditEntry 类型。

### housekeeping 模块（housekeeping.ts）

**职责：** 周期性触发心跳写入与结果 GC。
**对外接口：**
- `startHeartbeatLoop(root: string, intervalSec: number, getStats: () => { processedCount: number; queueDepth: number }): { stop: () => Promise<void> }`
- `startGcLoop(root: string, ttlSec: number, intervalSec: number): { stop: () => Promise<void> }`

**依赖：** queue 模块（writeHeartbeat、gcResults）。

### main 模块（main.ts）

**职责：** 进程入口，组装全部模块，运行主循环，处理信号。
**对外接口：** `main(): Promise<void>`（入口函数）。
**依赖：** config、queue、backoff、policy、executor、audit、housekeeping 全部模块；@smai-kit/msgferry-shared。

## 模块交互

主循环数据流：

```
main 启动
  │
  ├── parseConfig → validateConfig → WorkerConfig
  ├── initQueueDirs
  ├── loadPolicy → PolicyRule + createPolicyWatcher
  ├── createExecutor(mock)
  ├── new AuditLogger
  ├── startHeartbeatLoop
  └── startGcLoop
       │
       ▼
  主循环（无限）：
    1. listPending → 任务列表
    2. 无任务 → backoff.next() → sleep → 检查信号 → 回到 1
    3. 有任务 → backoff.reset()
    4. 对每个 taskId：
       a. acquireLock → 失败则跳过
       b. readTask → CommandTask
       c. transitionToProcessing
       d. checkCommand → 策略拦截？→ writeResult(failed, policy_blocked=true) → audit.log → 下一个
       e. executor.execute(cmd, timeout)
       f. 回填 stdout/stderr/exit_code/error_msg/start_time/end_time
       g. checkCancelled → 已取消？→ writeCancelledResult → audit.log(cancelled=true)
                          → 未取消 → writeResult(completed/failed) → audit.log
       h. processed_count++
    5. 回到 1

  信号处理（SIGINT/SIGTERM）：
    ├── 设置退出标志
    └── 主循环检查到标志 → 跳出
        ├── 停止 housekeeping 循环
        ├── 等待当前任务完成或超时
        ├── writeHeartbeat(shutdown_at = now)
        ├── auditLogger.flush + close
        └── process.exit(0)
```

模块依赖图（单向无环）：

```
main
 ├── config → shared
 ├── queue → shared
 ├── backoff
 ├── policy
 ├── executor → config
 ├── audit
 └── housekeeping → queue
```

## 文件组织

```
packages/worker/
├── package.json           — 已存在，dependencies 含 shared 与 ssh2
├── tsconfig.json          — 已存在，继承 tsconfig.base.json
└── src/
    ├── index.ts           — 包入口，re-export main，清除现有 console.log 占位
    ├── main.ts            — 进程入口，组装模块，主循环，信号处理
    ├── config.ts          — 启动配置解析与校验
    ├── queue.ts           — HGFS 队列文件操作封装
    ├── backoff.ts         — 退避纯函数
    ├── policy.ts          — 命令安全策略校验与策略文件加载
    ├── executor.ts        — SshExecutor 接口与 MockSshExecutor
    ├── audit.ts           — 审计日志滚动文件
    └── housekeeping.ts    — 心跳与 GC 周期循环
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| SSH 执行器 | 接口 + Mock 实现，真实实现预留 | 用户明确要求只打印信息返回固定文本；接口抽象便于后续替换真实 ssh2 实现而不改主循环 |
| 命令解析 | 自行实现简易 shell-quote，不引入第三方 | spec N6 不引入运行时校验库的延伸；简易解析够用，避免增加依赖 |
| 策略热加载 | 定时 stat mtime 检测，不用 fs.watch | 架构文档 3.4 已论证 HGFS 上 fs.watch 不可靠；stat mtime 轮询与主循环退避对齐 |
| 锁抢占 | O_CREAT|O_EXCL 创建 lock 文件 + 写入 PID/time | 架构文档 2.2 明确要求双保险；O_EXCL 保证原子性，PID 便于死锁检测 |
| 退避实现 | 纯函数 + 状态对象，不用 async generator | 简单可控，主循环显式调用 next() 获取间隔，便于测试 |
| 审计日志滚动 | 自实现，不用 winston/pino 等 | 避免引入日志框架依赖；滚动逻辑简单（按日期 + 按大小），自实现可控 |
| 心跳与 GC 周期 | 独立 setInterval，不混入主循环 | 解耦：主循环专注任务消费，housekeeping 独立运行，便于单独停止与测试 |
| 优雅退出 | 信号设置标志位，主循环检查后跳出 | 避免信号处理函数内做复杂 IO（不安全）；标志位模式简单可靠 |
| 结果回写原子性 | 全程 .tmp → rename | 架构文档 2.2 要求；避免内网读到半写入的结果文件 |
| 大输出分流阈值 | 复用 ch01 OUTPUT.max_inline_bytes，可被 config 覆盖 | 避免魔法数字，且允许低配环境调小阈值 |

## 编码规范

**编程语言：** TypeScript（ESM 模块，NodeNext 模块解析，目标 ES2022）

**适用的语言规范技能：** ts-lang-spec

**文件编码规则（语言规范技能优先，以下为兜底）：**
- **新建文件**：UTF-8 无 BOM、LF 换行。语言规范技能另有要求时从其规定。
- **修改已有文件**（硬规则，不得覆盖）：必须保持原文件编码与换行符不变。`packages/worker/src/index.ts` 为已有文件，须先识别其现有编码（当前为 UTF-8 无 BOM、LF），修改后按原编码写回。

开发阶段编写代码时，必须遵循 ts-lang-spec 技能中定义的编码风格、命名约定、注释规范等要求。开发执行者应在开始编码前自动调用该技能，并严格遵守上述文件编码规则。
