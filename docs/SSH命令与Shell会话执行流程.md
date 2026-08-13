<!-- more -->

## 一、 概述

本文档详细说明 MsgFerry 外网 Worker 中 **SSH command（一次性命令）** 与 **Shell 会话（交互式会话）** 两条执行链路各自的命令执行流程与逻辑，是对 [架构文档](./msgferry-bridge-architecture.md) 中「1.2.1 SSH 传输连接复用机制」「1.2.2 SSH 交互式会话机制」两小节的展开与细化，时序图基于当前 Worker 最新代码逻辑重绘。

两条链路分别对应 Worker 配置 `exec_mode` 的两种取值：

- `command`（默认）：一次性命令，走 [SshExecExecutor](../packages/worker/src/executor/ssh-exec.ts)，在 SSH **exec 通道**上执行一条命令，跑完即走。
- `shell`：交互式会话，走 [SessionManager](../packages/worker/src/session/index.ts) + [SshSessionFactory](../packages/worker/src/executor/ssh-session.ts)，在 SSH **shell 通道 + pty** 上做 stdin/stdout 双向文件摆渡，适合低频交互。

### 1. 核心差异总览

| 维度 | SSH command（exec_mode=command） | Shell 会话（exec_mode=shell） |
| --- | --- | --- |
| 执行器 | [SshExecExecutor](../packages/worker/src/executor/ssh-exec.ts) | [SessionManager](../packages/worker/src/session/index.ts) |
| SSH 通道 | `client.exec(cmd)` 一次性 exec 通道 | `client.shell()` 长生命周期 shell 通道 + pty |
| 生命周期 | 短：单条命令，跑完即走 | 长：会话持续存在，轮询注入/回读 |
| 连接复用 | 按设备缓存传输连接（`SshClientCache`） | 每会话独立建连，由工厂管理 |
| 命令状态 | 全新子进程，环境变量不保留 | 会话内可累积状态（交互式） |
| 输入输出 | 一次性收集 stdout/stderr/exit_code | 文件摆渡：`stdin/*.input`、`stdout/*.output` |
| 关闭方式 | channel 随命令结束自动关闭 | `close.marker` / 空闲超时 / 远端关闭 三路 |
| 典型场景 | 单条巡检/操作命令 | 需保持状态的交互式调试（低频） |

### 2. 涉及的核心文件

- [ssh-exec.ts](../packages/worker/src/executor/ssh-exec.ts)：一次性命令执行器
- [ssh-conn.ts](../packages/worker/src/executor/ssh-conn.ts)：公共连接层（`connectClient` / `SshClientCache`）
- [ssh-session.ts](../packages/worker/src/executor/ssh-session.ts)：交互式 shell 会话与工厂
- [session/index.ts](../packages/worker/src/session/index.ts)：交互式会话管理器（stdin/stdout 摆渡）
- [config/index.ts](../packages/worker/src/config/index.ts)：`ExecMode` 类型与配置解析
- [config/device.ts](../packages/worker/src/config/device.ts)：`findSshConfig` 设备配置查找

## 二、 SSH command 一次性命令执行流程

该链路由 `exec_mode=command`（默认）触发，核心是「**复用的门（传输连接），不是屋子里的人（每次命令都是全新进程）**」。全部逻辑收敛在 [SshExecExecutor](../packages/worker/src/executor/ssh-exec.ts) 与公共连接层 [ssh-conn.ts](../packages/worker/src/executor/ssh-conn.ts)。

![SSH command 执行时序](./SSH命令与Shell会话执行流程/img/ssh-command-execution-sequence.svg)

### 1. 命令入口与设备归一化

#### 1.1 execute() 入口

```ts
// packages/worker/src/executor/ssh-exec.ts
async execute(cmd: string, timeout_sec: number, device?: string): Promise<CmdResult> {
  const session = await this.getOrCreateSession(device);
  logger.info(`[executor:ssh-exec] execute on ${session.sessionId} (device=${session.device}): ${cmd}`);
  return this.runCommand(session.client, session.sessionId, cmd, timeout_sec);
}
```

【**函数作用**】

按设备名取或建 SSH 会话，然后在已建立的连接上执行一条命令。

【**参数含义**】

- `cmd`：待执行 SSH 命令
- `timeout_sec`：命令执行超时秒数
- `device`：目标设备名（可选，未指定走默认设备）

【**返回值**】

返回 `CmdResult`，包含 `stdout`、`stderr`、`exit_code`、`timed_out`。

#### 1.2 设备归一化

设备名未指定或为空串时统一为 `default`：

```ts
// packages/worker/src/executor/ssh-exec.ts
private normalizeDevice(device?: string): string {
  return device && device.trim() !== '' ? device : 'default';
}
```

### 2. 配置查找与连接取建

#### 2.1 getOrCreateSession() 取会话

```ts
// packages/worker/src/executor/ssh-exec.ts
private async getOrCreateSession(device?: string) {
  const normalized = this.normalizeDevice(device);
  // 查 SSH 配置：显式设备名 → default → 旧 ssh 字段
  const sshConfig = findSshConfig(this.config, normalized === 'default' ? undefined : normalized);
  if (!sshConfig) {
    throw new Error(`no ssh config for device "${normalized}"`);
  }
  return this.cache.getOrCreate(normalized, sshConfig, connectClient);
}
```

`findSshConfig` 的查找顺序（见 [config/device.ts](../packages/worker/src/config/device.ts)）：

```ts
// packages/worker/src/config/device.ts
export function findSshConfig(
  config: { devices: DeviceSshMap; ssh_config: SshConfig | null },
  deviceName?: string,
): SshConfig | undefined {
  if (deviceName && isValidDeviceName(deviceName) && config.devices[deviceName]) {
    return config.devices[deviceName];
  }
  return config.devices.default ?? config.ssh_config ?? undefined;
}
```

【**参数含义**】

- 优先 `devices[设备名]`（命名设备）
- 其次 `devices.default`（默认设备）
- 最后 `ssh_config`（旧字段兼容）

#### 2.2 SshClientCache 连接缓存

[SshClientCache](../packages/worker/src/executor/ssh-conn.ts) 是 command 侧连接缓存，核心能力：

- **按设备缓存 Client**：命中直接复用，避免每条命令重新握手。
- **连接级失效检测**：给缓存 Client 挂 `close` / `error` 监听，失效立即驱逐。
- **惰性重连**：未命中缓存自动走新建连接路径。
- **建连去重**：同一设备并发建连时复用 in-flight Promise，避免重复握手。

```ts
// packages/worker/src/executor/ssh-conn.ts
async getOrCreate(device, sshConfig, connectFn) {
  const existing = this.sessions.get(device);
  if (existing) return existing;          // 命中缓存直接复用
  const inFlight = this.opening.get(device);
  if (inFlight) return inFlight;          // 复用 in-flight 建连 Promise
  const p = this.open(device, sshConfig, connectFn)
    .finally(() => { this.opening.delete(device); });
  this.opening.set(device, p);
  return p;
}
```

### 3. 建连逻辑 connectClient()

[connectClient](../packages/worker/src/executor/ssh-conn.ts) 统一收敛 command 与 shell 两份建连逻辑：

- **认证**：私钥优先（`privateKey` + password 作 `passphrase`），其次纯密码，两者皆无报错。
- **超时兜底**：`readyTimeout` 为连接超时（默认 10s），另加 `TIMEOUT_GRACE_MS=5s` 兜底强制断连。
- **keepalive**：`KEEPALIVE_INTERVAL_MS=15s`，仅维持连接，不用于发现设备离线。

```ts
// packages/worker/src/executor/ssh-conn.ts
export const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const KEEPALIVE_INTERVAL_MS = 15000;
const TIMEOUT_GRACE_MS = 5000;
```

握手成功后缓存入 map 并生成会话 id `ssh_N`，挂失效检测监听：

```ts
// packages/worker/src/executor/ssh-conn.ts
const sessionId = `ssh_${++this.sessionCounter}`;
// ... connectClient 握手 ...
this.sessions.set(device, session);
const evict = () => {
  if (this.sessions.get(device) === session) {
    this.sessions.delete(device);   // 失效驱逐
  }
};
client.once('close', evict);
client.once('error', evict);
```

### 4. exec 命令执行 runCommand()

```ts
// packages/worker/src/executor/ssh-exec.ts
client.exec(cmd, (err, s) => {
  // ...
  s.on('data', (chunk) => { stdout += chunk.toString('utf-8'); });
  s.stderr.on('data', (chunk) => { stderr += chunk.toString('utf-8'); });
  s.on('exit', (code) => { exitCode = code; });   // 仅记录退出码
  s.on('close', () => { resolve({ stdout, stderr, exit_code: exitCode, timed_out: false }); });
  // 超时兜底 resolve timed_out=true
});
```

【**执行要点**】

- 在**已握手连接**上 `client.exec(cmd)` 开一个全新 exec channel，远端 `sh -c cmd` 起全新子进程。
- 分别累积 stdout / stderr，`exit` 事件仅记录退出码，最终以 `close` 事件交付结果。
- 超时（`timeout_sec`）直接回退 `timed_out=true`，channel 由 ssh2 在 close 事件后回收。
- 命令结束 channel 关闭、远端进程销毁、环境变量不保留——命令间本就无状态，状态由上层编排管理。

### 5. 连接复用与失效重连

- **复用**：同一设备后续命令命中 `SshClientCache`，零握手直接 `client.exec()`，省掉 TCP 握手 + KEX + 认证固定开销。
- **失效驱逐**：设备重启 / 网络断开 / 连接超时时，client 触发 `close` / `error`，缓存自动 `evict()`。
- **惰性重连**：下次 `execute` 未命中缓存 → 自动走建连路径重新握手。

### 6. 多设备独立缓存与全局关闭

- **按设备独立缓存**：`ssh_1`（设备 A）、`ssh_2`（设备 B）并存，互不干扰、各自复用。
- **全局关闭**：Worker 优雅退出时调用 `close()` → `cache.closeAll()` 全量关闭所有已建连接。

```ts
// packages/worker/src/executor/ssh-conn.ts
async closeAll(): Promise<void> {
  const closes: Promise<void>[] = [];
  for (const [, session] of this.sessions) {
    closes.push(closeClient(session.client));
  }
  this.sessions.clear();
  await Promise.all(closes);
}
```

## 三、 Shell 交互式会话执行流程

该链路由 `exec_mode=shell` 触发，核心是**长生命周期 stdin/stdout 文件摆渡**：Worker 为每个 running 会话建立 shell channel + pty，通过固定会话目录做双向文件交换。受 HGFS 轮询延迟限制，仅适合低频交互，不适合 vim 等全屏 TUI。

![SSH shell 会话执行时序](./SSH命令与Shell会话执行流程/img/ssh-shell-session-sequence.svg)

会话目录约定（`<hgfs_root>/sessions/<session_id>/`）：

- `session.json`：会话元信息（`SessionTask`，status=running）
- `stdin/`：内网写入的输入文件（`<seq>.input`），Worker 轮询读取后注入 shell
- `stdout/`：Worker 回写的输出文件（`<seq>.output`），供内网轮询读取
- `close.marker`：内网写入的关闭标记，触发会话关闭

### 0. 原始会话日志（SSH shell 会话原始日志）

除业务摆渡目录（`sessions/`）外，Worker 还会在 **`LOG_SAVE` 开启**时，为每个 SSH shell 会话写一份**原始输入输出合并日志**，目录与命名约定如下：

```
<hgfs_root>/logs/ssh-shell/<deviceName>/ssh_<id>_<YYYY-MM-DD_HHMMSS>.log
```

- **目录**：`<hgfs_root>/logs/ssh-shell/<deviceName>/`（设备名 normalize 后，如 `default`、`board-100`）。
- **文件名**：`ssh_<id>_<fileTimestamp()>.log`，其中 `<id>` 为会话号（即 `sessionId` 的 `ssh_` 后部分，如 `ssh_1` → `ssh_1_2026-08-11_231426.log`）。
- **开关**：复用 `LOG_SAVE` 环境变量（与业务日志一致），无需单独命令行开关；`LOG_SAVE` 未开启时该日志不落盘。
- **写入时机**：会话 `open()` 时初始化 FileLogger（写入 BOM 头部），每次 stdout/stderr 数据到达时按行写入，会话 `close()` 时冲刷残留行缓冲并关闭。
- **日志格式**：与参考项目 embedded-mcp-toolkit 一致——首行为 `=~=~=~=~=~=~=~=~=~=~=~= Mcp Server log <北京时间> =~=~=~=~=~=~=~=~=~=~=~=`；每行 `[YYYY-MM-DD HH:mm:ss] <清洗后的原始行>`。pty 会把注入的命令回显进 stdout，因此**输入（命令）与输出天然合并在一份日志里**，无需单独分 stdin/stdout 目录。

相关实现：[FileLogger](../packages/shared/src/file-logger.ts)、[SshSession](../packages/worker/src/executor/ssh-session.ts)。

### 1. 打开会话 SessionManager.open()

```ts
// packages/worker/src/session/index.ts
async open(session: SessionTask): Promise<void> {
  const shell = await this.factory.open(session.device);
  this.factories.set(session.session_id, shell);
  this.stdoutSeq.set(session.session_id, session.stdout_seq ?? 0);
  this.lastActive.set(session.session_id, Date.now());
  // 订阅输出 → 落盘 stdout/<seq>.output
  shell.onStdout((chunk) => this.appendStdout(session, chunk));
  shell.onStderr((chunk) => this.appendStdout(session, chunk, true));
  shell.onClose(() => this.finalize(session, SessionStatus.Closed, 'remote_closed'));
  // 注入初始命令（若存在）
  if (session.cmd && session.cmd.trim() !== '') {
    shell.write(session.cmd + '\n');
  }
}
```

#### 1.1 工厂建连与 shell 通道

[SshSessionFactory.open()](../packages/worker/src/executor/ssh-session.ts)：

```ts
// packages/worker/src/executor/ssh-session.ts
const client = await connectClient(sshConfig, sessionId);   // 建连（复用 connectClient）
const stream = await this.openShellChannel(client, sessionId);
const session = new SshSession(sessionId, normalized, stream);
```

```ts
// packages/worker/src/executor/ssh-session.ts
client.shell({ term: 'xterm', cols: 120, rows: 40 }, (err, stream) => {
  // 打开 shell channel + pty
});
```

【**执行要点**】

- 走完整握手后 `client.shell()` 打开 shell channel + pty（`term: xterm`，默认 `cols: 120, rows: 40`）。
- 封装为 [SshSession](../packages/worker/src/executor/ssh-session.ts)，订阅 `onStdout` / `onStderr` / `onClose`。
- 注入初始命令 `shell.write(session.cmd + "\n")`。
- 与一次性命令执行器（`SshExecExecutor`）**解耦**，会话生命周期由调用方 `SessionManager` 管理。

#### 1.2 输出落盘 appendStdout()

```ts
// packages/worker/src/session/index.ts
private appendStdout(session: SessionTask, chunk: string, stderr = false): void {
  const seq = this.stdoutSeq.get(session.session_id) ?? 0;
  void writeStdoutOutput(this.root, session.session_id, seq, chunk).then(() => {
    this.stdoutSeq.set(session.session_id, seq + 1);
  });
  this.lastActive.set(session.session_id, Date.now());
}
```

【**执行要点**】

- stdout 与 stderr 均并入同一 stdout 输出流（交互式 shell 场景 stderr 极少单独使用）。
- 通过 `writeStdoutOutput()` **原子写**（`.tmp` → `rename`）落盘，推进 `stdout_seq`。

### 2. stdin 注入（tick 轮询）

每轮 `tick(idleTimeoutMs)` 扫描所有 open 会话，按顺序处理：

```ts
// packages/worker/src/session/index.ts
// 1. 注入新 stdin 输入
const inputs = await listStdinInputs(this.root, id);
const shell = this.factories.get(id)!;
for (const seq of inputs) {
  const content = await readAndRemoveStdinInput(this.root, id, seq);
  shell.write(content);
  this.lastActive.set(id, Date.now());
}
```

【**执行要点**】

- `listStdinInputs()` 列出 `stdin/` 下 `*.input` 的序号（升序，过滤 `.tmp` 半成品）。
- `readAndRemoveStdinInput()` 读取并删除单个输入文件。
- `shell.write(content)` 注入 shell，并更新 `lastActive`（供空闲超时判定）。

### 3. stdout 回写

- shell 输出经 `onStdout` / `onStderr` 回调进入 `appendStdout()`。
- 原子写落盘到 `stdout/<seq>.output` 并推进序号。
- 内网侧轮询读取 `stdout/<seq>.output` 即可获得命令输出。

### 4. 关闭三路

三种关闭触发方式，均**先置终态再关 shell**：

```ts
// packages/worker/src/session/index.ts
// 2. 关闭标记检查
if (closeRequested) {
  await this.finalize(session, SessionStatus.Closed, 'close_marker');
  await this.closeShell(id);
}
// 3. 空闲超时检查
if (idleTimeoutMs > 0) {
  const last = this.lastActive.get(id) ?? 0;
  if (Date.now() - last > idleTimeoutMs) {
    await this.finalize(session, SessionStatus.Aborted, 'idle_timeout');
    await this.closeShell(id);
  }
}
```

| 触发方式 | 终态 | reason |
| --- | --- | --- |
| 内网写 `close.marker` | `closed` | `close_marker` |
| 空闲超时 `idle_timeout` | `aborted` | `idle_timeout` |
| 远端关闭（shell onClose） | `closed` | `remote_closed` |

#### 4.1 finalize() 幂等收尾

```ts
// packages/worker/src/session/index.ts
private finalize(session, status, reason): Promise<void> {
  const id = session.session_id;
  if (this.closing.has(id)) return Promise.resolve();  // 防并发重复 finalize
  this.closing.add(id);
  return this.enqueueWrite(id, async () => {
    session.status = status;
    session.end_time = Date.now();
    session.error_msg = reason;
    await writeSessionMeta(this.root, session);   // 原子写回 session.json
  }).finally(() => { this.closing.delete(id); });
}
```

【**要点**】

- `closing` 集合防止「close_marker / idle_timeout」与 shell onClose 的 `remote_closed` **并发覆盖**。
- `enqueueWrite` 用会话级写队列串行化元信息写，避免并发 `rename` 竞态。
- 关闭顺序：先置终态回写 `session.json`，再 `closeShell()` 关 channel、释放连接。

### 5. 全局关闭 closeAll()

Worker 优雅退出时：

```ts
// packages/worker/src/session/index.ts
async closeAll(): Promise<void> {
  const ids = [...this.factories.keys()];
  for (const id of ids) {
    const session = await readSessionMeta(this.root, id);
    if (session) await this.finalize(session, SessionStatus.Aborted, 'worker_shutdown');
    await this.closeShell(id);
  }
  await this.factory.closeAll();   // 关闭全部底层连接
}
```

## 四、 两种模式对比与选型建议

### 1. 连接复用策略对比

- **SSH command**：按设备缓存**传输连接**（`SshClientCache`），每次命令在其上开新 exec channel，channel 用完即销毁。
- **Shell 会话**：每个会话**独立建连**并常驻，由 `SshSessionFactory` 统一管理、`closeAll` 全量关闭。

### 2. 命令状态与并发

- **SSH command**：每条命令全新子进程、无状态，适合并发/批量单条命令。
- **Shell 会话**：会话内可累积状态，但同一 shell 通道需**串行**注入，不适合并发。

### 3. 选型建议

- 需要**无状态、高频、可并发**的单条巡检/操作 → `exec_mode=command`。
- 需要**保持状态、低频交互**的调试（且能接受 HGFS 轮询延迟）→ `exec_mode=shell`。
- 若目标设备不支持 exec 通道、仅支持交互式 shell（如部分 Dropbear / 受限登录 shell），可基于 shell 通道做**单命令执行**（见 [ssh-shell-exec.ts](../packages/worker/src/executor/ssh-shell-exec.ts)，注入 `echo <marker>:$?` 检测命令结束）。

## 五、 设备在线判断与重试流程

设备在线判断与重试是 Worker 连接层对"**连接失效**"与"**设备离线**"的区分处理，以及错误码对可重试性的归类，**command 与 shell 会话两条链路共用**。它并不显式维护一份"设备在线状态表"，而是通过**连接级失效检测 + 惰性重连**这套机制，把"连接短暂失效"从"设备真正离线"里剥离出来——只有重连也失败才升级为设备离线。核心逻辑收敛在公共连接层 [ssh-conn.ts](../packages/worker/src/executor/ssh-conn.ts) 与共享错误码 [errors.ts](../packages/shared/src/errors.ts)。

### 1. 在线判断的两个层次

设备"不在线"要区分两种语义，避免混为一谈：

| 类型 | 含义 | 设备真挂了吗？ | 主动重连的价值 |
| --- | --- | --- | --- |
| **连接级失效** | 缓存里的 ssh2 Client 断了（keepalive 失效 / 网络闪断 / 远端 sshd 重启 / 空闲超时） | **不一定**，设备可能活得好好的 | **很高**——本地缓存失效 ≠ 设备离线，重连大概率成功 |
| **设备级离线** | 设备真关机 / 断网 / 不可达 | 是 | 必然失败，重连只是确认 |

#### 1.1 连接级失效检测

`SshClientCache` 给缓存里的 Client 挂上 `close` / `error` 监听，一旦连接悄悄死掉，**立即从缓存驱逐**，避免后续命令仍拿着死连接去 `client.exec()` 报错：

```ts
// packages/worker/src/executor/ssh-conn.ts
const evict = () => {
  if (this.sessions.get(device) === session) {
    this.sessions.delete(device);   // 失效驱逐
  }
};
client.once('close', evict);
client.once('error', evict);
```

【**要点**】

- 监听对象是 **client（连接级）**，适用于 command 侧每条命令复用同一连接、通道自开自关的场景。
- shell 侧在**会话级** `onClose()` 驱逐（见三、4），因"一连接一通道"，会话失效连带连接失效，会话级驱逐即可覆盖。
- `evict` 用 `=== session` 校验，防止新连接已入缓存后旧连接的回调误删新条目。

#### 1.2 设备级离线判定

连接失效后被驱逐，下一次任务自动走新建连接路径（惰性重连）：

- **重连成功** → 设备实际在线，只是此前缓存失效，判定为在线。
- **重连失败**（`connectClient` 抛错，如连接超时、认证失败、host 不可达）→ 升级为**设备离线**。

因此设备级离线不是单独探测出来的，而是"连接失效 → 惰性重连失败"这一路径的最终结论。

### 2. 惰性重连与建连去重

#### 2.1 惰性重连

`getOrCreate` 未命中缓存（首次或已驱逐）时自动发起建连，命令本身就是触达，无需额外的前置探测动作：

```ts
// packages/worker/src/executor/ssh-conn.ts
async getOrCreate(device, sshConfig, connectFn) {
  const existing = this.sessions.get(device);
  if (existing) return existing;          // 命中缓存直接复用
  const inFlight = this.opening.get(device);
  if (inFlight) return inFlight;          // 复用 in-flight 建连 Promise
  const p = this.open(device, sshConfig, connectFn)
    .finally(() => { this.opening.delete(device); });
  this.opening.set(device, p);
  return p;
}
```

【**要点**】

- **缓存命中**：直接复用已握手连接，零握手开销。
- **缓存未命中**：走建连路径，成功后重新入缓存并挂失效检测监听。
- 惰性重连与"没缓存就 new Client"的路径完全同构，代码最干净，无需额外的前置 probe。

#### 2.2 建连去重

同一设备并发建连时，`opening` Map 保存 in-flight Promise，后续请求**复用同一个 Promise**，避免并发场景下重复握手：

```ts
// packages/worker/src/executor/ssh-conn.ts
const inFlight = this.opening.get(device);
if (inFlight) return inFlight;          // 复用 in-flight 建连 Promise
const p = this.open(device, sshConfig, connectFn).finally(() => {
  this.opening.delete(device);          // 建连结束（成功或失败）即清除，允许下次重试
});
this.opening.set(device, p);
```

【**要点**】

- 建连**成功或失败**都会在 `finally` 里清除 in-flight 记录，保证失败后下次可重新建连。
- 该思路与 shell 侧 `opening` Map（按设备串行建连去重）对齐，只是 command 侧按设备复用。

### 3. 错误码与可重试归类

#### 3.1 错误码语义

`errors.ts` 中与设备在线相关的两个错误码，语义必须区分清楚：

| 错误码 | 含义 | 适用场景 |
| --- | --- | --- |
| `DeviceOffline` | 设备离线 / 不可达 | **连接建立失败**（含主动重连后仍失败） |
| `SshConnectionFailed` | SSH 连接失败 | 连接已建立、但命令通道 / 执行失败，或一般连接失败 |

```ts
// packages/shared/src/errors.ts
export const ErrorCode = {
  // ...
  SshConnectionFailed: 'ssh_connection_failed',
  DeviceOffline: 'device_offline',
  // ...
} as const;
```

【**要点**】

- **连接建立失败（含重连失败）→ `DeviceOffline`**：设备真离线或不可达。
- **连接已建立、但命令通道 / 执行失败 → 其他错误（如 `SshConnectionFailed`）**：不该误标成设备离线。
- 这样区分能避免"网络闪断"被误判为"设备永久离线"，为上层重试留出正确依据。

#### 3.2 RETRYABLE_ERROR_CODES

`DeviceOffline`、`SshConnectionFailed` 与超时、同步失败等同属**可重试错误码**，上层据此决定是否重试：

```ts
// packages/shared/src/errors.ts
export const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ErrorCode.DeviceOffline,
  ErrorCode.WorkerOffline,
  ErrorCode.ExecutionTimeout,
  ErrorCode.SshConnectionFailed,
  ErrorCode.SyncFailed,
]);
```

对应地，[isRetryableErrorCode()](../packages/shared/src/utils.ts) 提供判断函数：

```ts
// packages/shared/src/utils.ts
export function isRetryableErrorCode(code: ErrorCode): boolean {
  return RETRYABLE_ERROR_CODES.has(code);
}
```

【**要点**】

- `WorkerOffline`（Worker 心跳过期）与 `DeviceOffline`（设备离线）是两个不同对象，均属可重试。
- `ExecutionTimeout` / `SyncFailed` 等环境性故障也归入可重试，与 `BlockedByPolicy` 等确定性故障（不可重试）区分开。

### 4. 重试流程

#### 4.1 Worker 侧：不做 executor 内自旋重试

`SshExecExecutor` 在执行命令时**不做自身重试自旋**——连接失败直接抛错（调用方回写 failed 结果）。重试交由上层编排控制：

```ts
// packages/worker/src/executor/ssh-exec.ts
async execute(cmd: string, timeout_sec: number, device?: string): Promise<CmdResult> {
  const session = await this.getOrCreateSession(device);
  return this.runCommand(session.client, session.sessionId, cmd, timeout_sec);
}
```

【**要点**】

- 若 `getOrCreateSession` 建连失败，`execute` 直接抛错，不在此处 retry。
- 原因：`DeviceOffline` 等已在 `RETRYABLE_ERROR_CODES` 中，上层（MCP Server / AI 编排）可重试，executor 内自旋易放大故障时延、拖住 AI 编排。

#### 4.2 MCP Server 侧：上层重试依据

MCP Server 侧通过错误码判断是否重试：

```ts
// packages/mcp-server/src/tools/task/submit.ts
return {
  ...baseResult,
  error_code: ErrorCode.ExecutionTimeout,   // 超时等可重试错误
  error_msg: `timed out after ${config.max_wait_ms}ms`,
};
```

同时，内网侧对**同步命令**（`syncPush` / `syncPull`）已有退避重试（见 [sync.ts](../packages/mcp-server/src/sync.ts) 的 `runSyncCmd`）：

```ts
// packages/mcp-server/src/sync.ts
async function runSyncCmd(
  cmd: string,
  timeoutMs: number,
  retries: number,
  retryDelays: readonly number[],
): Promise<SyncRunResult> {
  let last: SyncRunResult | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await runOnce(cmd, timeoutMs);
    last = result;
    if (result.exit_code === 0) return result;
    if (attempt < retries) {
      const delay = retryDelays[attempt] ?? retryDelays[retryDelays.length - 1] ?? 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));   // 退避重试
    }
  }
  throw new Error(`sync command failed after ${retries + 1} attempts ...`);
}
```

【**要点**】

- 同步类命令在 MCP Server 内部做**退避重试**（`sync_retries` 次），保证文件摆渡的稳定性。
- 业务 SSH 命令则依赖 `RETRYABLE_ERROR_CODES` 判定，由上层按需重提，避免内网自旋阻塞。

### 5. 在线判断与重试整体时序

![设备在线判断与重试时序](./SSH命令与Shell会话执行流程/img/ssh-device-retry-sequence.svg)

设备在线判断与重试是 **command 与 shell 会话共用的连接层能力**——两条链路的重试语义完全一致（连接/会话失效检测 → 惰性重连 → 建连去重 → 失败判 `DeviceOffline` → 上层按可重试错误码重提），区别仅在失效检测粒度（command 监听 client、shell 监听会话通道）。因此只需**一张共用重试时序图**，下面以 command 链路为例展示完整流程：

1. 任务触发 `execute()` → `getOrCreateSession()`（command）/ `getOrOpenSession()`（shell）取会话。
2. **缓存命中**：连接/会话仍存活 → 直接执行命令，判定设备在线。
3. **缓存未命中 / 已失效**：走建连路径 → **重连成功**则判定在线、继续执行。
4. **重连失败**（连接超时 / 认证失败 / 不可达）→ 判 `DeviceOffline`，命令失败。
5. 上层收到 `DeviceOffline`（或 `SshConnectionFailed`）等**可重试错误码** → 按需重新提交任务。
6. 连接在存活期间因网络闪断 / sshd 重启触发 `close` / `error` → 缓存自动驱逐，回到第 3 步。

---
*本文档由 markdowncli 技能辅助生成*
