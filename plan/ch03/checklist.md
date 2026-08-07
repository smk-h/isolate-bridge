# MsgFerry mcp-server Checklist（ch03）

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。所有命令在 `packages/mcp-server` 目录下执行，除非另注。临时验证脚本使用完毕后删除，不留入仓库。

## 实现完整性

- [ ] **config 模块解析参数与默认值**（验证：临时脚本传入 `['node','main','--hgfs-root','/tmp/hgfs']`，断言 config.hgfs_root='/tmp/hgfs'、max_wait_ms=30000、polling.initial_interval_ms=500、polling.max_interval_ms=3000）
- [ ] **config 校验拒绝不存在的 hgfs_root**（验证：传入 `--hgfs-root /nonexistent` 调 validateConfig，断言抛错）
- [ ] **queue 模块 initQueueDirs 创建七个目录**（验证：临时脚本传入空目录调 initQueueDirs，断言 pending/processing/completed/failed/cancelled/outputs/policy 全部创建）
- [ ] **queue 模块 submitTask 原子写入 pending**（验证：构造 CommandTask 调 submitTask，断言 `pending/<task_id>.json` 存在且 JSON 合法，无 .tmp 残留）
- [ ] **queue 模块 taskExists 检测重复**（验证：submitTask 后调 taskExists 返回 'pending'；在 processing/ 手动放文件后返回 'processing'；不存在的 task_id 返回 null）
- [ ] **queue 模块 readResult 读取 completed/failed/cancelled**（验证：在 completed/ 放结果文件，调 readResult 返回 CommandTask；在 failed/ 放文件同样返回；无文件返回 null）
- [ ] **queue 模块 readTaskFromDir 读取 pending/processing**（验证：在 pending/ 放任务文件，调 readTaskFromDir('pending', id) 返回 CommandTask；不存在返回 null）
- [ ] **queue 模块 checkCancelMarker 检测取消标记**（验证：在 cancelled/ 写标记文件，调 checkCancelMarker 返回 true；无标记返回 false）
- [ ] **queue 模块 writeCancelMarker 写入取消标记**（验证：调 writeCancelMarker 后断言 `cancelled/<task_id>` 文件存在）
- [ ] **queue 模块 readHeartbeat 读取心跳**（验证：写 heartbeat.json 后调 readHeartbeat 返回解析对象；无文件返回 null）
- [ ] **queue 模块 readOverflowOutput 读取大输出**（验证：在 outputs/ 放 `<id>.stdout` 文件，调 readOverflowOutput(root, 'outputs/<id>.stdout') 返回文件内容；不存在返回 null）
- [ ] **backoff 模块退避逻辑正确**（验证：临时脚本调 `createBackoff(500, 3000)`，连续 `next()` 返回 500/1000/2000/3000/3000，`reset()` 后返回 500）
- [ ] **tools 模块 checkBridgeHealth 无心跳返回 no_heartbeat**（验证：空 HGFS 目录调 checkBridgeHealth，断言返回 `{ online: false, reason: 'no_heartbeat' }`）
- [ ] **tools 模块 checkBridgeHealth 正常心跳返回 online**（验证：写 heartbeat.json（shutdown_at=null, last_beat=Date.now()），调 checkBridgeHealth 返回 `{ online: true }` 且 age_sec < 1）
- [ ] **tools 模块 checkBridgeHealth 心跳过期返回 heartbeat_expired**（验证：写 heartbeat.json（last_beat=Date.now()-20000），调 checkBridgeHealth 返回 `{ online: false, reason: 'heartbeat_expired' }`）
- [ ] **tools 模块 checkBridgeHealth shutdown_at 非空返回 worker_shutdown**（验证：写 heartbeat.json（shutdown_at=Date.now()），调 checkBridgeHealth 返回 `{ online: false, reason: 'worker_shutdown' }`）
- [ ] **tools 模块 queryTaskStatus 不存在返回 not_found**（验证：对不存在的 task_id 调 queryTaskStatus，断言返回 `{ task_id, error_code: 'not_found' }`）
- [ ] **tools 模块 cancelTask 不存在返回 not_found**（验证：对不存在的 task_id 调 cancelTask，断言返回 `{ task_id, cancelled: false, error_code: 'not_found' }`）
- [ ] **tools 模块 cancelTask 存在任务写入取消标记**（验证：先在 pending/ 放任务文件，调 cancelTask，断言返回 `{ cancelled: true }` 且 cancelled/ 目录出现标记文件）

## 集成

- [ ] **main 进程入口可启动**（验证：`npx tsc --noEmit` 通过后，`node dist/main.js --hgfs-root /tmp/test-hgfs` 启动后不立即退出，进程存活等待 stdio 输入）
- [ ] **main 启动时初始化队列目录**（验证：传入空 /tmp/test-hgfs 启动，观察七个子目录被创建）
- [ ] **MCP Server 工具可被发现**（验证：用 MCP 客户端脚本或 Claude Code 配置连接，发送 tools/list 请求，断言返回含 submit_ssh_task、query_task_status、cancel_task、check_bridge_health 四个工具）
- [ ] **MCP Server 工具可被调用并返回结构化响应**（验证：通过 stdio 发送 tools/call 请求调用 check_bridge_health，断言返回 CallToolResult 格式含 content 与 structuredContent）
- [ ] **index.ts re-export 全部模块**（验证：临时脚本 `import * as m from '@smai-kit/msgferry-mcp-server'`，断言 typeof m.main==='function' 且 m.parseConfig/m.initQueueDirs/m.createMcpServer/m.submitSshTask 等符号可访问）

## 行为正确性

- [ ] **submit_ssh_task 提交后 pending/ 出现任务文件**（验证：调 submit_ssh_task 提交 `docker ps`，提交后立即检查 pending/ 目录出现 `<task_id>.json`，文件为合法 CommandTask JSON，status=pending）
- [ ] **submit_ssh_task Worker 离线返回 worker_offline**（验证：删除 heartbeat.json 或写过期心跳后调 submit_ssh_task，断言返回 error_code='worker_offline' 且 pending/ 无新文件）
- [ ] **submit_ssh_task 重复提交返回 duplicate_submit**（验证：先在 pending/ 放一个 task_id='t1' 的任务文件，调 submit_ssh_task 传入 task_id='t1'，断言返回 error_code='duplicate_submit'）
- [ ] **submit_ssh_task Worker shutdown_at 非空返回 worker_offline**（验证：写 heartbeat.json（shutdown_at=Date.now()），调 submit_ssh_task，断言返回 error_code='worker_offline'）
- [ ] **submit_ssh_task 阻塞等待并返回 Worker 回写的结果**（验证：启动 worker mock 模式，调 submit_ssh_task 提交 `docker ps`，断言返回 status=completed、stdout 含 `[mock]`、exit_code=0）
- [ ] **submit_ssh_task 大输出 truncated 时拼回完整内容**（验证：手动在 completed/ 放一个 truncated=true 的结果文件并在 outputs/ 放对应大输出文件，调 submit_ssh_task 的 readOverflow 逻辑——或通过 query_task_status 验证，断言返回的 stdout 为完整内容）
- [ ] **submit_ssh_task 超时写入取消标记并返回 execution_timeout**（验证：不启动 worker，调 submit_ssh_task 设置 max_wait_ms=2000，等待超时后断言返回 error_code='execution_timeout' 且 cancelled/ 出现取消标记文件）
- [ ] **query_task_status 各目录状态正确返回**（验证：分别在 pending/processing/completed/failed/cancelled 放任务文件，调 query_task_status 核对返回 status 分别为 pending/processing/completed/failed/cancelled）
- [ ] **cancel_task 写入取消标记文件**（验证：在 pending/ 放任务文件后调 cancel_task，断言 cancelled/ 出现 `<task_id>` 标记文件）
- [ ] **check_bridge_health 正常心跳返回 online=true**（验证：写当前时间的心跳文件，调 check_bridge_health，断言 online=true 且 age_sec < 1）
- [ ] **单工具调用异常不导致进程崩溃**（验证：通过 stdio 发送 tools/call 请求传入非法参数——如 cmd 为空字符串或缺少必填字段，观察返回 isError=true 的错误响应而非进程退出，stdio 连接保持存活，后续工具调用仍正常）

## 编译与测试

- [ ] **mcp-server 包编译无错误**（验证：`cd packages/mcp-server && npx tsc --noEmit` 退出码 0）
- [ ] **strict 模式无 any 逃逸**（验证：编译通过即代表 strict/noImplicitAny 无违反）
- [ ] **无未使用变量告警**（验证：`npx tsc --noEmit` 不产生 noUnusedLocals/noUnusedParameters 错误）
- [ ] **代码符合 ts-lang-spec 规范**（验证：开发时已加载 ts-lang-spec 技能；人工检查命名风格（PascalCase 类型/类、camelCase 函数、UPPER_SNAKE_CASE 常量）、JSDoc 注释、2 空格缩进）
- [ ] **文件编码未被破坏**（验证：`od -An -tx1 packages/mcp-server/src/index.ts | head -1` 输出无 BOM 字节 `357 273 277`；新建文件首字节为 `2f 2a 2a`（`/**`）或正常代码字符）
- [ ] **不使用 fs.watch/fs.watchFile**（验证：`grep -rn "fs.watch\|watchFile" packages/mcp-server/src/` 无输出）
- [ ] **无硬编码魔法数字**（验证：`grep -rn "\b\(500\|3000\|65536\|15\|600\|30000\)\b" packages/mcp-server/src/ | grep -v "node_modules"` 无裸数字——均通过 shared 常量引用；唯一例外是注释中的数值说明）

## 依赖与编码规范

- [ ] **package.json dependencies 含 MCP SDK 与 shared**（验证：`cat packages/mcp-server/package.json` 的 dependencies 含 `@modelcontextprotocol/server` 与 `@smai-kit/msgferry-shared`）
- [ ] **devDependencies 含 typescript 与 @types/node**（验证：同上核对）
- [ ] **ESM 模块解析正确**（验证：所有 import 语句使用 `.js` 扩展名；package.json 含 `"type": "module"`）
- [ ] **Node 版本对齐**（验证：`node -v` 输出 ≥ v20.0.0）
- [ ] **队列常量引用 shared**（验证：`grep -rn "QUEUE_DIRS\|HEARTBEAT_FILE\|POLLING\|HEARTBEAT\.\|WAIT\.\|OUTPUT\." packages/mcp-server/src/` 确认全部从 @smai-kit/msgferry-shared import，无自行重复定义）

## 端到端场景

- [ ] **场景 1：正常任务全流程**（验证：创建临时 HGFS 目录，启动 worker mock 模式，启动 mcp-server 进程，通过 stdio 调用 submit_ssh_task 提交 `docker ps`；观察：返回 status=completed、stdout 含 `[mock] executed: docker ps`、exit_code=0、duration_ms > 0；pending/ 文件消失、completed/ 出现结果 JSON、heartbeat.json 存在）
- [ ] **场景 2：Worker 离线拒绝提交**（验证：不启动 worker，启动 mcp-server，调用 submit_ssh_task 提交 `docker ps`；观察：返回 error_code='worker_offline'（无心跳）或等待超时后返回 error_code='execution_timeout'（有心跳但 worker 实际未运行）；pending/ 无任务文件或超时后 cancelled/ 出现取消标记）
- [ ] **场景 3：取消任务全流程**（验证：在 pending/ 放一个任务文件，启动 mcp-server，调用 cancel_task；观察：cancelled/ 出现 `<task_id>` 标记文件、返回 cancelled=true；随后启动 worker，worker 检查到取消标记后回写到 cancelled/<id>.result 而非 completed/；调 query_task_status 返回 status=cancelled）
- [ ] **场景 4：健康检查全流程**（验证：创建临时 HGFS 目录，分别构造三种心跳状态调用 check_bridge_health——①无 heartbeat.json 返回 online=false + reason=no_heartbeat；②写当前心跳返回 online=true；③写过期心跳（last_beat=20s 前）返回 online=false + reason=heartbeat_expired；④写 shutdown_at 非空心跳返回 online=false + reason=worker_shutdown）
