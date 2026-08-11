## README

## 模拟测试

本项目通过 `test/` 与 `scripts/` 下的辅助脚本完成端到端模拟测试，覆盖 **mock 执行器** 与 **真实 SSH 执行器** 两种方式，每种方式均支持 **shared（共享目录）** 与 **exchange（文件交换服务器）** 两种模式。

### 前置条件

```bash
# 1. 安装依赖并构建产物（所有测试脚本都依赖 dist/ 产物）
pnpm install
pnpm build

# 2.（仅 SSH 本机模拟 `--device local` 需要）安装并启动本机 OpenSSH server
sudo apt install openssh-server && sudo systemctl start ssh
```

> 注意：`test/test_work_mock.mjs` 与 `test/test_work_ssh.mjs` 共用 `test/temp` 目录，**两者不要同时运行**。

### 测试命令速览

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
