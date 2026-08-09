> 本文档说明 MsgFerry 外网 Node Worker 的**全部配置方式**，以及「配置文件方案」如何把启动参数收敛到一个文件。
>
> 核心结论：**启动 Worker 只需一个必填参数 `--hgfs-root`**（HGFS 共享根目录，Worker 视角的 Windows 绝对路径），其余全部可配置项按优先级 `命令行参数 > 环境变量 > 配置文件 > 内置默认值` 逐级回退。

## 一、 方案背景与设计动机

### 1. 部署拓扑：Worker 在外网 Windows、MCP 在内网 Linux

MsgFerry 的两侧进程物理上位于不同网络域，通过 **VMware HGFS 共享文件夹**（文件系统层）通信，不打通任何 TCP 网络：

| 进程 | 运行位置 | 操作系统 | 视角路径 |
| --- | --- | --- | --- |
| **Node Worker**（本文档主角） | 外网 Windows 宿主机 | Windows | `E:\MyLinux\VMware\sharedir\vm_share`（Windows 盘符路径） |
| **MCP Server** | 内网虚拟机（Claude Code 拉起） | Linux | `/mnt/hgfs/sharedir/vm_share`（HGFS 挂载路径） |

**关键认知**：两侧看到的是**同一个物理共享目录**，只是操作系统不同、路径写法不同：

- Windows 宿主机侧（Worker 视角）：HGFS 共享文件夹被映射为盘符，如 `E:\MyLinux\VMware\sharedir\vm_share`；
- 内网 Linux 侧（MCP 视角）：同一目录被挂载到 HGFS 挂载点，如 `/mnt/hgfs/sharedir/vm_share`。

因此 **`--hgfs-root` 的取值随运行侧不同而不同**：Worker 启动时填 Windows 路径（`E:\MyLinux\VMware\sharedir\vm_share`），MCP 启动时填 Linux 路径（`/mnt/hgfs/sharedir/vm_share`）。两者指向同一目录即完成「共享」。

### 2. 以前的痛点

在引入配置文件之前，Worker 的所有参数都必须显式传入，SSH 真实模式下启动命令又长又难维护：

```bat
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share --executor ssh2 --ssh-host 192.168.1.100 --ssh-port 22 --ssh-user root --ssh-password ****** --heartbeat-interval 5 --result-ttl 600
```

问题：

- 参数全部硬编码在启动脚本里，内网侧看不到、也改不了；
- 每次调整 SSH 账号、轮询间隔都要改启动命令再重启；
- SSH 密码等敏感信息散落在命令行（任务管理器/`ps` 可见）与 shell 历史中。

### 3. 方案思路

Worker 的全部可配置项其实分两类：

1. **必须与 MCP 侧对齐的唯一耦合点**：`--hgfs-root`（HGFS 共享根目录，两侧各用自己的系统路径写法）。这是两侧进程**唯一需要保持一致的目录**，必须显式给出。
2. **其余都是 Worker 自身参数**（SSH 连接、轮询、心跳、结果保留期、输出上限……），都有内置默认值，仅在需要调整时才要显式配置。

因此把第 2 类全部收敛到配置文件 `<hgfs_root>/config/worker.json` 后，启动命令退化为**一行**：

```bat
:: mock 模式（联调，无需 SSH）
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share

:: ssh2 真实模式（SSH 信息从 config/worker.json 读取，无需再传任何 --ssh-*）
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share
```

配置文件放在 HGFS 共享目录里，**天然跟随共享挂载点分发**——内网侧（MCP/Claude Code）与部署侧（外网 Worker）都能直接查看和编辑，不用再翻启动脚本。

### 4. 核心结论

- **一个必填参数**：`--hgfs-root`，指向 HGFS 共享根目录（Worker 侧填 Windows 路径）；
- **一个配置文件**：`<hgfs_root>/config/worker.json`，承载其余全部可配置项，**文件内路径均为 Worker（Windows）视角**；
- **一条优先级链**：`命令行参数 > 环境变量 > 配置文件 > 内置默认值`；
- **一个例外**：`hgfs_root` 因循环依赖只从命令行/环境变量读取（详见「二、3」）。

## 二、 配置项总览

### 1. 配置来源与优先级模型

Worker 共有 14 个可配置项（其中 13 项可写入配置文件，`hgfs_root` 只能走命令行/环境变量），取值来源按优先级从高到低依次为：

1. 命令行参数（`--xxx`）；
2. 环境变量（统一 `MSGFERRY_` 前缀）；
3. 配置文件（`<hgfs_root>/config/worker.json`，可自定义路径）；
4. 内置默认值（定义在 `packages/shared/src/constants.ts` 的 `POLLING` / `HEARTBEAT` / `RETENTION` / `OUTPUT`）。

所有数值型参数（如 `ssh.port`、`polling.*`、`heartbeat_interval_sec` 等）在解析时都会做数值转换，非法值（非数字）自动回退到默认值，不会导致启动失败。

### 2. 配置项对照表

下表是全部 13 项的「配置文件字段 / 命令行参数 / 环境变量 / 默认值」对照关系：

| 配置文件字段 | 命令行参数 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `hgfs_root` | `--hgfs-root` | `MSGFERRY_HGFS_ROOT` | **无（必填）** | 共享根目录绝对路径（Worker 侧 Windows 路径）；**只从命令行/环境变量读取**，不读配置文件 |
| `executor` | `--executor` | `MSGFERRY_EXECUTOR` | `mock` | `mock` / `ssh2` |
| `ssh.host` | `--ssh-host` | `MSGFERRY_SSH_HOST` | 无（ssh2 必填） | SSH 目标主机 |
| `ssh.port` | `--ssh-port` | `MSGFERRY_SSH_PORT` | `22` | SSH 端口 |
| `ssh.username` | `--ssh-user` | `MSGFERRY_SSH_USER` | 无（ssh2 必填） | SSH 登录用户 |
| `ssh.password` | `--ssh-password` | `MSGFERRY_SSH_PASSWORD` | 无 | SSH 登录密码（推荐，与私钥二选一） |
| `ssh.private_key_path` | `--ssh-key` | `MSGFERRY_SSH_KEY` | 无 | 私钥路径（可选，与密码二选一），Windows 路径 |
| `audit_log_dir` | `--audit-dir` | `MSGFERRY_AUDIT_DIR` | `<hgfs_root>/logs` | 审计日志目录；相对路径基于共享根目录解析，绝对路径原样使用 |
| `policy_file` | `--policy-file` | `MSGFERRY_POLICY_FILE` | `<hgfs_root>/policy/policy.json` | 命令安全策略文件；相对路径基于共享根目录解析，绝对路径原样使用 |
| `polling.initial_interval_ms` | `--polling-initial` | `MSGFERRY_POLLING_INITIAL` | `500` | 轮询起步间隔（ms），有任务后复位到此值 |
| `polling.max_interval_ms` | `--polling-max` | `MSGFERRY_POLLING_MAX` | `3000` | 轮询退避上限（ms） |
| `heartbeat_interval_sec` | `--heartbeat-interval` | `MSGFERRY_HEARTBEAT_INTERVAL` | `5` | 心跳写入间隔（秒） |
| `result_ttl_sec` | `--result-ttl` | `MSGFERRY_RESULT_TTL` | `600` | completed/failed 结果文件保留期（秒），过期由 Worker 清理 |
| `max_inline_bytes` | `--max-inline` | `MSGFERRY_MAX_INLINE` | `65536` | stdout/stderr 内联上限（字节），超出落 `outputs/` |

### 3. 唯一例外：hgfs_root 不进配置文件

#### 3.1 循环依赖

配置文件路径本身依赖 `hgfs_root`（默认在 `<hgfs_root>/config/worker.json`），如果把 `hgfs_root` 也放进配置文件，就形成了**循环依赖**——不先知道 `hgfs_root` 就读不到配置文件，读不到配置文件又拿不到 `hgfs_root`。

#### 3.2 实际处理

因此 `hgfs_root` 是唯一例外：**只从命令行参数 / 环境变量读取**。配置文件里的 `hgfs_root` 字段即使写了也会被忽略（示例文件里保留该字段仅作说明）。

## 三、 路径处理与配置文件详解

### 1. 两侧路径视图：同一个共享目录，两套路径写法

这是整个配置最容易踩坑的地方，单独展开说明。

#### 1.1 Windows（Worker）视角

Worker 运行在**外网 Windows 宿主机**上，HGFS 共享文件夹以 Windows 盘符形式暴露，所有由 Worker 消费的路径都必须是 **Windows 格式**：

- 共享根目录：`E:\MyLinux\VMware\sharedir\vm_share`；
- 队列子目录：`E:\MyLinux\VMware\sharedir\vm_share\pending`、`E:\MyLinux\VMware\sharedir\vm_share\completed` 等；
- 配置文件：`E:\MyLinux\VMware\sharedir\vm_share\config\worker.json`；
- Worker 本地路径（私钥、审计日志、策略文件）：同样按 Windows 格式写。

#### 1.2 Linux（MCP）视角

MCP 运行在**内网 Linux 虚拟机**上，同一目录以 HGFS 挂载路径暴露，MCP 侧所有路径都是 **Linux 格式**：

- 共享根目录：`/mnt/hgfs/sharedir/vm_share`；
- 队列子目录：`/mnt/hgfs/sharedir/vm_share/pending`、`/mnt/hgfs/sharedir/vm_share/completed` 等；
- `.mcp.json` 里的 `MSGFERRY_HGFS_ROOT` 环境变量填：`/mnt/hgfs/sharedir/vm_share`。

#### 1.3 对齐原则与注意事项

- **`--hgfs-root` / `MSGFERRY_HGFS_ROOT` 两侧各自填自己系统的路径**，但指向同一目录：Worker 填 `E:\MyLinux\VMware\sharedir\vm_share`，MCP 填 `/mnt/hgfs/sharedir/vm_share`；
- **配置文件由 Worker（Windows）消费**：SSH 认证推荐写**用户名 + 密码**（`ssh.username` / `ssh.password`），无需 Windows 私钥文件；若改用私钥认证，`ssh.private_key_path` 等 **Worker 本地**路径字段写 Windows 格式；而 `audit_log_dir`、`policy_file` 这两个**共享目录内**的路径字段建议**省略或写相对共享根目录的相对路径**（`logs`、`policy/policy.json`），Worker 会依据 `--hgfs-root` 自动解析为绝对路径，避免示例绝对路径在换机/重启后写错位置；
- **JSON 中转义反斜杠**：若确需写 Windows 绝对路径（如 `C:\Users\...\id_ed25519`），JSON 中需写成双反斜杠 `\\`，详见下节示例；
- 路径分隔符由 Node.js `node:path` 的 `join` 自动处理，代码层无需区分平台，只需保证**传入的值符合运行侧系统习惯**。

### 2. 配置文件路径

#### 2.1 默认路径

```
<hgfs_root>\config\worker.json
```

- 相对路径常量 `WORKER_CONFIG_FILE = 'config/worker.json'` 定义在 `packages/shared/src/constants.ts`；
- 由 shared 的 `resolveUnderRoot(hgfsRoot, WORKER_CONFIG_FILE)` 拼接为绝对路径（Windows 下自动得到 `E:\MyLinux\VMware\sharedir\vm_share\config\worker.json`）。

#### 2.2 自定义路径

可用 `--config-file` 参数或 `MSGFERRY_CONFIG_FILE` 环境变量显式指定其他位置：

```bat
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share --config-file C:\etc\msgferry\worker.json
```

自定义路径的解析优先级：`--config-file` > `MSGFERRY_CONFIG_FILE` > 默认约定（`<hgfs_root>\config\worker.json`）。

### 3. 完整示例

仓库内示例见 `packages/worker/config.example.json`（构建产物 `dist/msgferry-worker/config.example.json`）。`audit_log_dir` / `policy_file` 写**相对共享根目录的相对路径**（`logs`、`policy/policy.json`），Worker 启动时按 `--hgfs-root` 解析为绝对路径；SSH 认证推荐使用**用户名 + 密码**，无需 Windows 私钥文件：

```json
{
  "executor": "ssh2",
  "ssh": {
    "host": "192.168.1.100",
    "port": 22,
    "username": "root",
    "password": "your_password"
  },
  "audit_log_dir": "logs",
  "policy_file": "policy/policy.json",
  "polling": {
    "initial_interval_ms": 500,
    "max_interval_ms": 3000
  },
  "heartbeat_interval_sec": 5,
  "result_ttl_sec": 600,
  "max_inline_bytes": 65536
}
```

> 若不用密码，也可改用私钥认证：配置 `ssh.private_key_path` 为 Worker 本地私钥的绝对路径（按 Worker 所在 Windows 主机视角写，如 `C:\\Users\\msgferry\\.ssh\\id_ed25519`，JSON 中反斜杠需转义为 `\\`），与 `password` 二选一。

### 4. 字段说明

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `hgfs_root` | string | 仅作注释/参考，**实际不会读取**（见「二、3」） |
| `executor` | string | `mock`（本地模拟，不发起真实 SSH）或 `ssh2`（真实 SSH 执行） |
| `ssh.host` | string | SSH 目标主机 IP 或域名；`ssh2` 模式必填 |
| `ssh.port` | number/string | SSH 端口，默认 `22` |
| `ssh.username` | string | SSH 登录用户名；`ssh2` 模式必填 |
| `ssh.password` | string \| null | SSH 登录密码（推荐，与 `private_key_path` 二选一） |
| `ssh.private_key_path` | string \| null | SSH 私钥文件绝对路径（可选，与 `password` 二选一），Windows 格式 |
| `audit_log_dir` | string | 审计日志输出目录；**相对路径基于共享根目录解析**（默认 `logs`），绝对路径原样使用 |
| `policy_file` | string | 命令安全策略 JSON 文件路径；**相对路径基于共享根目录解析**（默认 `policy/policy.json`），绝对路径原样使用 |
| `polling.initial_interval_ms` | number/string | 轮询起步间隔（毫秒） |
| `polling.max_interval_ms` | number/string | 轮询退避上限（毫秒） |
| `heartbeat_interval_sec` | number/string | 心跳写入间隔（秒） |
| `result_ttl_sec` | number/string | 结果文件保留期（秒） |
| `max_inline_bytes` | number/string | stdout/stderr 内联上限（字节） |

### 5. 使用注意事项

- **配置文件内路径分两类**：`audit_log_dir`、`policy_file` 是**共享目录内**的路径，建议省略或写相对共享根目录的相对路径（`logs`、`policy/policy.json`），Worker 按 `--hgfs-root` 自动解析为绝对路径；SSH 认证推荐用**用户名 + 密码**（`ssh.username` / `ssh.password`），无需 Windows 私钥文件，若改用私钥认证则 `ssh.private_key_path` 是 **Worker 本地**路径，必须按 Worker 所在 Windows 主机填写绝对路径，注意 JSON 中反斜杠需转义（`\\`）；
- **`ssh.*` 仅在 `executor` 为 `ssh2` 时生效**：mock 模式下即便配置了 `ssh.*` 字段也会被忽略（`ssh_config` 直接为 `null`）；
- **密码与私钥二选一**：两者都配时优先使用私钥（见 `config.ts` 中 `private_key_path ?? null` / `password ?? null` 的处理）；两者都没配且 `executor=ssh2` 时，校验会报 `ssh_config.host and ssh_config.username are required`；
- **`audit_log_dir` / `policy_file` 建议省略**：默认值即共享根目录下的 `logs`、`policy/policy.json`，且自动跟随 `--hgfs-root` 定位，不受进程工作目录影响，也避免绝对路径在换机后失效；
- 配置文件里**多余的未知字段会被忽略**，不会报错，方便以后扩展。

### 6. 容错行为

| 场景 | 行为 |
| --- | --- |
| 文件不存在 | **不报错**，全部走 CLI/env/默认值（向后兼容旧用法，见「四、3」） |
| 文件存在但 JSON 非法 | **启动即抛错**：`config file is not valid JSON: <路径>: <原因>` |
| 文件内容不是 JSON 对象（如数组/字符串） | **启动即抛错**：`config file must be a JSON object: <路径>` |
| 文件存在且合法 | 正常按优先级读取，缺失字段回退默认值 |

## 四、 配置解析与优先级

### 1. 优先级规则

```
命令行参数  >  环境变量  >  配置文件  >  内置默认值
```

- 未显式给出的项按上表逐级回退，最终落到内置默认值（内置默认值定义在 `packages/shared/src/constants.ts` 的 `POLLING` / `HEARTBEAT` / `RETENTION` / `OUTPUT`）。
- **`--hgfs-root` 是唯一例外**：只走前两级（命令行参数 > 环境变量），不读配置文件（见「二、3」）。
- 优先级模型在代码中的实现位于 `packages/shared/src/config-file.ts`：
  - `pickConfigValue`：字符串取值，按 CLI → env → 配置文件 → 默认值顺序返回第一个非空值；
  - `pickConfigNumber`：数值取值，先走 `pickConfigValue`，再做 `Number()` 转换，非法值回退默认值。

### 2. 临时覆盖示例

需要临时覆盖时**无需改配置文件**，直接加命令行参数或环境变量即可：

```bat
:: 临时把心跳间隔调到 10s、最大轮询间隔调到 5s，其余仍走配置文件
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share --heartbeat-interval 10 --polling-max 5000

:: 等价：用环境变量覆盖
set MSGFERRY_HEARTBEAT_INTERVAL=10
set MSGFERRY_POLLING_MAX=5000
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share
```

### 3. 旧用法完全兼容

原有的逐参数传参、环境变量传参方式**全部保留**，且优先级高于配置文件。现有启动脚本**无需任何修改**。

三种来源可以自由混用，规则始终是 `命令行参数 > 环境变量 > 配置文件 > 内置默认值`：

```bat
:: 旧脚本无需修改，继续可用
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share --executor ssh2 --ssh-host 192.168.1.100 --ssh-port 22 --ssh-user root --ssh-password ****** --heartbeat-interval 5
```

### 4. 代码实现位置速查

| 文件 | 职责 |
| --- | --- |
| `packages/shared/src/constants.ts` | `WORKER_CONFIG_FILE` 路径常量、`POLLING` / `HEARTBEAT` / `RETENTION` / `OUTPUT` 默认值常量 |
| `packages/shared/src/config-file.ts` | 通用配置文件工具：`resolveUnderRoot` / `readJsonConfigFile` / `pickConfigValue` / `pickConfigNumber` |
| `packages/worker/src/config.ts` | 解析与校验：`parseConfig`（三级优先级取值）、`resolveConfigFilePath`、`validateConfig` |
| `packages/worker/config.example.json` | 示例配置文件（Windows 路径），构建时拷贝到 `dist/msgferry-worker/config.example.json` |
| `build/pack.ts` | 打包时自动把 `config.example.json` 拷入产物目录 |
| `packages/worker/test/config.test.ts` | 单元测试：配置文件读取 / 三级优先级 / 校验 |

## 五、 启动方式

> Worker 运行在 Windows 上，以下命令均为 **Windows 命令行（cmd）** 写法。若用 PowerShell，路径中的反斜杠保持不变，环境变量赋值语法略有差异。

### 1. 最简单的启动（推荐）

配置文件就绪后，两种模式都只需一个必填参数：

```bat
:: mock 模式（联调，无真实 SSH）
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share

:: ssh2 真实模式（SSH 信息从 config/worker.json 读取）
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share
```

> Worker 是**常驻后台进程**，建议注册为 Windows 计划任务、服务或配合 `pm2-windows-startup` 开机自启。

### 2. 完整参数启动（不依赖配置文件）

```bat
:: ssh2 真实模式，全部参数显式给出（配置文件不存在时等效于这种方式）
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share --executor ssh2 --ssh-host 192.168.1.100 --ssh-port 22 --ssh-user root --ssh-password ******
```

### 3. 混合方式（配置文件 + 临时覆盖）

```bat
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share --executor mock
```

> 上面这条命令即使 `config/worker.json` 里配了 `executor: "ssh2"`，也会被命令行 `--executor mock` 覆盖——适合临时从真实模式切到联调模式，不用动配置文件。

### 4. 快速上手模板

```bat
:: 1. 直接启动 Worker，自动补齐 config/ 与 policy/ 目录及模板文件
::    （首次启动自动从产物模板复制并重命名，见「七、启动引导：自动补齐模板」）
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share

:: 2. 按需编辑自动生成的模板（文件在共享目录里，内网 Linux 侧也能直接改）
notepad E:\MyLinux\VMware\sharedir\vm_share\config\worker.json
notepad E:\MyLinux\VMware\sharedir\vm_share\policy\policy.json

:: 3. 改完重启 Worker 生效
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share
```

## 六、 边界与常见问题

### 1. MCP 侧与配置文件的边界

**当前 MCP 侧完全不会读取 `<hgfs_root>/config/worker.json`**，该配置文件只有 Worker 会消费。

原因：

- `config/worker.json` 里装的都是 **Worker 专属参数**（`executor`、`ssh.*`、`heartbeat_interval_sec`、`result_ttl_sec`、`max_inline_bytes` 等），MCP 侧根本不关心；
- MCP 侧（内网 Linux）启动只需一个必填项 `MSGFERRY_HGFS_ROOT`（填 Linux 路径 `/mnt/hgfs/sharedir/vm_share`），其余 `max_wait_ms`、`polling.*` 都有内置默认值，一般不用配；
- shared 里的 `config-file.ts` 工具和 `WORKER_CONFIG_FILE` 常量是通用的，未来若想让 MCP 侧也读配置文件（如新增 `<hgfs_root>/config/mcp.json`），可直接复用。

**两侧唯一的耦合点始终是 `--hgfs-root` / `MSGFERRY_HGFS_ROOT` 指向同一个共享目录**（Worker 填 `E:\MyLinux\VMware\sharedir\vm_share`，MCP 填 `/mnt/hgfs/sharedir/vm_share`）。

### 2. 常见问题（FAQ）

**Q1：不创建 `config/worker.json` 会怎样？**
不报错。Worker 按「命令行参数 > 环境变量 > 内置默认值」运行，等价于旧用法；`executor` 默认 `mock`。

**Q2：`executor` 配成 `ssh2` 但 `ssh.host` / `ssh.username` 没配会怎样？**
启动校验失败：`ssh_config is required when executor_type is ssh2`（或 `ssh_config.host and ssh_config.username are required for ssh2 mode`）。

**Q3：改了 `config/worker.json` 需要重启 Worker 吗？**
需要。配置文件只在**启动时读取一次**（`parseConfig`），运行中修改不会热加载，重启 Worker 生效。

**Q4：配置文件里的数字写成字符串可以吗？**
可以。`pickConfigNumber` 会把字符串 `"500"` 转成数字 `500`；转不成数字则回退默认值。

**Q5：密码和私钥都写了用哪个？**
优先私钥。`ssh_config.private_key_path` 非空即用私钥，否则用密码。推荐在配置文件中只配**用户名 + 密码**，无需 Windows 私钥文件。

**Q6：`config.example.json` 和部署用的 `worker.json` 是什么关系？**
`config.example.json` 只是**示例/模板**（随构建产物分发，便于参考），不会参与解析。**Worker 启动时若发现 `<hgfs_root>\config\worker.json` 不存在，会自动从模板复制并重命名**（策略同理），无需手动操作；已存在则原样保留、不会被覆盖（详见「七、启动引导」）。

**Q7：配置里的路径该用 Windows 格式还是 Linux 格式？**
看**谁消费、路径在哪**。`audit_log_dir` / `policy_file` 位于**共享目录内**，建议省略或写相对共享根目录的相对路径（`logs`、`policy/policy.json`），Worker 按 `--hgfs-root` 自动解析，Windows 侧得到 `E:\...\logs`、Linux 侧得到 `/mnt/hgfs/.../logs`，两侧一致；SSH 认证推荐用**用户名 + 密码**，不涉及私钥文件；若改用私钥认证，`ssh.private_key_path` 是 **Worker 本地**文件，按 Worker（Windows）视角写绝对路径（如 `C:\Users\...\id_ed25519`），JSON 中反斜杠要转义成 `\\`；MCP 侧（Linux）只需在 `.mcp.json` 环境变量里写 Linux 格式的 `MSGFERRY_HGFS_ROOT`（如 `/mnt/hgfs/sharedir/vm_share`），它不读这个配置文件。

## 七、 启动引导：自动补齐模板

> Worker 启动时会自动检测共享目录的 `config` 与 `policy` 目录及模板文件，**缺失则自动复制并重命名，已存在则跳过**，无需手动拷贝。

### 1. 行为规则

启动时（`main` 内 `initQueueDirs` 之前）执行引导逻辑：

| 检测项 | 缺失时自动创建 | 已存在时 |
| --- | --- | --- |
| `<hgfs_root>\config\worker.json` | 从 `config.example.json` 模板复制并重命名 | **跳过**，不覆盖用户改动 |
| `<hgfs_root>\policy\policy.json` | 从 `policy.example.json` 模板复制并重命名，且 **`default_action` 由 `deny` 改写为 `allow`** | **跳过**，不覆盖用户改动 |

- **模板来源**：随产物分发的 `config.example.json` / `policy.example.json`（位于 `dist/msgferry-worker/`，与 `index.mjs` 同目录）；产物中模板缺失时使用内置兜底模板，保证首次启动总能成功。
- **父目录自动创建**：`config/`、`policy/` 目录不存在时一并创建。
- **`default_action` 改写**：自动生成的 `policy/policy.json` 中 `default_action` 固定为 `allow`（模板里为 `deny`），即白名单未命中时默认放行；黑名单与危险参数模式仍然生效。已存在的策略文件不会被改写。
- **幂等**：重复启动不会重复复制，也不会改动已存在文件。
- **提示日志**：自动创建时打印 `[bootstrap] config/worker.json missing, created from template ...`，便于确认。

### 2. 实现位置

| 文件 | 职责 |
| --- | --- |
| `packages/worker/src/bootstrap.ts` | 引导模块：`ensureSharedTemplates(root)` 检测并补齐模板；复制策略模板时把 `default_action` 由 `deny` 改写为 `allow` |
| `packages/worker/src/main.ts` | 启动流程中调用 `ensureSharedTemplates(root)` |
| `packages/worker/test/bootstrap.test.ts` | 单元测试：缺失补齐 / 已存在跳过 / 幂等 / 策略 `default_action` 为 `allow` |

---
*本文档由 markdowncli 技能辅助生成*
