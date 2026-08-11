<!-- more -->

## 一、 问题概述

本次排查围绕 MsgFerry 摆渡桥内网（Ubuntu 虚拟机内 MCP Server）与外网（Windows 宿主机 Worker）两端联调时暴露的两个问题：

- MCP Server 环境变量 `$HOME` 未展开，业务日志落入字面 `$HOME` 目录；
- Worker 配置文件修改晚于进程启动，exchange 模式未生效。

两个问题叠加，最终表现为外网侧所有命令执行失败/超时、任务文件未写入交换服务器对应目录。

## 二、 问题一：MCP Server 环境变量 `$HOME` 未展开

### 1. 现象

- 日志文件出现在非预期位置：`/home/sumu/workspace/msgferry/msgferry-mcp-server/$HOME/.msgferry/vm_share/logs/mcp-server/2026-08-11_225920.log`，即 MCP Server 工作目录下出现了**字面 `$HOME`** 目录。
- 日志文件头打印的路径却是正确展开的：
  - `MCP server local_root: /home/sumu/.msgferry/vm_share`
  - `MCP server log_dir: /home/sumu/.msgferry/vm_share/logs/mcp-server`
- 即「打印正确、落盘错误」，二者不一致。

### 2. 原因

`$HOME` 的展开逻辑 `expandHomeDir()` 只用于业务配置解析，日志模块绕过了它：

1. [`parseConfig()`](../packages/mcp-server/src/config.ts#L111) 对 `MSGFERRY_LOCAL_ROOT` 调用 `expandHomeDir()`，得到正确展开的 `config.local_root`；[`main.ts`](../packages/mcp-server/src/main.ts#L41-L42) 打印日志头时使用该展开值，因此打印正确。
2. [`Logger.ensureInit()`](../packages/shared/src/logger.ts#L48-L52) 不走 `parseConfig`，直接读取**未展开**的 `process.env.MSGFERRY_LOCAL_ROOT`（字面 `$HOME/.msgferry/vm_share`）传给 `resolveLogDir()`。
3. [`resolveLogDir()`](../packages/shared/src/log-config.ts#L54) 执行 `join(localRoot, 'logs/mcp-server')`：当首段为相对路径时 `join()` 不会转成绝对路径，返回 `$HOME/.msgferry/vm_share/logs/mcp-server`；随后 `mkdirSync()` 基于 `process.cwd()`（`msgferry-mcp-server/`）创建目录，于是出现字面 `$HOME` 目录。

代码证据：

```ts
// packages/shared/src/logger.ts
const dir = resolveLogDir({
  localRoot: process.env.MSGFERRY_LOCAL_ROOT,   // 未展开，字面 "$HOME/..."
  logDir: process.env.LOG_DIR,
  defaultRel: this.defaultRel,
});
```

```ts
// packages/shared/src/log-config.ts
return join(localRoot ?? '.', rel);             // 相对路径拼接，基于 cwd 落盘
```

### 3. 解决方案

- 源码修复：将 `expandHomeDir()` 下沉至 `@smai-kit/msgferry-shared` 包，在 `resolveLogDir()` 拼接前先展开 `localRoot`，使 Logger 与 `parseConfig()` 共用同一套展开逻辑。
- 重新构建 dist 产物（`pnpm build`，`index.mjs` 为 rollup bundle）并部署到虚拟机。
- 清理远端残留的字面 `$HOME` 目录。

## 三、 问题二：Worker exchange 模式未生效

### 1. 现象

- 共享根 `/mnt/hgfs/sharedir/vm_share`（宿主机 `E:\MyLinux\VMware\sharedir\vm_share`）为 shared 布局：`pending/processing/completed/failed/outputs` 及根级 `heartbeat.json`，**不存在 `inbound/`、`outbound/`**。
- 心跳由 `node.exe`（pid 26080）持续写入共享根 `heartbeat.json`（shared 行为），而非 `inbound/heartbeat.json`（exchange 行为）。
- 已把 `config/worker.yaml` 改为 `queue_mode: exchange`，但运行中的 Worker 仍为 shared 模式。

### 2. 原因

- Worker 仅在**进程启动时**读取一次 `config/worker.yaml`：[`main.ts`](../packages/worker/src/main.ts#L161) 调用一次 `parseConfig()`，[`config.ts`](../packages/worker/src/config.ts#L184) 用 `readYamlConfigFile()` 读取。配置文件没有热加载（只有 `policy.json` 有 watcher）。
- 时间线：
  - 22:57:53 Worker（node.exe pid 26080）启动，此时已按默认值 `shared` 解析完成；
  - 22:58:23 `config/worker.yaml` 才被改为 `exchange`，晚于启动约 30 秒，进程内 `config.queue_mode` 已固化。
- 联动影响（与问题一叠加）：MCP 侧 exchange 模式期望服务器根存在 `inbound/`、`outbound/`，`sync-mock -g inbound` 目标目录不存在 → 退出码 2 → 心跳检查失败 → 任务未写入 `outbound/`。

### 3. 解决方案

- 立即生效：重启 Worker，让新配置重新解析。

  ```powershell
  node .\dist\msgferry-worker\index.mjs --hgfs-root E:\MyLinux\VMware\sharedir\vm_share
  ```

- 根治建议（三选一）：
  - 方案 A（推荐）：Worker 内置配置变更检测 + 优雅自重启，覆盖所有启动方式，保存配置即生效；
  - 方案 B：pm2 守护 + 配置文件 `--watch` 自动重启；
  - 方案 C：将 `queue_mode` 作为 CLI 参数（如 `--queue-mode exchange`）并移除配置文件中的 `queue_mode` 字段，避免双事实来源静默分叉。

---
*本文档由 markdowncli 技能辅助生成*
