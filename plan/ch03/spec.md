# MsgFerry mcp-server Spec（ch03）

## 背景

ch01 已交付 `packages/shared` 类型契约层，ch02 已交付 `packages/worker` 外网执行进程。内外网两侧通过引用 `@smai-kit/msgferry-shared` 保证任务 JSON 读写契约一致。Worker 已实现任务消费、锁抢占、安全策略校验、Mock SSH 执行、结果回写、心跳保活、审计日志、GC 等全部运行时逻辑。

`packages/mcp-server` 是架构文档「1.1 内网工具模块」描述的 MCP Server，运行于内网 VMware 虚拟桌面，由 Claude Code 通过 MCP 配置拉起（stdio 协议）。它对内封装 HGFS 文件队列的全部细节，对外暴露标准化 MCP 工具供 Claude Code 调用，是内网 AI 代理操控外网设备的唯一入口。

当前 `packages/mcp-server/src/index.ts` 仅有占位代码（`console.log("Hello, I'm mcp-server")` 与 `PACKAGE_NAME` 常量），尚未实现任何运行时逻辑。`package.json` 已声明 `@modelcontextprotocol/server` 与 `@smai-kit/msgferry-shared` 两个依赖。

## 目标

- G1: 实现 MCP Server 进程入口，通过 stdio 协议与 Claude Code 通信，启动时接收 HGFS 共享根目录路径配置，初始化队列子目录后进入工具服务就绪状态。
- G2: 实现 `submit_ssh_task` 工具，接收命令字符串与超时上限，生成唯一 task_id，组装任务 JSON，提交前检查 Worker 心跳存活与重复提交，原子写入 `pending/`，阻塞轮询 `completed/`/`failed/`/`cancelled/` 目录等待结果，返回完整执行信息。
- G3: 实现 `query_task_status` 工具，按 task_id 轮询各队列目录（pending/processing/completed/failed/cancelled）查找任务文件，返回当前状态与已有结果字段。
- G4: 实现 `cancel_task` 工具，按 task_id 在 `cancelled/` 目录写入取消标记文件，触发 Worker 孤儿结果回收。
- G5: 实现 `check_bridge_health` 工具，读取 `heartbeat.json`，判断 Worker 是否在线（`now - last_beat > 15s` 则离线），返回心跳内容与在线状态。
- G6: 实现大输出溢出读取，当结果 `truncated=true` 时按 `stdout_overflow_path`/`stderr_overflow_path` 指针从 `outputs/` 子目录读取完整输出并拼回。
- G7: 实现提交前幂等保障，检查 `pending/` 与 `processing/` 是否已存在同 task_id，存在则拒绝重复提交并返回已有状态。
- G8: 实现超时兜底，提交后阻塞等待超过最大等待时长（默认 30s）时写入 `cancelled/<task_id>` 取消标记并返回 timeout 错误。

## 功能需求

### F1: MCP Server 进程入口与配置

MCP Server 以独立进程形式启动，由 Claude Code 通过 MCP 配置拉起，通过 stdio 协议与 Claude Code 通信。启动时接收以下配置：
- HGFS 共享根目录路径（必填，通过环境变量或命令行参数提供）
- 内网默认最大等待时长（可选，覆盖 shared 的 WAIT.default_max_wait_ms）
- 轮询退避参数（可选，覆盖 shared 的 POLLING 默认值）

启动时校验 HGFS 根目录存在且可读写，初始化全部队列子目录（pending/processing/completed/failed/cancelled/outputs/policy）。校验失败则拒绝启动并报错退出。进程生命周期与 Claude Code 会话绑定，Claude Code 断开 stdio 连接时优雅退出。

### F2: submit_ssh_task 工具

提供提交 SSH 任务的能力，接收以下参数：
- `cmd`（必填）：待执行 SSH 命令字符串
- `timeout_sec`（可选，默认 30）：命令执行超时上限（秒）
- `task_id`（可选）：自定义任务标识，未提供则自动生成 UUID

提交流程：
1. 若未提供 task_id，生成唯一 UUID
2. **幂等检查**：检查 `pending/` 与 `processing/` 是否已存在同 task_id 的任务文件，存在则拒绝重复提交，返回 `duplicate_submit` 错误码与已有任务状态
3. **Worker 存活检查**：读取 `heartbeat.json`，若不存在或 `now - last_beat > 15s`（HEARTBEAT.expiry_sec），返回 `worker_offline` 错误码，不提交任务
4. 组装 CommandTask 结构体（kind='command'，status='pending'，submit_time 填充，其余执行相关字段初始化为零值/null）
5. 原子写入 `pending/<task_id>.json`（.tmp → rename）
6. 阻塞轮询等待结果（见 F7）
7. 结果返回后，若 `truncated=true` 则按指针读取大输出（见 F6），拼装为最终响应

返回内容包含：task_id、status（completed/failed/cancelled）、exit_code、stdout、stderr、error_msg、truncated、stdout_size、stderr_size、执行耗时等完整执行信息。

### F3: query_task_status 工具

提供按 task_id 查询任务当前状态的能力，接收 `task_id`（必填）参数。

查询流程：
1. 依次检查 `completed/<task_id>.json`、`failed/<task_id>.json` 是否存在——找到则返回该结果文件完整内容
2. 检查 `cancelled/<task_id>.result` 是否存在——找到则返回取消后的结果内容
3. 检查 `cancelled/<task_id>` 取消标记是否存在——存在说明已取消但结果尚未回写，返回 status=cancelled
4. 检查 `processing/<task_id>.json` 是否存在——存在返回 status=processing 及已有字段
5. 检查 `pending/<task_id>.json` 是否存在——存在返回 status=pending
6. 全部目录均未找到——返回 `not_found` 错误，说明任务不存在或已被 GC 清理

若结果文件 `truncated=true`，同样按指针读取大输出拼回。

### F4: cancel_task 工具

提供取消任务的能力，接收 `task_id`（必填）参数。

取消流程：
1. 在 `cancelled/` 目录写入取消标记文件 `cancelled/<task_id>`（空文件或仅含时间戳）
2. 写入采用原子操作（.tmp → rename）
3. 返回取消成功确认
4. 若任务已处于终态（completed/failed/cancelled），取消标记无实际效果（Worker 回写前已检查，终态任务不会被回写），但仍写入取消标记供审计
5. 若 task_id 不存在于任何队列目录，返回 `not_found` 错误

### F5: check_bridge_health 工具

提供检查外网 Worker 存活状态的能力，无参数。

检查流程：
1. 读取 `heartbeat.json`
2. 文件不存在——返回 `{ online: false, reason: 'no_heartbeat' }`
3. 文件存在——解析 `{ pid, last_beat, processed_count, queue_depth, shutdown_at }`
4. 若 `shutdown_at` 非空——返回 `{ online: false, reason: 'worker_shutdown', heartbeat }`
5. 计算 `now - last_beat`，超过 HEARTBEAT.expiry_sec（15s）——返回 `{ online: false, reason: 'heartbeat_expired', heartbeat, age_sec }`
6. 未过期——返回 `{ online: true, heartbeat, age_sec }`

### F6: 大输出溢出读取

当结果任务的 `truncated=true` 时，按 `stdout_overflow_path` 与 `stderr_overflow_path` 指针从 `outputs/` 子目录读取完整输出文件：
1. 路径为相对于 HGFS 根目录的相对路径（如 `outputs/<task_id>.stdout`）
2. 拼接为绝对路径后读取文件内容
3. 读取成功——将完整输出填入响应的 stdout/stderr 字段，清除 truncated 标记（响应层面）
4. 读取失败（文件不存在/不可读）——保留 truncated=true，填入 `overflow_read_failed` 错误码到 error_msg，stdout/stderr 保留结构体内联摘要

### F7: 阻塞等待与超时兜底

`submit_ssh_task` 提交任务后进入阻塞轮询等待结果：
1. 轮询检查 `completed/<task_id>.json`、`failed/<task_id>.json`、`cancelled/<task_id>.result` 三个位置
2. 采用指数退避（起步 POLLING.initial_interval_ms=500ms，上限 POLLING.max_interval_ms=3000ms）
3. 任一位置命中——读取结果返回
4. 超过最大等待时长（默认 WAIT.default_max_wait_ms=30000ms）——写入 `cancelled/<task_id>` 取消标记，返回 `execution_timeout` 错误码
5. 等待期间不响应其他工具调用（MCP Server 单工具串行执行，Claude Code 侧多轮调用由 LLM 编排）

## 非功能需求

- N1: **HGFS 兼容性**：所有文件操作使用 Node.js 内置 `fs` API，不依赖 inotify/fs.watch 等事件通知（架构文档 3.4 已论证 HGFS 不可靠），全部基于轮询。与 worker 保持一致。
- N2: **原子性**：任务提交（.tmp → rename）、取消标记写入均采用原子操作，避免 worker 读到半写入的脏数据。
- N3: **类型严格**：所有代码启用 strict、noImplicitAny、noUnusedLocals、noUnusedParameters，与 tsconfig.base.json 对齐，禁止 `any` 逃逸。
- N4: **ESM 模块**：遵循 `package.json` 的 `"type": "module"`，使用 ESM 语法与 NodeNext 模块解析，import 语句带 `.js` 扩展名，与 monorepo 其余 package 一致。
- N5: **Node 版本**：目标运行时 Node.js ≥ 20，与根 `package.json` 的 engines.node 一致。
- N6: **进程稳定性**：MCP Server 生命周期与 Claude Code 会话绑定，单个工具调用异常不得导致进程崩溃，异常须被捕获并转为结构化错误响应返回 Claude Code，保持 stdio 连接存活。
- N7: **契约一致性**：任务结构体、状态枚举、错误码、队列目录常量全部引用 `@smai-kit/msgferry-shared`，不自行重复定义，保证与 worker 读写契约完全一致。
- N8: **不引入运行时校验库**（如 zod）：任务 JSON 反序列化用手动类型断言 + 字段存在性检查，与 worker 风格一致。
- N9: **可观测性**：关键路径（配置解析、队列初始化、任务提交、结果回读、心跳检查、取消）有合理的日志输出到 stderr（不影响 stdio 的 MCP 消息通道），便于排查。
- N10: **配置可覆盖**：ch01 定义的默认参数（最大等待时长、轮询间隔）均可通过环境变量或启动参数覆盖，不硬编码。

## 不做的事

- **不实现真实 SSH 执行**：SSH 连接、命令下发、超时销毁子进程等逻辑属于外网 worker 的职责，mcp-server 只负责投递任务到 `pending/` 并回读结果，不直接执行任何命令。
- **不实现安全策略校验**：白/黑名单匹配、参数危险模式检测属于外网 worker，mcp-server 不做命令安全校验，Claude Code 生成的命令原样投递。
- **不实现心跳写入**：心跳写入属于外网 worker，mcp-server 只读取 `heartbeat.json` 判断存活。
- **不实现结果文件 GC**：completed/failed 结果文件清理属于外网 worker 的 GC 逻辑，mcp-server 只读取不清理。
- **不实现 session 交互式摆渡**：stdin/stdout 双向文件摆渡属于远期工作，本章不展开 SessionTask 的执行逻辑。
- **不实现批量任务编排**：`batch_id` 与 `depends_on` 字段在任务结构体中保留，但本章不提供批量提交与依赖编排工具，Claude Code 通过多次调用 `submit_ssh_task` 自行编排。
- **不实现审计日志**：内网侧不维护审计日志文件，任务记录由外网 worker 的审计模块统一维护；mcp-server 仅在 stderr 输出运行时诊断日志。
- **不实现多 Worker 协调**：mcp-server 不关心有几个 worker 在消费，依赖锁抢占的自然竞争，只通过心跳判断「是否有至少一个 worker 在线」。
- **不引入 fs.watch / inotify**：与 worker 一致，全部基于轮询，理由见架构文档 3.4。
- **不实现 Web 管理界面或 HTTP 端口**：mcp-server 无 HTTP 端口暴露，无管理 API，仅通过 stdio 与 Claude Code 通信。

## 验收标准

- AC1: MCP Server 可作为独立进程启动，通过环境变量或命令行参数接收 HGFS 根目录路径；HGFS 根目录不存在或不可读写时拒绝启动并报错退出（验证：传入不存在的路径启动，观察退出码非 0 与错误信息）。
- AC2: MCP Server 启动后自动创建 pending/processing/completed/failed/cancelled/outputs/policy 全部子目录（验证：传入空目录启动，观察子目录全部创建）。
- AC3: `submit_ssh_task` 工具提交任务后，`pending/<task_id>.json` 原子出现（.tmp → rename），文件内容为完整的 CommandTask JSON，status=pending（验证：调用工具后检查 pending/ 目录文件存在且 JSON 合法）。
- AC4: `submit_ssh_task` 在 Worker 离线时（无 heartbeat.json 或 last_beat 过期 >15s）返回 `worker_offline` 错误码且不写入 pending/（验证：删除或篡改 heartbeat.json 后调用工具，观察返回 worker_offline 且 pending/ 无新文件）。
- AC5: `submit_ssh_task` 对已存在于 pending/ 或 processing/ 的 task_id 拒绝重复提交，返回 `duplicate_submit` 错误码与已有任务状态（验证：先提交一个任务，用相同 task_id 再次提交，观察返回 duplicate_submit）。
- AC6: `submit_ssh_task` 提交后能阻塞等待并正确返回 Worker 回写的结果：completed 任务返回 stdout/stderr/exit_code，failed 任务返回 error_msg（验证：启动 worker mock 模式，调用工具提交 `docker ps`，观察返回 stdout 含 `[mock]` 标记、exit_code=0）。
- AC7: `submit_ssh_task` 在结果 `truncated=true` 时按 `stdout_overflow_path` 从 `outputs/` 读取完整输出拼回响应（验证：提交产生 >64KB 输出的任务——需 mock worker 配合或手动构造 outputs 文件，观察返回的 stdout 为完整内容而非截断摘要）。
- AC8: `submit_ssh_task` 等待超过最大等待时长（默认 30s）时写入 `cancelled/<task_id>` 取消标记并返回 `execution_timeout` 错误码（验证：不启动 worker，提交任务后等待超时，观察 cancelled/ 出现取消标记且返回 execution_timeout）。
- AC9: `query_task_status` 工具能按 task_id 正确返回任务状态：任务在 pending 返回 pending、在 processing 返回 processing、在 completed/failed 返回完整结果、在 cancelled 返回 cancelled、不存在返回 not_found（验证：分别在各目录放置任务文件后调用工具，核对返回状态）。
- AC10: `cancel_task` 工具在 `cancelled/` 目录写入取消标记文件 `cancelled/<task_id>`（验证：调用工具后检查 cancelled/ 目录出现对应文件；对不存在的 task_id 调用返回 not_found）。
- AC11: `check_bridge_health` 工具正确判断 Worker 存活：heartbeat.json 不存在返回 online=false + reason=no_heartbeat；last_beat 过期返回 online=false + reason=heartbeat_expired；正常返回 online=true（验证：分别构造三种场景调用工具核对返回）。
- AC12: `check_bridge_health` 在 heartbeat.json 的 `shutdown_at` 非空时返回 online=false + reason=worker_shutdown（验证：构造 shutdown_at 有值的 heartbeat.json，调用工具核对返回）。
- AC13: MCP Server 通过 stdio 与 Claude Code 正确通信，工具注册与调用符合 MCP 协议规范，四个工具可被 Claude Code 发现已调用（验证：用 MCP 客户端工具列出 tools 并逐一调用，观察响应格式合法）。
- AC14: 单个工具调用异常不导致进程崩溃，异常被捕获并转为结构化错误响应返回，stdio 连接保持存活（验证：传入非法参数调用工具，观察返回错误响应而非进程退出）。
- AC15: mcp-server 包 `tsc --noEmit` 编译通过，无 `any` 类型逃逸，无未使用变量告警（验证：编译通过即代表 strict 配置无违反）。
- AC16: mcp-server 的 `package.json` dependencies 含 `@modelcontextprotocol/server` 与 `@smai-kit/msgferry-shared`，devDependencies 含 typescript 与 @types/node（验证：cat package.json 核对）。
- AC17: 所有文件操作不使用 fs.watch/fs.watchFile，纯轮询（验证：grep 源码无 fs.watch/fs.watchFile 调用）。
- AC18: 全部队列目录名、轮询参数、心跳阈值、等待时长均引用 `@smai-kit/msgferry-shared` 的常量，不出现硬编码魔法数字（验证：grep 源码无裸数字 500/3000/65536/15/600/30000 等魔法数字，均通过常量引用）。
