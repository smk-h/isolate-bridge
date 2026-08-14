<!-- more -->

## 一、 概述

本文档详细说明 MsgFerry 外网 Worker 中 **SSH command（一次性命令）** 与 **Shell 单命令**（shell 通道单命令执行）两条执行链路各自的命令执行流程与逻辑，是对 [架构文档](./msgferry-bridge-architecture.md) 中「1.2.1 SSH 传输连接复用机制」「1.2.2 SSH 交互式会话机制」两小节的展开与细化，时序图基于当前 Worker 最新代码逻辑重绘。

两条链路分别对应 Worker 配置 `exec_mode` 的两种取值：

- `command`（默认）：一次性命令，走 [SshExecExecutor](../packages/worker/src/executor/ssh-exec.ts)，在 SSH **exec 通道**上执行一条命令，跑完即走。
- `shell`：单命令执行，走 [SshShellExecExecutor](../packages/worker/src/executor/ssh-shell-exec.ts)，在 SSH **shell 通道 + pty** 上执行单条命令（以唯一 marker 检测命令结束），并同步落盘**原始会话日志**。

### 1. 核心差异总览

| 维度 | SSH command（exec_mode=command） | Shell 单命令（exec_mode=shell） |
| --- | --- | --- |
| 执行器 | [SshExecExecutor](../packages/worker/src/executor/ssh-exec.ts) | [SshShellExecExecutor](../packages/worker/src/executor/ssh-shell-exec.ts) |
| SSH 通道 | `client.exec(cmd)` 一次性 exec 通道 | `client.shell()` shell 通道 + pty |
| 生命周期 | 短：单条命令，跑完即走 | 短：单条命令，marker 判定结束 |
| 连接复用 | 按设备缓存传输连接（`SshClientCache`） | 按设备缓存 shell 会话（长连接复用） |
| 命令状态 | 全新子进程，环境变量不保留 | 会话内可累积状态（交互式） |
| 输入输出 | 一次性收集 stdout/stderr/exit_code | 收集 stdout/stderr + marker 退出码，同时落盘原始日志 |
| 关闭方式 | channel 随命令结束自动关闭 | 远端关闭 / 超时 / 主动 close |
| 典型场景 | 单条巡检/操作命令 | 设备不支持 exec 通道、需交互式 shell |

### 2. 涉及的核心文件

- [ssh-exec.ts](../packages/worker/src/executor/ssh-exec.ts)：一次性命令执行器
- [ssh-conn.ts](../packages/worker/src/executor/ssh-conn.ts)：公共连接层（`connectClient` / `SshClientCache`）
- [ssh-shell-exec.ts](../packages/worker/src/executor/ssh-shell-exec.ts)：shell 单命令执行器
- [ssh-session.ts](../packages/worker/src/executor/ssh-session.ts)：交互式 shell 会话与工厂（含原始日志）
- [file-logger.ts](../packages/shared/src/file-logger.ts)：原始会话日志落盘
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

## 三、 Shell 单命令执行流程与原始会话日志

该链路由 `exec_mode=shell` 触发，由 [SshShellExecExecutor](../packages/worker/src/executor/ssh-shell-exec.ts) 承担。它**不是**长生命周期会话管理，而是**短生命周期单命令执行**：在 SSH **shell 通道 + pty** 上注入一条命令，用唯一结束标记（`echo <marker>:$?`）检测命令结束并解析退出码，跑完即返回结果。

> **历史说明**：早期 `exec_mode=shell` 曾对应 `sessions/` 目录下的长会话 stdin/stdout 文件摆渡（`SessionManager`）。该机制因「会话创建」链路未落地、目录始终为空壳而**已下线**。当前 shell 模式只保留上面所述的**单命令执行 + 原始日志**，不再创建 `sessions/` 目录，也不再做任何 stdin/stdout 文件摆渡。

> 时序图源码见 [ssh-shell-session-sequence.mmd](./SSH命令与Shell会话执行流程/ssh-shell-session-sequence.mmd)（描述当前 shell 单命令执行 + 原始日志流程，可用 mermaid 渲染为 SVG）。

### 0. 原始会话日志（SSH shell 会话原始日志）

Worker 会在 **`LOG_SAVE` 开启**时，为每个 SSH shell 会话写一份**原始输入输出合并日志**，目录与命名约定如下：

```
<hgfs_root>/logs/ssh-shell/<deviceName>/ssh_<id>_<YYYY-MM-DD_HHMMSS>.log
```

- **目录**：`<hgfs_root>/logs/ssh-shell/<deviceName>/`（设备名 normalize 后，如 `default`、`board-100`）。
- **文件名**：`ssh_<id>_<fileTimestamp()>.log`，其中 `<id>` 为会话号（即 `sessionId` 的 `ssh_` 后部分，如 `ssh_1` → `ssh_1_2026-08-11_231426.log`）。
- **开关**：复用 `LOG_SAVE` 环境变量（与业务日志一致），无需单独命令行开关；`LOG_SAVE` 未开启时该日志不落盘。
- **写入时机**：会话 `open()` 时初始化 FileLogger（写入 BOM 头部），每次 stdout/stderr 数据到达时按行写入，会话 `close()` 时冲刷残留行缓冲并关闭。
- **日志格式**：与参考项目 embedded-mcp-toolkit 一致——首行为 `=~=~=~=~=~=~=~=~=~=~=~= Mcp Server log <北京时间> =~=~=~=~=~=~=~=~=~=~=~=`；每行 `[YYYY-MM-DD HH:mm:ss] <清洗后的原始行>`。pty 会把注入的命令回显进 stdout，因此**输入（命令）与输出天然合并在一份日志里**，无需单独分 stdin/stdout 目录。

相关实现：[FileLogger](../packages/shared/src/file-logger.ts)、[SshSession](../packages/worker/src/executor/ssh-session.ts)。

### 1. 会话工厂建连与 shell 通道

[SshShellExecExecutor](../packages/worker/src/executor/ssh-shell-exec.ts) 持有 `ShellSessionFactory`（经 [createShellSessionFactory](../packages/worker/src/executor/factory.ts) 选择 ssh2 / mock 实现），首次用到某设备时按需建连打开 shell 通道：

```ts
// packages/worker/src/executor/ssh-session.ts（SshSessionFactory.open）
const client = await connectClient(sshConfig, sessionId);   // 建连（复用 connectClient）
const stream = await this.openShellChannel(client, sessionId);
const session = new SshSession(sessionId, normalized, stream, logRoot);
```

```ts
// packages/worker/src/executor/ssh-session.ts
client.shell({ term: 'xterm', cols: 120, rows: 40 }, (err, stream) => {
  // 打开 shell channel + pty
});
```

【**执行要点**】

- 走完整握手后 `client.shell()` 打开 shell channel + pty（`term: xterm`，默认 `cols: 120, rows: 40`）。
- 封装为 [SshSession](../packages/worker/src/executor/ssh-session.ts)，在 `stream.on('data')` / `stream.stderr.on('data')` 中**同步写原始日志**（FileLogger）。
- 会话 `open()` 时若 `LOG_SAVE` 开启，即初始化 FileLogger 并写入 BOM 头部。
- `SshShellExecExecutor` 按设备**缓存 shell 会话**（长连接复用），远端关闭时自动从缓存驱逐，下次任务重连。

### 2. 单命令执行 execute()

```ts
// packages/worker/src/executor/ssh-shell-exec.ts
async execute(cmd: string, timeout_sec: number, device?: string): Promise<CmdResult> {
  const session = await this.getOrOpenSession(device);
  return this.enqueue(normalized, () => {
    return new Promise<CmdResult>((resolve) => {
      // 唯一结束标记：随机后缀避免与命令输出中的文本冲突
      const marker = `__MSG_DONE_${Math.random().toString(36).slice(2, 10)}`;
      const markerRe = new RegExp(`${marker}:(\\d+)`);
      const onStdout = (chunk) => {
        stdout += chunk;
        const m = stdout.match(markerRe);
        if (!m) return;
        stdout = stripMarkerLines(stdout, marker);   // 剥离 marker 相关行
        finish({ stdout, stderr, exit_code: Number(m[1]), timed_out: false });
      };
      session.onStdout(onStdout);
      session.onStderr(onStderr);
      session.onClose(onClose);
      session.write(`${cmd}\n`);          // 注入命令
      session.write(`echo ${marker}:$?\n`); // 注入结束标记回显退出码
    });
  });
}
```

【**执行要点**]

- 交互式 shell 执行完命令不会自动关闭通道，靠超时兜底会白等，因此在命令后注入唯一 `marker`（`echo <marker>:$?`），在 stdout 中匹配到 `marker:N` 即判定命令结束并解析退出码 `N`。
- 用 `stripMarkerLines()` 把含 marker 的回显行（注入命令回显 + pty 回显）剥离，避免污染返回给上层的结果。
- 按 device 串行化命令（`enqueue`）：同一设备上命令排队执行，避免并发写同一 shell 通道导致输出交错。
- 命令结束后**不关闭会话**，仅释放命令级回调，长连接复用；超时（`timeout_sec`）或会话提前关闭（远端退出）也会结束本次命令。

### 3. 原始日志落盘

原始日志随 `SshSession` 生命周期自动落盘，无需单独进程：

```ts
// packages/worker/src/executor/ssh-session.ts
stream.on('data', (chunk) => {
  const text = chunk.toString('utf-8');
  this.fileLogger.write(text);            // 逐行写入日志（时间戳 + 清洗）
  for (const cb of [...this.stdoutCbs]) cb(text);
});
// stderr 同理 → this.fileLogger.write(text)
```

- `FileLogger.write()` 做**行缓冲**：跨 chunk 的半行先缓存，凑成整行才落盘，保证「一行一个时间戳」。
- `sanitizeLine()` 剥离 ANSI 颜色、控制字符转 `[CSI]/[OSC]` 等可见标记，保证日志可读。
- 会话 `close()` 时 `fileLogger.disable()` 冲刷残留行缓冲并关闭文件流。

### 4. 关闭与全局回收

- **单会话关闭**：`SshSession.close()` 冲刷 FileLogger 残留并 `stream.end()` 关闭 shell 通道，1s 兜底强制结束。
- **远端关闭**：`stream.on('close')` 触发，`SshShellExecExecutor` 会从设备缓存中驱逐该会话，下次任务自动重连。
- **全局回收**：Worker 优雅退出时 `SshShellExecExecutor.close()` / `SshSessionFactory.closeAll()` 关闭全部缓存会话与底层连接。

## 四、 两种模式对比与选型建议

### 1. 连接复用策略对比

- **SSH command**：按设备缓存**传输连接**（`SshClientCache`），每次命令在其上开新 exec channel，channel 用完即销毁。
- **Shell 单命令**：按设备缓存**交互式 shell 会话**（`SshShellExecExecutor`），同一设备后续命令复用已建会话，远端关闭时自动驱逐重建。

### 2. 命令状态与并发

- **SSH command**：每条命令全新子进程、无状态，适合并发/批量单条命令。
- **Shell 单命令**：会话内可累积状态，但同一 shell 通道需**串行**执行（`SshShellExecExecutor` 按设备串行化命令队列），不适合并发。

### 3. 选型建议

- 需要**无状态、高频、可并发**的单条巡检/操作 → `exec_mode=command`。
- 目标设备不支持 exec 通道、仅支持交互式 shell（如部分 Dropbear / 受限登录 shell）→ `exec_mode=shell`，基于 shell 通道做**单命令执行**（见 [ssh-shell-exec.ts](../packages/worker/src/executor/ssh-shell-exec.ts)，注入 `echo <marker>:$?` 检测命令结束），并同步落盘**原始会话日志**。

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
