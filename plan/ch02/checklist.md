# MsgFerry worker Checklist（ch02）

> 每一项通过运行代码或观察行为来验证，聚焦系统行为。所有命令在 `packages/worker` 目录下执行，除非另注。临时验证脚本使用完毕后删除，不留入仓库。

## 实现完整性

- [ ] **backoff 模块退避逻辑正确**（验证：临时脚本调 `createBackoff(500, 3000)`，连续 `next()` 返回 500/1000/2000/3000/3000，`reset()` 后返回 500）
- [ ] **config 模块解析参数与默认值**（验证：临时脚本传入 `['node','main','--hgfs-root','/tmp/hgfs']`，断言 config.hgfs_root='/tmp/hgfs'、polling.initial_interval_ms=500、heartbeat_interval_sec=5、result_ttl_sec=600、max_inline_bytes=65536）
- [ ] **config 校验拒绝不存在的 hgfs_root**（验证：传入 `--hgfs-root /nonexistent` 调 validateConfig，断言抛错）
- [ ] **queue 模块 initQueueDirs 创建七个目录**（验证：临时脚本传入空目录调 initQueueDirs，断言 pending/processing/completed/failed/cancelled/outputs/policy 全部创建）
- [ ] **queue 模块 acquireLock 原子抢占**（验证：临时脚本对同一 taskId 调两次 acquireLock，第一次返回 true 且 lock 文件存在，第二次返回 false）
- [ ] **queue 模块 listPending 过滤 .tmp**（验证：在 pending/ 放一个 .json 与一个 .tmp，调 listPending 断言只返回 .json 的 task_id）
- [ ] **queue 模块 writeResult 原子回写 completed/failed**（验证：构造 status=completed 的 task 调 writeResult，断言 completed/<id>.json 存在且内容完整）
- [ ] **queue 模块 writeOverflowOutput 分包大输出**（验证：调 writeOverflowOutput 传入大字符串，断言 outputs/<id>.stdout 与 .stderr 存在）
- [ ] **queue 模块 checkCancelled 检测取消标记**（验证：先在 cancelled/ 写标记文件，调 checkCancelled 返回 true；无标记时返回 false）
- [ ] **queue 模块 writeHeartbeat 原子写心跳**（验证：调 writeHeartbeat 后读 heartbeat.json，断言内容含 pid/last_beat/processed_count/queue_depth）
- [ ] **policy 模块 checkCommand 白名单命中**（验证：`docker ps` 返回 `{allowed:true}`）
- [ ] **policy 模块 checkCommand 黑名单拦截**（验证：`rm -rf /` 返回 `{allowed:false, reason:'blacklist_hit'}`）
- [ ] **policy 模块 checkCommand 参数危险模式拦截**（验证：`ls; rm` 返回 `{allowed:false, reason:'param_blocked'}`）
- [ ] **policy 模块 checkCommand 白名单未命中**（验证：`reboot` 返回 `{allowed:false, reason:'whitelist_miss'}`）
- [ ] **executor 模块 MockSshExecutor 返回固定文本**（验证：临时脚本调 execute('docker ps', 30)，断言 stdout 含 `[mock]` 与命令字符串、exit_code=0、timed_out=false）
- [ ] **audit 模块 log 写入滚动文件**（验证：临时脚本 log 两条 entry，断言 `<YYYY-MM-DD>.log` 存在且含两行 JSON）
- [ ] **audit 模块 searchByTaskId 检索**（验证：log 一条 task_id='t1' 的 entry，调 searchByTaskId('t1') 返回 1 条）
- [ ] **audit 模块 gc 清理过期日志**（验证：构造 mtime 超 31 天的 .log 文件，调 gc 断言被删除且返回清理数≥1）
- [ ] **housekeeping 模块心跳循环写入**（验证：startHeartbeatLoop 运行 6s 后停止，读 heartbeat.json 断言 last_beat 在 5s 内）
- [ ] **housekeeping 模块 GC 循环运行**（验证：startGcLoop 运行一次，无异常抛出）

## 集成

- [ ] **main 进程入口可启动**（验证：`npx tsc --noEmit` 通过后，`node --experimental-vm-modules dist/main.js --hgfs-root /tmp/test-hgfs` 启动后不立即退出，进程存活）
- [ ] **main 启动时初始化队列目录**（验证：传入空 /tmp/test-hgfs 启动，观察七个子目录被创建）
- [ ] **main 启动时加载策略与创建执行器**（验证：启动后观察 policy.json 不存在时用默认规则；executor 为 mock 模式）
- [ ] **index.ts re-export 全部模块**（验证：临时脚本 `import * as m from '@smai-kit/msgferry-worker'`，断言 typeof m.main==='function' 且 m.createBackoff/m.parseConfig/m.initQueueDirs 等符号可访问）

## 行为正确性

- [ ] **主循环有任务时立即处理并复位退避**（验证：在 pending/ 放一个 docker ps 任务，启动 main，观察 Worker 在 ≤1s 内发现并处理，pending/ 文件消失，completed/ 出现结果）
- [ ] **主循环无任务时退避到 3s**（验证：清空 pending/ 后启动 main，运行 10s，观察轮询间隔增长到 3s——可通过审计日志或 debug 输出间接验证）
- [ ] **策略拦截任务进 failed 且标记正确**（验证：提交 `rm -rf /` 任务，观察 failed/<id>.json 存在，policy_blocked=true、error_msg='blocked_by_policy'、status=failed）
- [ ] **mock 执行器输出固定文本**（验证：提交 `docker ps` 任务，读 completed/<id>.json，断言 stdout 含 `[mock] executed: docker ps`、exit_code=0）
- [ ] **大输出分流到 outputs/**（验证：提交一个会产生 >64KB stdout 的命令——mock 模式下手动构造，观察 truncated=true、stdout_overflow_path 指向 outputs/<id>.stdout）
- [ ] **取消检查改写 cancelled/**（验证：提交任务后立即在 cancelled/ 写标记，观察 Worker 回写到 cancelled/<id>.result 而非 completed/，status=cancelled）
- [ ] **心跳每 5s 写入**（验证：main 运行 12s 后读 heartbeat.json，断言 last_beat 与当前时间差 ≤5s，processed_count 递增）
- [ ] **结果文件 GC 清理过期**（验证：在 completed/ 构造 mtime 超 600s 的文件，启动 main 等待 GC 周期 60s 或临时调短 ttl，观察文件被删除）
- [ ] **SIGTERM 优雅退出**（验证：启动 main 提交一个任务，执行中 `kill -TERM <pid>`，观察 Worker 完成当前任务后退出，heartbeat.json 含 shutdown_at，退出码 0）

## 编译与测试

- [ ] **worker 包编译无错误**（验证：`cd packages/worker && npx tsc --noEmit` 退出码 0）
- [ ] **strict 模式无 any 逃逸**（验证：编译通过即代表 strict/noImplicitAny 无违反）
- [ ] **无未使用变量告警**（验证：`npx tsc --noEmit` 不产生 noUnusedLocals/noUnusedParameters 错误）
- [ ] **代码符合 ts-lang-spec 规范**（验证：开发时已加载 ts-lang-spec 技能；人工检查命名风格（PascalCase 类型/类、camelCase 函数、UPPER_SNAKE_CASE 常量）、JSDoc 注释、2 空格缩进）
- [ ] **文件编码未被破坏**（验证：`od -An -tx1 packages/worker/src/index.ts | head -1` 输出无 BOM 字节 `357 273 277`；新建文件首字节为 `2f 2a 2a`（`/**`）或正常代码字符）
- [ ] **不使用 fs.watch/fs.watchFile**（验证：`grep -rn "fs.watch\|watchFile" packages/worker/src/` 无输出）

## 依赖与编码规范

- [ ] **package.json dependencies 含 shared 与 ssh2**（验证：`cat packages/worker/package.json` 的 dependencies 含 `@smai-kit/msgferry-shared` 与 `ssh2`）
- [ ] **devDependencies 含 typescript、@types/node、@types/ssh2**（验证：同上核对）
- [ ] **ESM 模块解析正确**（验证：所有 import 语句使用 `.js` 扩展名；package.json 含 `"type": "module"`）
- [ ] **Node 版本对齐**（验证：`node -v` 输出 ≥ v20.0.0）

## 端到端场景

- [ ] **场景 1：正常任务全流程**（验证：创建临时 HGFS 目录，写一个 `docker ps` 任务 JSON 到 pending/，启动 main 进程，2s 后 SIGTERM；观察：pending/ 文件消失、completed/<id>.json 存在且 stdout 含 `[mock]`、heartbeat.json 存在、审计日志含对应条目、进程退出码 0）
- [ ] **场景 2：策略拦截全流程**（验证：同上但任务 cmd 改为 `rm -rf /`；观察：failed/<id>.json 存在且 policy_blocked=true、error_msg='blocked_by_policy'、审计日志 policy_result 为 blacklist_hit）
- [ ] **场景 3：取消回收全流程**（验证：提交任务后立即在 cancelled/ 写 <task_id> 标记文件；观察：Worker 回写到 cancelled/<id>.result、status=cancelled、completed/ 无对应文件、审计日志 cancelled=true）
- [ ] **场景 4：并发抢占互斥**（验证：在 pending/ 放一个任务，同时启动两个 main 进程（不同 pid），观察只有一个 processing/<id>.lock 创建成功、只有一个 completed/<id>.json 产生）
- [ ] **场景 5：优雅退出**（验证：启动 main，提交一个任务，在任务执行中（mock 延时 10ms 内可能太快，可用大量任务堆叠延长窗口）发 SIGTERM；观察 Worker 处理完当前任务后退出、heartbeat.json 有 shutdown_at、审计日志已 flush）
