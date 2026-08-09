> 本文档说明 MsgFerry 外网 Node Worker 的**全部配置方式**。
>
> 核心结论：**启动 Worker 只需一个必填参数 `--hgfs-root`**（HGFS 共享根目录，Worker 视角的 Windows 绝对路径）。其余配置来源为：
> - **命令行参数**：仅 `--hgfs-root`（必填）、`--log-save`、`--log-dir`（业务日志两个字段，为保证日志模块正常初始化与及时写入，必须走命令行）；
> - **配置文件**：`<hgfs_root>/config/worker.yaml`（其余全部可配置项，如 `executor`、`devices`、`policy_file`、`polling` 等）；
> - **内置默认值**：配置文件未定义的项兜底。
>
> **不再支持任何环境变量配置**（含 `MSGFERRY_*` 与日志 `LOG_SAVE` / `LOG_DIR`）。

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

因此 **共享根目录的取值随运行侧不同而不同**：Worker 通过命令行 `--hgfs-root` 填 Windows 路径（`E:\MyLinux\VMware\sharedir\vm_share`），MCP 通过环境变量 `MSGFERRY_HGFS_ROOT` 填 Linux 路径（`/mnt/hgfs/sharedir/vm_share`）。两者指向同一目录即完成「共享」。

### 2. 以前的痛点

在引入配置文件之前，Worker 的所有参数都必须显式传入，SSH 真实模式下启动命令又长又难维护：

```bat
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share --executor ssh2 --ssh-host 192.168.1.100 --ssh-port 22 --ssh-user root --ssh-password ****** --heartbeat-interval 5 --result-ttl 600
```

问题：

- 参数全部硬编码在启动脚本里，内网侧看不到、也改不了；
- 每次调整 SSH 账号、轮询间隔都要改启动命令再重启；
- SSH 密码等敏感信息散落在命令行（任务管理器/`ps` 可见）与 shell 历史中。

### 3. 方案思路（配置收敛）

Worker 的全部可配置项其实分三类：

1. **必须与 MCP 侧对齐的唯一耦合点**：HGFS 共享根目录（Worker 侧用命令行 `--hgfs-root`，MCP 侧用环境变量 `MSGFERRY_HGFS_ROOT`，两侧各用自己的系统路径写法）。这是两侧进程**唯一需要保持一致的目录**，必须显式给出。
2. **日志两个字段（使能 + 目录）**：为保证日志模块能正常初始化和及时写入日志，必须由命令行在进程启动第一时间传递，**不进入配置文件**。
3. **其余都是 Worker 自身参数**（SSH 连接、策略、轮询、心跳、结果保留期、输出上限……），都有内置默认值，仅在需要调整时才要显式配置，统一收敛到配置文件。

因此启动命令退化为**一行**：

```bat
:: mock 模式（联调，无需 SSH）
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share

:: ssh2 真实模式（SSH 信息从 config/worker.yaml 读取，无需再传任何 --ssh-*）
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share

:: 需要业务日志落盘时，追加日志两个命令行参数
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share --log-save 1 --log-dir logs/worker
```

配置文件放在 HGFS 共享目录里，**天然跟随共享挂载点分发**——内网侧（MCP/Claude Code）与部署侧（外网 Worker）都能直接查看和编辑，不用再翻启动脚本。

### 4. 核心结论

- **一个必填参数**：`--hgfs-root`，指向 HGFS 共享根目录（Worker 侧填 Windows 路径）；
- **两个日志参数**：`--log-save`（使能，取值 `1`/`true`）、`--log-dir`（日志目录，默认 `<hgfs_root>/logs/worker`），**不走配置文件**；
- **一个配置文件**：`<hgfs_root>/config/worker.yaml`，承载其余全部可配置项，**文件内路径均为 Worker（Windows）视角**；
- **一条取值链**：`命令行（仅 hgfs-root/log-save/log-dir） → 配置文件 → 内置默认值`；
- **不再支持环境变量**：`MSGFERRY_*` 与日志 `LOG_SAVE` / `LOG_DIR` 均不读取。

## 二、 配置项总览

### 1. 配置来源与取值模型

Worker 可配置项取值来源按优先级从高到低依次为：

1. 命令行参数（仅 `--hgfs-root` / `--log-save` / `--log-dir`）；
2. 配置文件（`<hgfs_root>/config/worker.yaml`，路径固定不可自定义）；
3. 内置默认值（定义在 `packages/shared/src/constants.ts` 的 `POLLING` / `HEARTBEAT` / `RETENTION` / `OUTPUT`）。

所有数值型参数（如 `ssh.port`、`polling.*`、`heartbeat_interval_sec` 等）在解析时都会做数值转换，非法值（非数字）自动回退到默认值，不会导致启动失败。

### 2. 配置项对照表

下表是全部可配置项的「命令行 / 配置文件字段 / 默认值」对照关系：

| 配置项 | 命令行参数 | 配置文件字段 | 内置默认值 | 说明 |
| --- | --- | --- | --- | --- |
| HGFS 共享根目录 | `--hgfs-root`（必填） | ❌ 不读取（避免循环依赖） | **无（必填）** | 唯一必填项；Worker 侧填 Windows 路径 |
| 业务日志使能 | `--log-save` | ❌ 不体现 | 不启用 | 取 `1` / `true` 才写业务日志文件 |
| 业务日志目录 | `--log-dir` | ❌ 不体现 | `<hgfs_root>/logs/worker` | 绝对原样 / 相对基于 hgfs_root |
| 配置文件路径 | ❌ 不支持 | 固定 `<hgfs_root>/config/worker.yaml` | - | 不再支持 `--config-file` 自定义 |
| 执行器类型 | ❌ 删除 | `executor` | `mock` | `mock` / `ssh2` |
| 默认设备 | ❌ 删除 `--ssh-*` | `ssh.*` 或 `devices.default` | 无 | 默认设备 SSH 连接信息 |
| 多设备 | ❌ | `devices` | 无 | 设备名 → 连接信息 |
| 策略文件 | ❌ 删除 `--policy-file` | `policy_file` | `<hgfs_root>/policy/policy.json` | 相对路径基于 hgfs_root 解析 |
| 轮询起步间隔 | ❌ 删除 `--polling-*` | `polling.initial_interval_ms` | `500` (ms) | 有任务后复位到此值 |
| 轮询退避上限 | ❌ 删除 `--polling-*` | `polling.max_interval_ms` | `3000` (ms) | 无任务时退避上限 |
| 心跳写入间隔 | ❌ 删除 `--heartbeat-interval` | `heartbeat_interval_sec` | `5` (s) | 心跳文件写入周期 |
| 结果保留期 | ❌ 删除 `--result-ttl` | `result_ttl_sec` | `600` (s) | completed/failed 结果文件过期清理 |
| 大输出内联上限 | ❌ 删除 `--max-inline` | `max_inline_bytes` | `65536` (bytes) | 超过则落 `outputs/` 子目录 |
| 审计日志目录 | ❌ 删除 `--audit-dir` | ❌ 暂不体现 | = 业务日志目录 | 保留字段，当前固定与 `log_dir` 一致，以后有需要再放开 |

> **关于审计日志目录**：`audit_log_dir` 字段保留，但暂时不提供任何命令行/配置文件入口，直接赋值给业务日志目录 `log_dir`（默认即 `<hgfs_root>/logs/worker`）。避免配置文件过多字段增加复杂度，后续有需要再放开。

### 3. 唯一例外：hgfs_root 不进配置文件

#### 3.1 循环依赖

配置文件路径本身依赖 `hgfs_root`（固定 `<hgfs_root>/config/worker.yaml`），如果把 `hgfs_root` 也放进配置文件，就形成了**循环依赖**——不先知道 `hgfs_root` 就读不到配置文件，读不到配置文件又拿不到 `hgfs_root`。

#### 3.2 实际处理

因此 `hgfs_root` 是唯一例外：**只从命令行 `--hgfs-root` 读取**。配置文件里的 `hgfs_root` 字段即使写了也会被忽略（示例文件不再保留该字段）。

## 三、 路径处理与配置文件详解

### 1. 两侧路径视图：同一个共享目录，两套路径写法

这是整个配置最容易踩坑的地方，单独展开说明。

#### 1.1 Windows（Worker）视角

Worker 运行在**外网 Windows 宿主机**上，HGFS 共享文件夹以 Windows 盘符形式暴露，所有由 Worker 消费的路径都必须是 **Windows 格式**：

- 共享根目录：`E:\MyLinux\VMware\sharedir\vm_share`；
- 队列子目录：`E:\MyLinux\VMware\sharedir\vm_share\pending`、`E:\MyLinux\VMware\sharedir\vm_share\completed` 等；
- 配置文件：`E:\MyLinux\VMware\sharedir\vm_share\config\worker.yaml`；
- Worker 本地路径（私钥、策略文件）：同样按 Windows 格式写。

#### 1.2 Linux（MCP）视角

MCP 运行在**内网 Linux 虚拟机**上，同一目录以 HGFS 挂载路径暴露，MCP 侧所有路径都是 **Linux 格式**：

- 共享根目录：`/mnt/hgfs/sharedir/vm_share`；
- 队列子目录：`/mnt/hgfs/sharedir/vm_share/pending`、`/mnt/hgfs/sharedir/vm_share/completed` 等；
- `.mcp.json` 里的 `MSGFERRY_HGFS_ROOT` 环境变量填：`/mnt/hgfs/sharedir/vm_share`（MCP Server 的全部配置均由环境变量注入，不再支持命令行参数）。

#### 1.3 对齐原则与注意事项

- **共享根目录两侧各自填自己系统的路径**，但指向同一目录：Worker 用命令行 `--hgfs-root` 填 `E:\MyLinux\VMware\sharedir\vm_share`，MCP 用环境变量 `MSGFERRY_HGFS_ROOT` 填 `/mnt/hgfs/sharedir/vm_share`；
- **配置文件由 Worker（Windows）消费**：SSH 认证推荐写**用户名 + 密码**（`ssh.username` / `ssh.password`），无需 Windows 私钥文件；若改用私钥认证，`ssh.private_key_path` 等 **Worker 本地**路径字段写 Windows 格式；而 `policy_file` 是**共享目录内**的路径字段，建议**省略或写相对共享根目录的相对路径**（`policy/policy.json`），Worker 会依据 `--hgfs-root` 自动解析为绝对路径，避免示例绝对路径在换机/重启后写错位置；
- **YAML 中转义反斜杠**：若确需写 Windows 绝对路径（如 `C:\Users\...\id_ed25519`），YAML 中需写成双反斜杠 `\\`（或用单引号包裹避免转义），详见下节示例；
- 路径分隔符由 Node.js `node:path` 的 `join` 自动处理，代码层无需区分平台，只需保证**传入的值符合运行侧系统习惯**。

### 2. 配置文件路径（固定）

```
<hgfs_root>\config\worker.yaml
```

- 相对路径常量 `WORKER_CONFIG_FILE = 'config/worker.yaml'` 定义在 `packages/shared/src/constants.ts`；
- 由 shared 的 `resolveUnderRoot(hgfsRoot, WORKER_CONFIG_FILE)` 拼接为绝对路径（Windows 下自动得到 `E:\MyLinux\VMware\sharedir\vm_share\config\worker.yaml`）；
- **不再支持 `--config-file` / `MSGFERRY_CONFIG_FILE` 自定义路径**。

### 3. 完整示例

仓库内示例见 `packages/worker/config.example.yaml`（构建产物 `dist/msgferry-worker/config.example.yaml`）。`policy_file` 写**相对共享根目录的相对路径**（`policy/policy.json`），Worker 启动时按 `--hgfs-root` 解析为绝对路径；SSH 认证推荐使用**用户名 + 密码**，无需 Windows 私钥文件。多设备使用 `devices` 字典，设备名下放连接信息，后续可通过设备名查找到对应 IP 与账号：

```yaml
# SSH 执行器：mock（本地模拟）| ssh2（真实 SSH）
executor: ssh2

# 多设备：设备名 → SSH 连接信息（设备名仅限字母/数字/下划线/连字符）
devices:
  default:
    host: 192.168.1.100
    port: 22
    username: root
    password: your_password
  board-100:
    host: 192.168.1.100
    port: 22
    username: root
    password: your_password
  board-101:
    host: 192.168.1.101
    port: 22
    username: admin
    password: another_password

# 策略文件路径（建议写相对共享根目录的路径，由 Worker 解析为绝对路径）
policy_file: policy/policy.json

# 轮询退避参数（毫秒）
polling:
  initial_interval_ms: 500
  max_interval_ms: 3000

# 心跳写入间隔（秒）
heartbeat_interval_sec: 5

# 结果文件保留期（秒）
result_ttl_sec: 600

# stdout/stderr 内联字节数上限（超过则落 outputs/ 子目录）
max_inline_bytes: 65536
```

**设备命名规则**：约定推荐使用 `board-xxx`，但不强制校验前缀，支持用户自定义设备名；**只能使用字母、数字、下划线、连字符**，不能使用空格或任何特殊符号（`@`、`#`、`.`、`/`、中文等均不允许）。解析时会自动跳过非法设备名或缺少 `host`/`username` 的设备。

> 若仍沿用旧的单设备 `ssh` 字段，会作为**默认设备**（等价于 `devices.default`），向后完全兼容（仅配置文件内兼容，CLI/env 的 `--ssh-*` 已删除）。

> 若不用密码，也可改用私钥认证：配置 `private_key_path` 为 Worker 本地私钥的绝对路径（按 Worker 所在 Windows 主机视角写，如 `C:\\Users\\msgferry\\.ssh\\id_ed25519`，YAML 中反斜杠需转义为 `\\`），与 `password` 二选一。

### 4. 字段说明

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `executor` | string | `mock`（本地模拟，不发起真实 SSH）或 `ssh2`（真实 SSH 执行），默认 `mock` |
| `devices` | object | **多设备字典（推荐）**：设备名 → SSH 连接信息；设备名仅限字母/数字/下划线/连字符（推荐 `board-xxx`，不强制） |
| `devices.<设备名>.host` | string | 该设备 SSH 目标主机 IP 或域名；`ssh2` 模式必填 |
| `devices.<设备名>.port` | number/string | 该设备 SSH 端口，默认 `22` |
| `devices.<设备名>.username` | string | 该设备 SSH 登录用户名；`ssh2` 模式必填 |
| `devices.<设备名>.password` | string \| null | 该设备 SSH 登录密码（推荐，与 `private_key_path` 二选一） |
| `devices.<设备名>.private_key_path` | string \| null | 该设备 SSH 私钥文件绝对路径（可选，与 `password` 二选一），Windows 格式 |
| `ssh.host`（兼容） | string | 默认设备 SSH 目标主机 IP 或域名；`ssh2` 模式必填 |
| `ssh.port`（兼容） | number/string | 默认设备 SSH 端口，默认 `22` |
| `ssh.username`（兼容） | string | 默认设备 SSH 登录用户名；`ssh2` 模式必填 |
| `ssh.password`（兼容） | string \| null | 默认设备 SSH 登录密码（推荐，与 `private_key_path` 二选一） |
| `ssh.private_key_path`（兼容） | string \| null | 默认设备 SSH 私钥文件绝对路径（可选，与 `password` 二选一），Windows 格式 |
| `policy_file` | string | 命令安全策略 JSON 文件路径；**相对路径基于共享根目录解析**（默认 `policy/policy.json`），绝对路径原样使用 |
| `polling.initial_interval_ms` | number/string | 轮询起步间隔（毫秒），默认 `500` |
| `polling.max_interval_ms` | number/string | 轮询退避上限（毫秒），默认 `3000` |
| `heartbeat_interval_sec` | number/string | 心跳写入间隔（秒），默认 `5` |
| `result_ttl_sec` | number/string | 结果文件保留期（秒），默认 `600` |
| `max_inline_bytes` | number/string | stdout/stderr 内联上限（字节），默认 `65536` |

### 5. 使用注意事项

- **`executor` / `devices` / `ssh.*` 仅在需要调整时才写**：都有内置默认值，配置文件只放你要改的项即可；
- **`devices` / `ssh.*` 仅在 `executor` 为 `ssh2` 时生效**：mock 模式下即便配置了也会被忽略（`ssh_config` 直接为 `null`）；
- **密码与私钥二选一**：两者都配时优先使用私钥（见 `config.ts` 中 `private_key_path ?? null` / `password ?? null` 的处理）；两者都没配且 `executor=ssh2` 时，校验会报错；
- **`policy_file` 建议省略**：默认值即共享根目录下的 `policy/policy.json`，且自动跟随 `--hgfs-root` 定位，不受进程工作目录影响，也避免绝对路径在换机后失效；
- **日志配置（`--log-save` / `--log-dir`）不进配置文件**：为保证日志模块能正常初始化和及时写入日志，由命令行在启动时直接传递，避免读取配置文件前日志已初始化导致丢失；
- **`audit_log_dir` 暂不提供配置入口**：保留该字段但当前固定等于业务日志目录（`<hgfs_root>/logs/worker`），以后有需要再放开；
- 配置文件里**多余的未知字段会被忽略**，不会报错，方便以后扩展。

### 6. 容错行为

| 场景 | 行为 |
| --- | --- |
| 文件不存在 | **不报错**，全部走 CLI/默认值（`executor` 默认 `mock`） |
| 文件存在但 YAML 非法 | **启动即抛错**：`config file is not valid YAML: <路径>: <原因>` |
| 文件内容不是 YAML 对象（如数组/字符串） | **启动即抛错**：`config file must be a YAML object: <路径>` |
| 文件存在且合法 | 正常读取，缺失字段回退默认值 |

## 四、 配置解析

### 1. 取值规则

```
命令行（--hgfs-root / --log-save / --log-dir）  >  配置文件  >  内置默认值
```

- 命令行只认上述三个参数，其余 `--executor`、`--ssh-*`、`--audit-dir`、`--policy-file`、`--polling-*`、`--heartbeat-interval`、`--result-ttl`、`--max-inline`、`--config-file` 等**一律忽略**；
- **环境变量全部不读取**：`MSGFERRY_*` 系列与日志 `LOG_SAVE` / `LOG_DIR` 均不影响 Worker 配置解析（`MSGFERRY_HGFS_ROOT` 仍被 `scripts/start-worker.mjs` 等外部脚本读取作为 `--hgfs-root` 的兜底来源，但 Worker 进程本身不读）；
- 未显式给出的项按上表逐级回退，最终落到内置默认值（定义在 `packages/shared/src/constants.ts` 的 `POLLING` / `HEARTBEAT` / `RETENTION` / `OUTPUT`）。
- **`--hgfs-root` 是唯一必填例外**：只走命令行，不读配置文件（见「二、3」）。

### 2. 代码实现位置速查

| 文件 | 职责 |
| --- | --- |
| `packages/shared/src/constants.ts` | `WORKER_CONFIG_FILE` 路径常量、`POLLING` / `HEARTBEAT` / `RETENTION` / `OUTPUT` 默认值常量、`LOG_DIRS` 日志默认目录 |
| `packages/shared/src/config-file.ts` | 通用配置文件工具：`resolveUnderRoot` / `readJsonConfigFile` / `readYamlConfigFile` |
| `packages/worker/src/config.ts` | 解析与校验：`parseConfig`（命令行 + 配置文件 + 默认值）、`validateConfig` |
| `packages/worker/src/main.ts` | 启动时把 `--log-save` / `--log-dir` 解析结果注入 `process.env.LOG_SAVE` / `LOG_DIR` / `MSGFERRY_HGFS_ROOT`，供共享 Logger 延迟初始化读取 |
| `packages/worker/config.example.yaml` | 示例配置文件（Windows 路径），构建时拷贝到 `dist/msgferry-worker/config.example.yaml` |
| `build/pack.ts` | 打包时自动把 `config.example.yaml` 拷入产物目录 |
| `packages/worker/test/config.test.ts` | 单元测试：配置文件读取 / 默认值兜底 / CLI 与 env 不再生效 |

## 五、 启动方式

> Worker 运行在 Windows 上，以下命令均为 **Windows 命令行（cmd）** 写法。若用 PowerShell，路径中的反斜杠保持不变。

### 1. 最简单的启动（推荐）

配置文件就绪后，两种模式都只需一个必填参数：

```bat
:: mock 模式（联调，无真实 SSH）
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share

:: ssh2 真实模式（SSH 信息从 config/worker.yaml 读取）
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share
```

> Worker 是**常驻后台进程**，建议注册为 Windows 计划任务、服务或配合 `pm2-windows-startup` 开机自启。

### 2. 带业务日志启动

```bat
:: 开启业务日志落盘，目录默认 <hgfs_root>/logs/worker（可不传 --log-dir）
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share --log-save 1

:: 自定义日志目录（相对路径基于 hgfs_root 解析；绝对路径原样使用）
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share --log-save 1 --log-dir logs/worker
```

### 3. 快速上手模板

```bat
:: 1. 直接启动 Worker，自动补齐 config/ 与 policy/ 目录及模板文件
::    （首次启动自动从产物模板复制并重命名，见「六、启动引导：自动补齐模板」）
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share

:: 2. 按需编辑自动生成的模板（文件在共享目录里，内网 Linux 侧也能直接改）
notepad E:\MyLinux\VMware\sharedir\vm_share\config\worker.yaml
notepad E:\MyLinux\VMware\sharedir\vm_share\policy\policy.json

:: 3. 改完重启 Worker 生效
msgferry-worker --hgfs-root E:\MyLinux\VMware\sharedir\vm_share
```

## 六、 启动引导：自动补齐模板

> Worker 启动时会自动检测共享目录的 `config` 与 `policy` 目录及模板文件，**缺失则自动复制并重命名，已存在则跳过**，无需手动拷贝。

### 1. 行为规则

启动时（`main` 内 `initQueueDirs` 之前）执行引导逻辑：

| 检测项 | 缺失时自动创建 | 已存在时 |
| --- | --- | --- |
| `<hgfs_root>\config\worker.yaml` | 从 `config.example.yaml` 模板复制并重命名 | **跳过**，不覆盖用户改动 |
| `<hgfs_root>\policy\policy.json` | 从 `policy.example.json` 模板复制并重命名，且 **`default_action` 由 `deny` 改写为 `allow`** | **跳过**，不覆盖用户改动 |

- **模板来源**：随产物分发的 `config.example.yaml` / `policy.example.json`（位于 `dist/msgferry-worker/`，与 `index.mjs` 同目录）；产物中模板缺失时使用内置兜底模板，保证首次启动总能成功。
- **父目录自动创建**：`config/`、`policy/` 目录不存在时一并创建。
- **`default_action` 改写**：自动生成的 `policy/policy.json` 中 `default_action` 固定为 `allow`（模板里为 `deny`），即白名单未命中时默认放行；黑名单与危险参数模式仍然生效。已存在的策略文件不会被改写。
- **幂等**：重复启动不会重复复制，也不会改动已存在文件。
- **提示日志**：自动创建时打印 `[bootstrap] config/worker.yaml missing, created from template ...`，便于确认。

### 2. 实现位置

| 文件 | 职责 |
| --- | --- |
| `packages/worker/src/bootstrap.ts` | 引导模块：`ensureSharedTemplates(root)` 检测并补齐模板；复制策略模板时把 `default_action` 由 `deny` 改写为 `allow` |
| `packages/worker/src/main.ts` | 启动流程中调用 `ensureSharedTemplates(root)` |
| `packages/worker/test/bootstrap.test.ts` | 单元测试：缺失补齐 / 已存在跳过 / 幂等 / 策略 `default_action` 为 `allow` |

## 七、 边界与常见问题

### 1. MCP 侧与配置文件的边界

**当前 MCP 侧完全不会读取 `<hgfs_root>/config/worker.yaml`**，该配置文件只有 Worker 会消费。**MCP Server 的配置方式为纯环境变量注入**：`.mcp.json` 里的 `MSGFERRY_*` / `LOG_SAVE` / `LOG_DIR` 提供全部配置，不再支持任何命令行参数（`--hgfs-root` / `--max-wait` 等已删除，环境变量未定义时走内置默认值）。

原因：

- `config/worker.yaml` 里装的都是 **Worker 专属参数**（`executor`、`devices`/`ssh.*`、`heartbeat_interval_sec`、`result_ttl_sec`、`max_inline_bytes` 等），MCP 侧根本不关心；
- MCP 侧（内网 Linux）启动只需一个必填项 `MSGFERRY_HGFS_ROOT`（填 Linux 路径 `/mnt/hgfs/sharedir/vm_share`），其余 `MSGFERRY_MAX_WAIT_MS`、`MSGFERRY_POLLING_*` 都有内置默认值，一般不用配；
- shared 里的 `config-file.ts` 工具和 `WORKER_CONFIG_FILE` 常量是通用的，未来若想让 MCP 侧也读配置文件（如新增 `<hgfs_root>/config/mcp.json`），可直接复用。

**两侧唯一的耦合点始终是共享根目录指向同一个物理目录**（Worker 用命令行 `--hgfs-root` 填 `E:\MyLinux\VMware\sharedir\vm_share`，MCP 用环境变量 `MSGFERRY_HGFS_ROOT` 填 `/mnt/hgfs/sharedir/vm_share`）。

### 2. 常见问题（FAQ）

**Q1：不创建 `config/worker.yaml` 会怎样？**
不报错。Worker 按「命令行 + 内置默认值」运行，`executor` 默认 `mock`。

**Q2：`executor` 配成 `ssh2` 但没配任何设备（`devices` / `ssh.host` / `ssh.username`）会怎样？**
启动校验失败：`ssh_config is required when executor_type is ssh2`。若提供了设备但某设备缺 `host`/`username`，会报 `device "<设备名>" requires host and username`；设备名非法会报 `invalid device name ...`。

**Q3：改了 `config/worker.yaml` 需要重启 Worker 吗？**
需要。配置文件只在**启动时读取一次**（`parseConfig`），运行中修改不会热加载，重启 Worker 生效。

**Q4：配置文件里的数字写成字符串可以吗？**
可以。数值型字段会自动转成数字；转不成数字则回退默认值。

**Q5：密码和私钥都写了用哪个？**
优先私钥。`private_key_path` 非空即用私钥，否则用密码。推荐在配置文件中只配**用户名 + 密码**，无需 Windows 私钥文件。

**Q5.1：多个 SSH 设备怎么配置？后续怎么按设备名查找？**
在配置文件的 `devices` 字典中，每个设备名下放 `host`/`port`/`username`/`password`（或 `private_key_path`）等连接信息，设备名约定 `board-xxx`（不强制），但**只能使用字母、数字、下划线、连字符**，不能含空格或特殊符号。Worker 通过 `findSshConfig(config, 设备名)` 即可按设备名查到对应 IP 与账号；未指定设备名或未命中时回退到默认设备（`devices.default` 或旧 `ssh` 字段）。

**Q6：`config.example.yaml` 和部署用的 `worker.yaml` 是什么关系？**
`config.example.yaml` 只是**示例/模板**（随构建产物分发，便于参考），不会参与解析。**Worker 启动时若发现 `<hgfs_root>\config\worker.yaml` 不存在，会自动从模板复制并重命名**（策略同理），无需手动操作；已存在则原样保留、不会被覆盖（详见「六、启动引导」）。

**Q7：配置里的路径该用 Windows 格式还是 Linux 格式？**
看**谁消费、路径在哪**。`policy_file` 位于**共享目录内**，建议省略或写相对共享根目录的相对路径（`policy/policy.json`），Worker 按 `--hgfs-root` 自动解析，Windows 侧得到 `E:\...\policy\policy.json`、Linux 侧得到 `/mnt/hgfs/.../policy/policy.json`，两侧一致；SSH 认证推荐用**用户名 + 密码**，不涉及私钥文件；若改用私钥认证，`ssh.private_key_path` 是 **Worker 本地**文件，按 Worker（Windows）视角写绝对路径（如 `C:\Users\...\id_ed25519`），YAML 中反斜杠要转义成 `\\`；MCP 侧（Linux）只需在 `.mcp.json` 环境变量里写 Linux 格式的 `MSGFERRY_HGFS_ROOT`（如 `/mnt/hgfs/sharedir/vm_share`），它不读这个配置文件。

**Q8：旧的 `--executor`、`--ssh-*`、`MSGFERRY_*` 环境变量还能用吗？**
不能。Worker 已删除全部非日志命令行参数与全部环境变量配置。`--executor` 等旧参数会被忽略，配置一律写进 `config/worker.yaml`；日志用 `--log-save` / `--log-dir` 传。

---
*本文档由 markdowncli 技能辅助生成*
