# MsgFerry shared 类型契约 Checklist（ch01）

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。所有命令在 `packages/shared` 目录下执行，除非另注。

## 实现完整性

- [ ] **CommandTask 字段齐全**（验证：`cat packages/shared/src/tasks.ts`，对照架构文档「2.3」逐字段核对，确认 21 个字段全部存在：kind、task_id、batch_id、depends_on、cmd、timeout_sec、submit_time、start_time、end_time、stdout、stderr、stdout_size、stderr_size、truncated、stdout_overflow_path、stderr_overflow_path、max_inline_bytes、exit_code、error_msg、status、worker_pid、policy_blocked）
- [ ] **SessionTask 字段齐全**（验证：同上，确认 12 个字段全部存在：kind、session_id、cmd、timeout_sec、submit_time、start_time、end_time、status、stdin_dir、stdout_dir、close_marker、error_msg、worker_pid）
- [ ] **TaskStatus 枚举五个成员**（验证：`npx tsc --noEmit` 通过后，写临时脚本 `node --input-type=module -e "import('@smai-kit/msgferry-shared').then(m => console.log(Object.keys(m.TaskStatus)))"` 输出包含 Pending/Processing/Completed/Failed/Cancelled）
- [ ] **SessionStatus 枚举四个成员**（验证：同上脚本输出 Object.keys(m.SessionStatus) 包含 Creating/Running/Closed/Aborted）
- [ ] **ErrorCode 枚举九项**（验证：同上脚本 Object.keys(m.ErrorCode) 包含 BlockedByPolicy/ExecutionTimeout/SshConnectionFailed/DeviceOffline/WorkerOffline/DuplicateSubmit/OrphanedResult/OverflowReadFailed/Unknown）

## 行为正确性

- [ ] **isTerminalStatus 对终态返回 true**（验证：临时脚本调用 `m.isTerminalStatus('completed')`、`'failed'`、`'cancelled'` 全部返回 true）
- [ ] **isTerminalStatus 对非终态返回 false**（验证：`m.isTerminalStatus('pending')`、`'processing'` 全部返回 false）
- [ ] **isRetryableErrorCode 正确归类**（验证：`m.isRetryableErrorCode('device_offline')`、`'worker_offline'`、`'execution_timeout'`、`'ssh_connection_failed'` 返回 true；`m.isRetryableErrorCode('blocked_by_policy')`、`'duplicate_submit'`、`'orphaned_result'`、`'overflow_read_failed'`、`'unknown'` 返回 false）
- [ ] **isCommandTask 判别正确**（验证：构造一个 `kind: 'command'` 的对象传入 `m.isCommandTask` 返回 true；`kind: 'session'` 的对象返回 false）
- [ ] **isSessionTask 判别正确**（验证：构造一个 `kind: 'session'` 的对象传入 `m.isSessionTask` 返回 true；`kind: 'command'` 的对象返回 false）
- [ ] **isValidStatusTransition 合法流转**（验证：`m.isValidStatusTransition('pending','processing')`、`('processing','completed')`、`('processing','failed')`、`('processing','cancelled')` 返回 true）
- [ ] **isValidStatusTransition 非法流转**（验证：`m.isValidStatusTransition('processing','pending')`、`('completed','processing')`、`('failed','pending')`、`('cancelled','pending')` 返回 false）
- [ ] **hasCircularDependency 检测到环**（验证：`m.hasCircularDependency({a:['b'],b:['a']})` 返回 true；`{a:['b'],b:['c'],c:[]}` 返回 false；`{a:['a']}` 返回 true 自依赖）
- [ ] **hasCircularDependency 无环返回 false**（验证：`m.hasCircularDependency({a:[],b:['a'],c:['b']})` 返回 false，链式无环）

## 集成

- [ ] **index.ts re-export 全部模块**（验证：临时脚本 `node --input-type=module -e "import('@smai-kit/msgferry-shared').then(m => console.log(Object.keys(m).sort().join(','))"`，输出包含 QUEUE_DIRS、HEARTBEAT_FILE、POLLING、OUTPUT、HEARTBEAT、RETENTION、WAIT、TaskStatus、SessionStatus、TERMINAL_STATUSES、VALID_TRANSITIONS、ErrorCode、ERROR_CODE_DESCRIPTIONS、RETRYABLE_ERROR_CODES、NON_RETRYABLE_ERROR_CODES 等符号）
- [ ] **常量齐全**（验证：上述输出包含 QUEUE_DIRS.pending/processing/completed/failed/cancelled/outputs/policy 七个目录名，及 HEARTBEAT_FILE='heartbeat.json'）
- [ ] **运行参数常量齐全**（验证：脚本输出 POLLING.initial_interval_ms=500、POLLING.max_interval_ms=3000、OUTPUT.max_inline_bytes=65536、HEARTBEAT.expiry_sec=15、RETENTION.result_ttl_sec=600、WAIT.default_max_wait_ms=30000）

## 编译与测试

- [ ] **项目编译无错误**（验证：`cd packages/shared && npx tsc --noEmit` 退出码 0）
- [ ] **strict 模式无 any 逃逸**（验证：编译通过即代表 strict/noImplicitAny 无违反，因为 tsconfig.base.json 已启用）
- [ ] **无未使用变量告警**（验证：`npx tsc --noEmit` 不产生 noUnusedLocals/noUnusedParameters 错误）
- [ ] **代码符合 ts-lang-spec 规范**（验证：开发时已加载 ts-lang-spec 技能；人工检查命名风格（PascalCase 类型、camelCase 函数、UPPER_SNAKE_CASE 常量）、注释规范是否符合）
- [ ] **文件编码未被破坏**（验证：`file packages/shared/src/index.ts` 仍为 UTF-8 文本，`od -c packages/shared/src/index.ts | head -1` 未见 BOM 字节 `357 273 277`；新建文件 `file packages/shared/src/{constants,status,errors,tasks,utils}.ts` 均为 UTF-8）

## 零副作用验证

- [ ] **shared 包 import 无控制台输出**（验证：临时脚本 `node --input-type=module -e "import('@smai-kit/msgferry-shared').then(() => {})"` 运行后 stdout 为空，无 "Hello, I'm shared" 等输出）
- [ ] **shared 包 import 无文件 IO**（验证：用 `strace -e trace=openat,write node --input-type=module -e "import('@smai-kit/msgferry-shared').then(()=>{})" 2>&1 | grep -v 'node_modules' | grep -v '/proc/'` 输出为空，无业务文件读写）
- [ ] **shared 包 import 无网络请求**（验证：上述 strace 输出无 connect/socket 系统调用）

## 依赖与编码规范

- [ ] **package.json 无运行时 dependencies**（验证：`cat packages/shared/package.json` 不含 `dependencies` 字段或值为 `{}`；devDependencies 仅含 typescript 与 @types/node）
- [ ] **ESM 模块解析正确**（验证：所有 import 语句使用 `.js` 扩展名（NodeNext 约定）；`packages/shared/package.json` 含 `"type": "module"`）
- [ ] **Node 版本对齐**（验证：`node -v` 输出 ≥ v20.0.0，与根 package.json engines.node 一致）

## 端到端场景

- [ ] **场景 1：模拟 Worker 侧构造任务结构体**（验证：临时脚本 import shared，构造一个 `CommandTask` 对象（kind='command', status='pending', cmd='docker ps' 等字段齐全），TypeScript 编译期类型检查通过，无类型错误）
- [ ] **场景 2：状态流转全程合法**（验证：临时脚本依次调用 `isValidStatusTransition('pending','processing')` → `('processing','completed')`，两次均返回 true，模拟任务从提交到完成的合法流转路径）
- [ ] **场景 3：错误码归类覆盖**（验证：临时脚本遍历 `Object.keys(m.ErrorCode)`，对每个错误码调用 `m.isRetryableErrorCode`，断言每个码都有明确的 true/false 归类（无 undefined 或漏归类））
- [ ] **场景 4：循环依赖检测**（验证：临时脚本构造 `{a:['b'], b:['c'], c:['a']}` 传入 `hasCircularDependency`，返回 true，模拟批量任务下发前的依赖校验拦截）
