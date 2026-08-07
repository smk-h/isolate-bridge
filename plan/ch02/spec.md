# MsgFerry worker Spec（ch02）

## 背景

ch01 已交付 `packages/shared` 类型契约层，定义了 CommandTask、SessionTask、TaskStatus、ErrorCode、QUEUE_DIRS、POLLING、HEARTBEAT、RETENTION 等全部共享符号。内外网两侧通过引用 `@smai-kit/msgferry-shared` 保证对任务 JSON 的读写契约一致。

`packages/worker` 是架构文档「1.2 外网执行模块」描述的常驻后台进程，运行于 Windows 宿主机，负责消费 HGFS 共享目录下的待执行任务、经安全策略校验后 SSH 执行、回写结果。当前 `packages/worker/src/index.ts` 仅有占位代码（`console.log("Hello, I'm worker")` 与一行 re-export），尚未实现任何运行时逻辑。

Worker 是整个摆渡系统的执行层，不含任何大模型，纯 IO 逻辑。它从 `pending/` 目录轮询发现任务，创建 `processing/<task_id>.lock` 原子抢占，经命令安全策略校验后调用 SSH 执行器，捕获 stdout/stderr/exit_code，超大输出落 `outputs/` 子目录，按执行结果回写 `completed/` 或 `failed/`，并周期性写心跳供内网感知存活。任务回写前检查 `cancelled/` 目录，已取消则改写 `cancelled/<task_id>.result` 仅审计用，不污染 completed 队列。

## 目标

- G1: 实现常驻后台进程入口，支持启动参数解析（HGFS 根目录路径、SSH 配置来源、日志路径等），进程启动后进入主循环。
- G2: 实现轮询主循环，按 ch01 的 POLLING 退避参数（起步 500ms、上限 3s、有任务复位）轮询 `pending/` 目录，发现任务后抢占执行。
- G3: 实现任务抢占机制，基于 `processing/<task_id>.lock` 的 `O_CREAT|O_EXCL` 独占创建，锁文件附加 Worker PID 与时间戳，抢占失败者跳过。
- G4: 实现命令安全策略校验，维护白名单前缀、黑名单、参数校验，未命中策略的命令直接进入 `failed/` 队列并标记 `policy_blocked=true`、`error_msg=blocked_by_policy`。
- G5: 实现 SSH 执行层接口，提供 mock 实现（打印命令信息并返回固定文本），生产实现由后续章节填充。
- G6: 实现结果回写与大输出分流，stdout/stderr 超过 max_inline_bytes 落 `outputs/<task_id>.stdout` 等分包文件，结构体只保留摘要与指针。
- G7: 实现取消检查与孤儿结果回收，Worker 回写前检查 `cancelled/<task_id>` 是否存在，已取消则改写 `cancelled/<task_id>.result`。
- G8: 实现心跳保活，每 5s 写入 `heartbeat.json`（pid、last_beat、processed_count、queue_depth）。
- G9: 实现审计日志，滚动文件，每条任务记录 task_id、cmd 摘要、命中策略、ssh 目标、exit_code、耗时、是否被取消，默认保留 30 天，支持按 task_id 检索。
- G10: 实现结果文件 GC，completed/failed 结果文件保留 10 分钟后由 Worker 自动清理。
- G11: 实现进程信号处理，收到 SIGINT/SIGTERM 时优雅退出（完成当前任务、写心跳关闭标记、刷新审计日志）。

## 功能需求

### F1: 进程入口与启动配置

Worker 以独立可执行进程形式启动，启动时接收以下配置：
- HGFS 共享根目录路径（必填）
- SSH 执行器选择（mock / 真实，默认 mock）
- SSH 连接配置（host、port、用户名、私钥路径或密码）——真实模式必填，mock 模式忽略
- 审计日志目录路径（默认 HGFS 根目录下的 `logs/` 子目录）
- 策略文件路径（默认 HGFS 根目录下 `policy/` 子目录的策略定义文件）
- 轮询参数覆盖（可选，覆盖 ch01 的默认退避参数）
- 心跳写入间隔（可选，覆盖 ch01 默认 5s）
- 结果保留期（可选，覆盖 ch01 默认 600s）

启动时校验 HGFS 根目录存在且可读写，子目录不存在则自动创建。校验失败则拒绝启动并报错退出。

### F2: 轮询主循环

Worker 主进程进入无限循环，按 ch01 的 POLLING 退避参数轮询 `pending/` 目录：
- 每轮 `listdir(pending/)`，发现 `.json` 任务文件则提取 task_id
- 有任务时立即处理，处理完复位轮询间隔到起步值（500ms）
- 无任务时退避等待，间隔从起步值指数增长至上限（3s）
- 每轮检查进程是否收到退出信号，收到则跳出循环进入优雅退出流程

### F3: 任务抢占

发现新任务后，Worker 尝试原子抢占：
- 先尝试创建 `processing/<task_id>.lock` 文件，使用 `O_CREAT|O_EXCL` 独占创建模式
- 创建成功者获得执行权，锁文件内容写入 `{worker_pid, lock_time}`
- 创建失败（文件已存在）说明被其他 Worker 抢占，跳过该任务继续轮询
- 抢占成功后将任务状态从 pending 流转为 processing（写入 `processing/<task_id>.json`，删除 `pending/<task_id>.json`，保留锁文件）

### F4: 命令安全策略校验

抢占成功后，Worker 解析任务 JSON 的 `cmd` 字段，经安全策略校验：
- **白名单前缀匹配**：命令首词（如 `docker`、`kubectl`、`systemctl`、`journalctl`、`cat`、`ls`、`tail`）须命中白名单
- **黑名单匹配**：命令须不命中高危黑名单（如 `rm -rf /`、`dd`、`mkfs`、fork 炸弹）
- **参数校验**：命令经 shell-quote 解析后，参数中不得出现危险模式（如 `;`、`&&`、`||` 后接非白名单命令、`$()` 命令替换）
- 命中策略失败的任务：标记 `policy_blocked=true`、`error_msg='blocked_by_policy'`、状态流转到 failed，写入 `failed/<task_id>.json`
- 策略规则集从 `policy/` 目录的策略文件加载，支持运行时重载（文件变化检测或定时刷新）

### F5: SSH 执行层（接口 + mock 实现）

定义 SSH 执行器接口，输入为命令字符串与超时秒数，输出为 stdout、stderr、exit_code、是否超时。
- 提供 mock 实现：执行时打印命令信息与固定文本到 stdout（如 `[mock] executed: <cmd>`），exit_code 固定为 0，不真实连网
- 真实 ssh2 实现由后续章节填充，本章只占位
- 执行器实现按启动配置选择，默认 mock

### F6: 结果回写与大输出分流

SSH 执行返回后，Worker 回填任务结构体：
- stdout/stderr 实际字节数记入 `stdout_size`/`stderr_size`
- 若实际字节数超过 `max_inline_bytes`（默认 65536）：大输出写入 `outputs/<task_id>.stdout` 与 `outputs/<task_id>.stderr`，结构体的 `stdout`/`stderr` 字段只保留前 N 字节摘要，`truncated=true`，`stdout_overflow_path`/`stderr_overflow_path` 指向分包文件
- exit_code 记入 `exit_code`，异常信息记入 `error_msg`
- 状态流转：成功（exit_code=0）→ completed；失败（exit_code≠0 或异常）→ failed
- 结果文件以 `.tmp` → rename 原子写入 `completed/<task_id>.json` 或 `failed/<task_id>.json`

### F7: 取消检查与孤儿结果回收

Worker 回写结果前检查 `cancelled/<task_id>` 是否存在：
- 存在：说明内网已放弃等待并写取消标记，Worker 改写结果到 `cancelled/<task_id>.result`（仅审计用，不污染 completed 队列），任务状态置为 cancelled
- 不存在：正常回写到 completed/failed
- 取消检查与结果回写须原子化，避免竞态（内网在 Worker 检查后写入取消标记）

### F8: 心跳保活

Worker 周期性写入 `heartbeat.json` 到 HGFS 根目录：
- 内容：`{pid, last_beat, processed_count, queue_depth}`
- 写入间隔默认 5s（ch01 HEARTBEAT.write_interval_sec）
- 写入采用 `.tmp` → rename 原子化
- 心跳写入失败不阻塞主循环，仅记录告警日志

### F9: 审计日志

Worker 维护本地审计日志，滚动文件存储：
- 每条任务记录：task_id、cmd 摘要（前 200 字符）、命中策略结果、ssh 目标、exit_code、耗时毫秒、是否被取消
- 日志文件按日期滚动，单文件超过阈值（如 10MB）也滚动
- 默认保留 30 天，过期自动清理
- 支持按 task_id 检索（grep 或日志索引）

### F10: 结果文件 GC

Worker 周期性扫描 `completed/` 与 `failed/` 目录，清理过期结果文件：
- 保留期默认 600s（ch01 RETENTION.result_ttl_sec）
- 超过保留期的文件删除，避免目录无限增长拖慢 listdir
- GC 周期可与心跳周期对齐（每 5s 扫描一次），或独立周期（如每 60s 扫描一次）
- GC 失败不阻塞主循环，仅记录告警日志

### F11: 进程信号处理与优雅退出

Worker 监听 SIGINT/SIGTERM：
- 收到信号后设置退出标志，主循环检查到标志后跳出
- 退出前完成当前正在执行的任务（若 SSH 在执行中则等待其完成或超时）
- 写入最终心跳（标记 shutdown 时间）
- 刷新审计日志缓冲
- 关闭日志文件句柄
- 退出码 0 表示正常退出，非 0 表示异常

## 非功能需求

- N1: **常驻进程稳定性**：Worker 设计为长期运行（天/周级别），主循环不得因单任务异常而崩溃，所有异常须被捕获并记录到审计日志后继续下一轮。
- N2: **HGFS 兼容性**：所有文件操作使用 Node.js 内置 `fs` API，不依赖 inotify/fs.watch 等事件通知（架构文档 3.4 已论证 HGFS 不可靠），全部基于轮询。
- N3: **原子性**：任务提交、锁抢占、结果回写、心跳写入均采用 `.tmp` → rename 或 `O_CREAT|O_EXCL` 原子操作，避免半写入脏数据。
- N4: **低资源占用**：空闲轮询时 CPU 占用极低（退避到 3s 间隔），不抢占 HGFS IO 带宽；单进程、无子进程池（除 SSH 执行器内部）。
- N5: **类型严格**：所有代码启用 strict、noImplicitAny、noUnusedLocals，与 tsconfig.base.json 对齐，禁止 `any` 逃逸。
- N6: **ESM 模块**：遵循 `package.json` 的 `"type": "module"`，使用 ESM 语法与 NodeNext 模块解析，import 语句带 `.js` 扩展名。
- N7: **Node 版本**：目标运行时 Node.js ≥ 20，与根 `package.json` 的 engines.node 一致。
- N8: **可观测性**：所有关键路径（抢占、校验、执行、回写、心跳、GC）均有审计日志覆盖，出问题可通过日志定位，不需逐行读代码。
- N9: **信号响应及时**：收到 SIGINT/SIGTERM 后最长在当前任务完成或超时后退出，不无限阻塞。
- N10: **配置可覆盖**：所有 ch01 定义的默认参数（轮询间隔、心跳间隔、保留期、大输出阈值）均可通过启动配置覆盖，不硬编码。

## 不做的事

- **不实现真实 ssh2 连接**：SSH 执行层只提供 mock 实现（打印信息并返回固定文本），真实 ssh2 实现由后续章节填充。
- **不实现 MCP 协议层**：Worker 不含 MCP server 逻辑，不与 Claude Code 直接通信，只通过 HGFS 文件队列与内网协作。
- **不实现内网侧逻辑**：任务提交、结果回读、内网心跳读取属于 mcp-server 的职责，Worker 不关心内网如何使用结果。
- **不实现 session 交互式摆渡**：stdin/stdout 双向文件摆渡、pty 注入属于远期工作，本章不展开。
- **不实现多 Worker 协调**：本章支持多 Worker 并发抢占（通过锁文件互斥），但不实现 Worker 间的任务分发协调或负载均衡策略，依赖锁抢占的自然竞争。
- **不实现 Web 管理界面或 API**：Worker 是无界面进程，无 HTTP 端口暴露，无管理 API。
- **不引入运行时校验库**（如 zod）：任务 JSON 反序列化用手动类型断言 + 字段存在性检查，不绑定校验框架。
- **不实现策略热加载的复杂机制**：策略文件变化检测用定时轮询 stat mtime，不引入 fs.watch。

## 验收标准

- AC1: Worker 可作为独立进程启动，启动时接收 HGFS 根目录路径等配置；HGFS 根目录不存在或不可读写时拒绝启动并报错退出（验证：启动时传入不存在的路径，观察退出码非 0 与错误信息）。
- AC2: Worker 启动后自动创建 pending/processing/completed/failed/cancelled/outputs/policy 子目录（若不存在）（验证：传入空目录启动，观察子目录全部创建）。
- AC3: 主循环按退避参数轮询 pending/，有任务时立即处理并复位间隔到 500ms，无任务时退避到 3s（验证：在 pending/ 放入任务文件，观察 Worker 在 ≤1s 内发现并处理；清空 pending/ 后观察轮询间隔增长到 3s）。
- AC4: 任务抢占使用 `processing/<task_id>.lock` 的 O_CREAT|O_EXCL 创建，锁文件含 worker_pid 与 lock_time；并发两个 Worker 抢占同一任务时只有一个成功（验证：启动两个 Worker 进程，在 pending/ 放一个任务，观察只有一个 processing/<task_id>.lock 创建成功）。
- AC5: 安全策略校验白名单前缀命中、黑名单拦截、参数危险模式拦截三种场景；未命中策略的任务进 failed/ 且 policy_blocked=true、error_msg='blocked_by_policy'（验证：提交 `docker ps` 命中白名单通过；提交 `rm -rf /` 命中黑名单进 failed；提交 `ls; rm -rf /` 参数危险模式进 failed）。
- AC6: SSH 执行器 mock 实现执行命令时打印命令信息并返回固定文本，exit_code=0，不真实连网（验证：提交任务后观察 stdout 含 `[mock]` 标记且固定文本，无网络调用）。
- AC7: 结果回写采用 .tmp → rename 原子写入 completed/ 或 failed/；stdout/stderr 超 max_inline_bytes 落 outputs/ 分包文件，结构体 truncated=true 且指针路径非空（验证：提交产生 >64KB 输出的命令，观察 outputs/<task_id>.stdout 存在且结构体 stdout_overflow_path 指向它）。
- AC8: Worker 回写前检查 cancelled/<task_id>，已取消则改写 cancelled/<task_id>.result，任务状态为 cancelled（验证：提交任务后立即在 cancelled/ 写取消标记，观察 Worker 回写到 cancelled/ 而非 completed/）。
- AC9: 心跳每 5s 写入 heartbeat.json，内容含 pid、last_beat、processed_count、queue_depth，采用 .tmp → rename 原子化（验证：Worker 运行 10s 后观察 heartbeat.json 的 last_beat 在 5s 内更新过）。
- AC10: 审计日志按滚动文件存储，每条任务记录 task_id、cmd 摘要、命中策略、ssh 目标、exit_code、耗时、是否被取消；保留 30 天后自动清理（验证：提交任务后观察审计日志含对应条目；构造 31 天前的日志文件观察被清理）。
- AC11: 结果文件 GC 清理 completed/ 与 failed/ 中超过保留期（默认 600s）的文件（验证：构造一个 mtime 超过 600s 的结果文件，观察 GC 周期后被删除）。
- AC12: 收到 SIGINT/SIGTERM 后 Worker 在当前任务完成或超时后退出，退出前写入最终心跳并刷新审计日志（验证：启动 Worker，提交一个任务，在执行中发送 SIGTERM，观察 Worker 完成任务后退出且心跳有 shutdown 标记）。
- AC13: 所有文件操作不使用 fs.watch/inotify，纯轮询（验证：grep 源码无 fs.watch/fs.watchFile 调用）。
- AC14: Worker 代码 `tsc --noEmit` 编译通过，无 any 逃逸、无未使用变量告警（与 tsconfig.base.json 的 strict 配置对齐）。
- AC15: Worker 的 package.json dependencies 含 @smai-kit/msgferry-shared 与 ssh2，devDependencies 含 typescript、@types/node、@types/ssh2（验证：cat package.json 核对）。
