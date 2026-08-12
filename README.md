## 一、 项目简介

### 1. 简介

MsgFerry 是一个面向**隔离网络环境**的 AI 设备指令摆渡桥，解决「内网 AI 代理无法直连外网设备执行 SSH 命令」的工程问题。核心思路是把「思考层」收敛在内网、「执行层」剥离到外网，通过文件系统层的文件队列完成跨域通信。

- **内网 MCP Server**（`msgferry-mcp-server`）：由 Claude Code / opencode 拉起，负责任务投递、结果回读、心跳检测，是内网侧的**唯一智能出入口**。
- **外网 Node Worker**（`msgferry-worker`）：常驻后台的纯任务消费者，无模型、无推理，仅承担 SSH 命令执行、超时控制、结果回写。
- **唯一跨域介质**：VMware HGFS 共享文件夹（文件系统层通信，不走网卡协议栈），两侧进程都只能通过它读写，不打通任何 TCP 网络。

MsgFerry 支持两种队列模式：

| 模式 | 说明 | 适用场景 |
| --- | --- | --- |
| `shared`（共享目录） | MCP 与 Worker 直接读写**同一个**共享目录，免同步，近实时 | 支持 HGFS 共享文件夹的环境 |
| `exchange`（文件交换服务器） | 通过一台**文件交换服务器**（`file_transfer` 等，测试用 `sync-mock` 模拟）完成单向信箱摆渡 | 隔离更严格、**不支持共享目录**的环境 |

### 2. 环境要求

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | ≥ 20.0.0（见根 `package.json` 的 `engines` 字段） | 运行 MCP Server / Worker |
| pnpm | 较新版本即可 | Monorepo 包管理器，workspace 依赖解析 |

### 3. 依赖安装

在项目根目录执行（`pnpm-workspace.yaml` 已声明 `allowBuilds` / `onlyBuiltDependencies`，会为 `ssh2`、`cpu-features`、`esbuild` 等自动执行构建脚本）：

```bash
pnpm install
```

### 4. 怎么编译

构建产物只需一条命令：

```bash
pnpm build
```

`build/index.ts` 内部流程：

（1）**清理** `dist/` 旧产物；

（2）**Bundle**：Rollup + esbuild 把 `packages/*/src/index.ts` 打成单文件 ESM（`index.mjs`），workspace 依赖（`@smai-kit/*`）源码直接内联；`ssh2`、`cpu-features`、`@modelcontextprotocol/server` 保持 external；

（3）**Pack**：依据各子包 `.npmignore` 白名单清单拷贝分发文件，并从 pnpm `.pnpm` store 解引用拷贝 external 依赖的 `node_modules`（离线解压即用）；

（4）**Tarball**：对每个成果物生成 `dist/<产物名>.tar.gz`。

> 子包 `src/` 与 `test/` 不进产物（已被 bundle 成 `index.mjs`），新增分发文件只需改对应子包的 `.npmignore`，无需改动 build。

### 5. 成果物说明

`pnpm build` 后 `dist/` 目录产出如下：

| 成果物 | 内容 | 部署侧 |
| --- | --- | --- |
| `dist/msgferry-mcp-server/` | `index.mjs`、`.mcp.json`、`.claude/settings.local.json`、`.opencode/opencode.json`、`scripts/sync-mock.mjs`、`node_modules/`、`package.json` | Ubuntu 内网 |
| `dist/msgferry-mcp-server.tar.gz` | 同上压缩包 | |
| `dist/msgferry-worker/` | `index.mjs`、`config.example.yaml`、`policy.example.json`、`node_modules/`、`package.json` | Windows 外网 |
| `dist/msgferry-worker.tar.gz` | 同上压缩包 | |

- 两个成果物均为 **解压即用**（`node_modules` 已内置），可直接拷贝或解压到部署机。
- 自带 CLI 命令：MCP Server 为 `msgferry-mcp`（入口 `index.mjs`），Worker 为 `msgferry-worker`。
- Worker 的 `config.example.yaml` 需按部署场景改名为 `config/worker.yaml` 放到共享根目录下（见第二章）。

## 二、 怎么部署？

部署拓扑为「内网 Ubuntu 虚拟机 + 外网 Windows 物理机」，两侧通过 VMware HGFS 共享文件夹互通。以 `vm_share` 作为**共享根目录**（所有队列子目录、交换服务器目录都收进 `vm_share`，不裸在上级目录）。

### 1. 目录约定

| 目录 | 归属侧 | 操作系统 | 路径 |
| --- | --- | --- | --- |
| 共享根目录 | Worker 挂载 / 交换服务器根 | Windows | `E:\MyLinux\VMware\sharedir\vm_share` |
| 共享根目录 | MCP 直接读写（shared） | Ubuntu | `/mnt/hgfs/sharedir/vm_share` |
| MCP 内网本地镜像（exchange） | MCP 私有目录 | Ubuntu | `$HOME/.msgferry/vm_share` |

> `vm_share` 就是共享根目录本身，Worker 侧 `--hgfs-root` 与 MCP 侧 `MSGFERRY_LOCAL_ROOT` 都**必须指向 `vm_share` 这一级**，代码不会自动补拼。

### 2. Windows（外网）放什么？

- 部署**外网 Worker**：把构建产物 `dist/msgferry-worker/` 放到 Windows 目录（如 `E:\AI\isolate-bridge\dist\msgferry-worker`），包含 `index.mjs`、`config.example.yaml`、`policy.example.json`、`node_modules/`、`package.json`。
- Worker 启动时只需 `--hgfs-root` 指向共享根目录 `E:\MyLinux\VMware\sharedir\vm_share`，其余配置自动从共享目录下的 `config/worker.yaml` 读取。

### 3. Ubuntu（内网）放什么？

- 部署**内网 MCP Server**：把构建产物 `dist/msgferry-mcp-server/` 放到 Ubuntu 目录（如 `/home/sumu/workspace/msgferry/msgferry-mcp-server`），包含 `index.mjs`、`.mcp.json`、`.claude/settings.local.json`、`.opencode/opencode.json`、`node_modules/`、`package.json`。
- 同时放入 **`sync-mock.mjs`**（交换服务器模拟工具，来自 `scripts/sync-mock.mjs`），供 exchange 模式调用。
- 在 `.mcp.json` 中按模式配置环境变量（见第三章），Claude Code / opencode 会按此拉起 MCP Server。

## 三、 配置与启动

### 1. shared 模式（共享目录，免同步）

shared 模式的核心判据是：**MCP 侧不配置任何 `MSGFERRY_SYNC_*` 命令**。MCP 与 Worker 直接读写同一个 `vm_share` 共享目录，零同步开销。

#### 1.1 mcp server

在 `msgferry-mcp-server/.mcp.json` 的 `env` 中配置：

```json
{
  "mcpServers": {
    "msgferry-bridge": {
      "command": "node",
      "args": ["./index.mjs"],
      "env": {
        "MSGFERRY_LOCAL_ROOT": "/mnt/hgfs/sharedir/vm_share",
        "MSGFERRY_MAX_WAIT_MS": "30000",
        "MSGFERRY_POLLING_INITIAL": "500",
        "MSGFERRY_POLLING_MAX": "3000",
        "LOG_SAVE": "1"
      }
    }
  }
}
```

- `MSGFERRY_LOCAL_ROOT`：直指共享目录的 Ubuntu 挂载路径 `/mnt/hgfs/sharedir/vm_share`，MCP 与 Worker 共用同一目录，免同步。
- `MSGFERRY_MAX_WAIT_MS`：提交后阻塞等待结果的最大时长（默认 30000）。
- `MSGFERRY_POLLING_INITIAL` / `MSGFERRY_POLLING_MAX`：轮询退避起始与上限。

#### 1.2 worker

Worker 启动命令（Windows 侧，`--hgfs-root` 指向共享根 `vm_share` 这一级）：

```bat
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share
```

`config/worker.yaml` 位于共享目录 `E:\MyLinux\VMware\sharedir\vm_share\config\worker.yaml`：

```yaml
queue_mode: shared      # 共享目录，免同步（默认）
executor: ssh2          # 或 mock（联调，无需真实 SSH）
exec_mode: command      # 任务执行模式：command=一次性命令（默认）| shell=交互式 shell
# devices / policy_file / polling / heartbeat 等按需
devices:
  default:
    host: 192.168.16.107
    port: 22
    username: root
    password: your_password
```

> **exec_mode 说明**：`command`（默认）使用 SSH `exec` 通道执行一次性命令（请求-响应式）；`shell` 改用 SSH `shell` 通道 + pty 执行命令，**适用于目标设备不支持 exec 通道、仅支持交互式登录 shell 的场景**（如部分 Dropbear / 受限登录 shell）。两种模式通过 `config/worker.yaml` 的 `exec_mode` 一键切换，Worker 检测到配置变更会自动热重启生效。

> 需要业务日志落盘时，追加两个命令行参数：`--log-save 1 --log-dir logs/worker`。日志与审计目录默认落在 `<hgfs_root>/logs/worker`。

### 2. exchange 模式（文件交换服务器）

exchange 模式的核心判据是：**MCP 侧配置了 `MSGFERRY_SYNC_PUSH_CMD` 或 `MSGFERRY_SYNC_PULL_CMD`**。共享目录仅充当「单向信箱」，MCP 不再直接读写，而是通过交换服务器命令把 `outbound/` / `inbound/` 摆渡到共享目录。

#### 2.1 mcp server

在 `msgferry-mcp-server/.mcp.json` 的 `env` 中配置：

```json
{
  "mcpServers": {
    "msgferry-bridge-exchange": {
      "command": "node",
      "args": ["./index.mjs"],
      "env": {
        "MSGFERRY_LOCAL_ROOT": "$HOME/.msgferry/vm_share",
        "MSGFERRY_MAX_WAIT_MS": "120000",
        "MSGFERRY_POLLING_INITIAL": "500",
        "MSGFERRY_POLLING_MAX": "3000",

        "MSGFERRY_SYNC_PUSH_CMD": "node /home/sumu/workspace/msgferry/msgferry-mcp-server/scripts/sync-mock.mjs -pd {local_root}/{src} {dst}",
        "MSGFERRY_SYNC_PULL_CMD": "node /home/sumu/workspace/msgferry/msgferry-mcp-server/scripts/sync-mock.mjs -g inbound {local_root}/inbound",
        "MSGFERRY_SYNC_TIMEOUT_MS": "30000",
        "MSGFERRY_SYNC_RETRIES": "3",
        "MSGFERRY_SYNC_MOCK_SERVER": "/mnt/hgfs/sharedir/vm_share",

        "LOG_SAVE": "1"
      }
    }
  }
}
```

关键字段说明：

- `MSGFERRY_LOCAL_ROOT`：填**内网本地镜像目录** `$HOME/.msgferry/vm_share`（支持 `~/.msgferry/vm_share` 写法，缺目录 MCP 启动时自动创建），不再是共享挂载点。
- `MSGFERRY_SYNC_PUSH_CMD`：上传方向模板命令，`{src}` 替换为本地任务文件相对路径 `outbound/<id>.json`、`{dst}` 替换为服务器 `outbound/` 目录、`{local_root}` 替换为 `MSGFERRY_LOCAL_ROOT` 展开后的绝对路径。
- `MSGFERRY_SYNC_PULL_CMD`：拉取方向命令，整目录把服务器 `inbound/` 拉回本地镜像，仅 `{local_root}` 占位符生效。
- `MSGFERRY_SYNC_TIMEOUT_MS` / `MSGFERRY_SYNC_RETRIES`：单次同步命令超时与失败退避重试次数。
- `MSGFERRY_SYNC_MOCK_SERVER`：交换服务器根，即共享目录的 Ubuntu 路径 `/mnt/hgfs/sharedir/vm_share`（sync-mock 跑在 Ubuntu 侧，用它充当交换服务器）。
- `MSGFERRY_MAX_WAIT_MS`：exchange 模式建议调到 **120000**，覆盖「上传 → worker 执行 → 拉回」一整轮。

> Tips：不支持直接下载到指定目录怎么办？也就是说只能下载到当前目录，这个时候最简单的就是直接改模板，因为同步命令是**完全由用户定义的模板**，其实用户完全可以在 pull 命令里自己写：
>
> ```bash
> MSGFERRY_SYNC_PULL_CMD='cd {local_root}/inbound && file_transfer -g nfs/vm_share/inbound'
> ```
>
> `file_transfer -g` 的源带前缀指向服务器，本地目标不写，那下载自然落到当前目录，而当前目录已经被 `cd` 切到了 `{local_root}/inbound`。**这个方案零代码改动、最灵活，但要求用户了解自己的工具语义、自己会写 shell。**

#### 2.2 sync-mock.mjs 工具

`sync-mock.mjs` 用 `cp` 命令模拟 `file_transfer` 文件交换服务器，部署在 Ubuntu 的 MCP Server 目录下（`/home/sumu/workspace/msgferry/msgferry-mcp-server/sync-mock.mjs`），被 `MSGFERRY_SYNC_PUSH_CMD` / `PULL_CMD` 模板调用，**无需真实 `file_transfer`**。

- 它需要 `MSGFERRY_SYNC_MOCK_SERVER` 指向交换服务器根 → 填 `/mnt/hgfs/sharedir/vm_share`（上面已放进 `.mcp.json` env，MCP spawn 子进程自动继承）。
- 按 `-pd`（单文件上传）/ `-g`（整目录拉回）两个语义工作，与 `file_transfer` 对齐。
- push/pull 模板用了 `{local_root}` 绝对路径占位符，故 `MSGFERRY_SYNC_MOCK_LOCAL` 可不配。

exchange 模式数据流（保证文件正确单向摆渡的关键）：

```
push:  Ubuntu 本地 $HOME/.msgferry/vm_share/outbound/<id>.json
   └─sync-mock 复制 → /mnt/hgfs/sharedir/vm_share/outbound/<id>.json
                        （Windows 侧 = E:\MyLinux\VMware\sharedir\vm_share\outbound\）
                        → Worker 扫 vm_share/outbound/ 领任务 ✅

pull:  Worker 写结果 → /mnt/hgfs/sharedir/vm_share/inbound/result_<id>.json
   └─sync-mock -g 整目录拉回 → Ubuntu 本地 $HOME/.msgferry/vm_share/inbound/ ✅
```

#### 2.3 worker

Worker 启动命令与 shared 模式**完全相同**（`--hgfs-root` 指向共享根 `vm_share` 这一级），区别仅在 `config/worker.yaml` 的 `queue_mode`：

```bat
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share
```

`config/worker.yaml`（位于 `E:\MyLinux\VMware\sharedir\vm_share\config\worker.yaml`）只改两处：

```yaml
queue_mode: exchange    # 扫 outbound/ 领任务，结果写 inbound/
result_ttl_sec: 3600    # 交换模式建议调大，防结果未拉回就被 GC 清掉
executor: ssh2
exec_mode: command      # 任务执行模式：command=一次性命令（默认）| shell=交互式 shell
```

- exchange 模式下 Worker **无需配置任何同步命令**——它直接挂载交换服务器（即共享目录），天然同步。
- `--hgfs-root` 指向交换服务器挂载目录的 Windows 路径 `E:\MyLinux\VMware\sharedir\vm_share`（对应 Ubuntu `/mnt/hgfs/sharedir/vm_share`），**切勿**误填成 MCP 内网本地 `$HOME/.msgferry/vm_share`，否则扫不到任务。
- `queue_mode` 由配置文件决定，**不通过命令行传**；其余（SSH、策略、轮询、心跳、结果保留期）同样走配置文件。

### 3. 两种模式对照速览

| 环节 | shared | exchange |
| --- | --- | --- |
| MCP 根目录 | `/mnt/hgfs/sharedir/vm_share` | `$HOME/.msgferry/vm_share`（本地镜像） |
| 提交 | 写 `pending/<id>.json` | 写 `outbound/<id>.json` → push 单文件 → 归档 `sent/` |
| 结果 | 直接读 `completed/` / `failed/` | 每轮 pull 整目录 `inbound/` → 本地镜像匹配 |
| 心跳 | `last_beat` 15s 实时判定 | 可达 + 存在 + 未 shutdown（放宽） |
| 超时 | 写 cancelled 标记 | 只返回 timeout，写 cancel marker 尽力取消，可 query 续捞 |
| 取消 | 实时生效 | 尽力而为（等下一轮 push） |
| 大输出 | `outputs/<id>.stdout` | `inbound/<id>.stdout` 随结果批次拉回 |
| 同步命令 | 无 | `MSGFERRY_SYNC_PUSH_CMD` / `MSGFERRY_SYNC_PULL_CMD` |

## 四、 模拟测试

本项目通过 `test/` 与 `scripts/` 下的辅助脚本完成端到端模拟测试，覆盖 **mock 执行器** 与 **真实 SSH 执行器** 两种方式，每种方式均支持 **shared（共享目录）** 与 **exchange（文件交换服务器）** 两种模式。

### 1. 前置条件

```bash
# 1. 安装依赖并构建产物（所有测试脚本都依赖 dist/ 产物）
pnpm install
pnpm build

# 2.（仅 SSH 本机模拟 `--device local` 需要）安装并启动本机 OpenSSH server
sudo apt install openssh-server && sudo systemctl start ssh
```

> 注意：`test/test_work_mock.mjs` 与 `test/test_work_ssh.mjs` 共用 `test/temp` 目录，**两者不要同时运行**。

### 2. 测试命令速览

```bash
# mock 模拟测试（无需真实设备）
node test/test_work_mock.mjs                # shared 共享目录模式（默认）
node test/test_work_mock.mjs --exchange     # exchange 文件交换服务器模式

# SSH 真实设备 / 本机模拟测试
node test/test_work_ssh.mjs                              # 使用默认设备
node test/test_work_ssh.mjs --device local               # 本机模拟设备（推荐，无需外部真实设备）
node test/test_work_ssh.mjs --host <ip> --username <user> --password <pass> --port <port>  # 指定真实设备

# MCP 客户端测试（配合上面 Worker 启动）
node test/mcp-client.mjs                # shared 模式
node test/mcp-client.mjs --exchange     # exchange 模式
node test/mcp-client.mjs --device local # 指定设备名连接

# 模拟文件交换服务器脚本（cp 模拟 file_transfer，供 exchange 模式使用）
node scripts/sync-mock.mjs -pd <src-file> <dst-dir>   # 上传方向
node scripts/sync-mock.mjs -g <src-dir> <dst-dir>     # 拉取方向

# 清理与辅助
pnpm clean-log                             # 清理业务日志
node scripts/start-worker.mjs              # 启动 Worker（Windows 场景）
pnpm git-sync-force                        # 强制本地代码与远端保持一致
```

---
*本文档由 markdowncli 技能辅助生成*
