# MsgFerry shared 类型契约 Spec（ch01）

## 背景

MsgFerry 是隔离网络环境下基于 VMware HGFS 文件队列的 AI 设备指令摆渡桥。架构文档（`docs/msgferry-bridge-architecture.md`）已确定整体方案：内网 MCP 服务与外网 Node Worker 两个独立进程通过 HGFS 共享文件夹以「文件消息队列」协作，两侧不打通 TCP 网络。

工程以 pnpm monorepo 组织，现有三个 package：`packages/shared`、`packages/mcp-server`、`packages/worker`。其中 `packages/shared/src/index.ts` 当前仅含占位代码，尚未定义架构文档「2.3 任务消息结构体」所要求的任务结构体、状态枚举、错误码、队列目录与轮询参数常量等契约。

内外网两侧虽位于不同网络域，但都引用 `@smai-kit/msgferry-shared` 这一共享包，以**同一份 TypeScript 类型定义**保证两侧对任务 JSON 的读写契约完全一致。shared 包本身不含任何运行时逻辑（无 SSH、无文件 IO、无 MCP 协议），只承担「契约层」职责——定义类型、枚举与常量，供两侧 package 在编译期共享。

## 目标

- G1: 用 TypeScript 精确定义架构文档「2.3 任务消息结构体」所描述的任务结构体及其衍生类型，覆盖单命令任务、批量任务、远期 session 交互式任务三种形态。
- G2: 定义任务状态机的状态枚举与终态集合，约束状态单向流转（pending → processing → completed/failed/cancelled）。
- G3: 定义系统级错误码枚举，覆盖策略拦截、超时、Worker 离线、重复提交、孤儿结果等场景，使内外网两侧对失败原因有统一语义。
- G4: 定义 HGFS 队列目录常量、轮询退避参数常量、大输出分包阈值常量、心跳与保留期常量，供两侧复用，避免魔法数字散落各处。
- G5: 提供纯类型层的辅助工具（如状态终态判定、错误码归类），不引入任何运行时副作用，shared 包 import 后不产生任何 IO。

## 功能需求

### F1: 任务结构体主类型

定义架构文档「2.3 任务消息结构体」描述的任务主结构体，字段覆盖：任务唯一标识、批量归属、依赖链、待执行命令、超时上限、时间戳三件套（提交/开始/结束）、stdout 与 stderr 内联输出及其实际长度、截断标记、大输出溢出指针路径、内联上限阈值、退出码、错误信息、状态、Worker PID、策略拦截标记。

### F2: 任务状态枚举与终态集合

定义任务状态枚举，成员覆盖 `pending`、`processing`、`completed`、`failed`、`cancelled` 五个取值。定义终态集合（`completed`、`failed`、`cancelled`）与终态判定函数，约束状态机单向流转，不支持逆向流转。

### F3: 错误码枚举

定义系统级错误码枚举，覆盖以下场景：
- 命令被安全策略拦截（白名单未命中 / 黑名单命中 / 参数校验失败）
- 任务执行超时
- SSH 连接失败 / 设备离线
- Worker 离线（心跳过期）
- 任务重复提交（task_id 已存在于 pending 或 processing）
- 孤儿结果（内网已取消但 Worker 仍尝试回写 completed）
- 大输出读取失败（outputs/ 指针文件缺失）
- 未知错误兜底

每个错误码附带人类可读的简短描述，供内外网两侧统一日志语义。

### F4: 批量任务与依赖类型约束

基于 F1 的单任务结构体定义批量任务相关类型：
- 批量标识类型（与单任务标识同源，但语义独立）
- 依赖任务标识列表类型
- 「带依赖约束的批量任务」类型，约束 `depends_on` 中的每个任务标识必须存在，且禁止出现自依赖与循环依赖
- 提供「批量任务集合」类型，约束同一批量内任务标识唯一

### F5: Session 交互式任务类型

定义远期 session 交互式会话任务类型，覆盖：
- 会话标识
- 会话状态（创建中 / 运行中 / 已关闭 / 异常终止）
- stdin/stdout 摆渡目录约定
- 会话关闭标记类型

该类型与 F1 单命令任务类型并存，通过判别字段区分，不在本阶段展开 stdin/stdout 摆渡的执行逻辑。

### F6: 队列目录与运行参数常量

定义架构文档「2.1 目录结构」所列全部队列目录名常量（pending、processing、completed、failed、cancelled、outputs、policy）及心跳文件名。定义运行参数常量：
- 轮询退避参数（起步间隔、上限间隔、复位条件）
- 大输出内联字节上限阈值
- 心跳过期阈值
- 结果文件保留时长
- 内网默认最大等待时长

所有常量集中管理，禁止在两侧 package 中出现魔法数字。

### F7: 纯类型层辅助工具

提供以下纯函数（无 IO、无副作用）：
- 终态判定：判断给定状态是否为终态
- 错误码归类：判断给定错误码属于「可重试」还是「不可重试」
- 任务类型判别：判断给定任务结构体是单命令任务还是 session 任务
- 状态流转合法性校验：判断从状态 A 到状态 B 的流转是否合法

这些函数供两侧 package 在运行时调用，但 shared 包自身不调用，只负责定义。

## 非功能需求

- N1: **零运行时副作用**：shared 包被 import 后不产生任何 IO、不打印日志、不读写文件、不发起网络请求。包内允许出现的运行时实体仅限纯常量声明与无副作用的纯函数（如终态判定、错误码归类）。
- N2: **类型严格**：所有类型定义启用 `strict`、`strictNullChecks`、`noImplicitAny`、`noUnusedLocals`、`noUnusedParameters`，与 `tsconfig.base.json` 的现有严格配置对齐，不允许 `any` 逃逸。
- N3: **契约稳定性**：任务结构体与错误码属于跨进程契约，命名一旦确定不轻易改动；若必须变更，须保证向后兼容或同步更新两侧 package，避免内外网读写不一致。
- N4: **ESM 模块**：遵循现有 `package.json` 中 `"type": "module"` 的约定，使用 ESM 语法与 `NodeNext` 模块解析，与 monorepo 其余 package 一致。
- N5: **Node 版本对齐**：目标运行时为 Node.js ≥ 20（与根 `package.json` 的 `engines.node` 一致），类型定义可使用 ES2022 标准库特性，不使用更高版本独有 API。
- N6: **无外部依赖**：shared 包不引入任何运行时第三方依赖（无 ssh2、无 MCP SDK），只依赖 Node.js 内置类型与 TypeScript 标准库，保证可被两侧 package 无负担引用。

## 不做的事

- **不实现文件队列的读写逻辑**：`.tmp` → rename 原子提交、`O_CREAT|O_EXCL` 锁抢占、目录轮询等运行时逻辑属于 mcp-server 与 worker 的实现范畴，shared 只提供目录名常量与轮询参数常量。
- **不实现 SSH 执行**：SSH 连接、命令下发、超时销毁子进程等逻辑属于 worker，shared 不引入 ssh2 类型，不在任务结构体中耦合 SSH 协议细节。
- **不实现安全策略校验**：白/黑名单匹配、`shell-quote` 参数解析属于 worker，shared 只定义 `policy_blocked` 标记字段与 `blocked_by_policy` 错误码。
- **不实现 MCP 协议层**：`submit_ssh_task` 等 MCP 工具的注册、stdio 通信属于 mcp-server，shared 不引用 MCP SDK 类型。
- **不实现心跳写入与过期判定逻辑**：Worker 写心跳、MCP 读心跳的运行时逻辑属于两侧 package，shared 只提供心跳文件名常量与过期阈值常量。
- **不实现 session 交互式摆渡的执行逻辑**：stdin/stdout 文件摆渡、pty 注入、关闭回收属于远期工作，shared 只定义 SessionTask 类型骨架。
- **不引入运行时校验库**（如 zod、io-ts）：JSON 反序列化校验由消费侧 package 按需实现，shared 只提供 TypeScript 类型，不绑定具体校验框架。

## 验收标准

- AC1: 任务主结构体包含架构文档「2.3」列出的全部字段（task_id、batch_id、depends_on、cmd、timeout_sec、submit_time、start_time、end_time、stdout、stderr、stdout_size、stderr_size、truncated、stdout_overflow_path、stderr_overflow_path、max_inline_bytes、exit_code、error_msg、status、worker_pid、policy_blocked），每个字段的类型与文档描述一致。
- AC2: 任务状态枚举包含 pending、processing、completed、failed、cancelled 五个成员；终态集合为 {completed, failed, cancelled}；终态判定函数对这三种返回 true，对 pending/processing 返回 false。
- AC3: 错误码枚举至少覆盖：策略拦截、超时、SSH 连接失败、设备离线、Worker 离线、重复提交、孤儿结果、大输出读取失败、未知错误，每项有简短描述。
- AC4: 错误码归类函数能正确区分「可重试」（如设备离线、Worker 离线、超时）与「不可重试」（如策略拦截、孤儿结果、未知错误）两类。
- AC5: 批量任务类型约束 depends_on 列表中每个元素为合法任务标识，禁止自依赖（depends_on 不得包含自身 task_id），禁止循环依赖（类型层能用泛型或运行时纯函数表达该校验意图）。
- AC6: SessionTask 类型包含会话标识、会话状态、stdin/stdout 摆渡目录约定、关闭标记字段，且能与单命令任务通过判别字段区分。
- AC7: 队列目录常量覆盖架构文档「2.1」的全部目录名（pending、processing、completed、failed、cancelled、outputs、policy）及 heartbeat.json 文件名；运行参数常量覆盖轮询退避三参数、大输出阈值、心跳过期阈值、结果保留时长、内网默认最大等待时长。
- AC8: 状态流转合法性校验函数能判定 pending→processing、processing→completed/failed/cancelled 为合法流转，而 processing→pending、completed→任意 等逆向流转为非法。
- AC9: shared 包被 import 后不产生任何控制台输出、不读写文件、不发起网络请求（验证方式：写一个仅 import shared 的脚本，运行后观察无副作用）。
- AC10: shared 包 `tsc --noEmit` 编译通过，无 `any` 类型逃逸，无未使用变量告警（与 tsconfig.base.json 的 strict 配置对齐）。
- AC11: shared 包的 `package.json` 不含任何 `dependencies`（运行时第三方依赖为零），仅允许 devDependencies 中的 TypeScript 与 @types/node。
