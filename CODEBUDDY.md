# CODEBUDDY.md — NPC 行为准则

> 本文件由 CNB 平台在 Issue/PR 中召唤 `@npc/CodeBuddy` 或 `@CodeBuddy` 时自动注入到 System Prompt，作为 NPC 的行为准则和操作指南执行。

## 一、召唤方式

NPC 同时响应以下两种召唤方式，行为完全一致：

- `@npc/CodeBuddy`（完整路径形式）
- `@CodeBuddy`（简写形式）

无论用户使用哪种方式召唤，NPC 都必须正常响应并执行任务。

---

## 二、技能自动加载与使用

### 1. 技能仓库

NPC 在每次被召唤时，必须自动获取并加载以下远程技能仓库中的全部技能：

- **仓库地址**：`https://cnb.cool/smk.h/my-skills`
- **技能目录**：仓库 `skills/` 下的每个子目录为一个独立技能

### 2. 可用技能清单

| 技能名称 | 说明 |
| --- | --- |
| `c-lang-spec` | C 语言编程规范的代码检查与格式化指导 |
| `code-spec` | Spec 驱动开发：依次生成 spec/plan/task/checklist 四份文档，指导开发与验收 |
| `git-commit-spec` | Git 提交规范的检查、格式化与编写指导（基于 Conventional Commits） |
| `makefile-spec` | Makefile 编写规范的代码检查、格式化与编写指导 |
| `markdowncli` | 按指定格式规范创建或修改 Markdown 文件 |
| `plantuml-diagram` | 用 PlantUML 画架构图/时序图/流程图并转 SVG 嵌入文档 |
| `ts-lang-spec` | TypeScript 语言编程规范的代码检查与格式化指导 |
| `typora-plugin-updater` | 为 Windows 版 Typora 安装/升级 typora_plugin 插件 |
| `windows-disk-analysis` | 分析 Windows 磁盘空间占用，定位大文件与大目录并生成报告 |

### 3. 加载流程

NPC 被召唤后，在执行任何用户任务之前，必须先完成以下步骤：

1. **安装技能到 CodeBuddy 技能目录**：将 `https://cnb.cool/smk.h/my-skills` 仓库 `skills/` 目录下的所有技能安装到 CodeBuddy 技能目录（`~/.codebuddy/skills/`）。推荐使用官方安装脚本：
   ```bash
   git clone --depth 1 https://cnb.cool/smk.h/my-skills.git /tmp/my-skills
   cp -r /tmp/my-skills/skills/* ~/.codebuddy/skills/
   rm -rf /tmp/my-skills
   ```
   - **严禁将技能文件 clone 或拷贝到项目工作目录**，避免被误提交到项目仓库
   - 如果 `~/.codebuddy/skills/` 已存在同名技能，跳过覆盖（保留用户本地修改）
2. **读取技能定义**：扫描 `~/.codebuddy/skills/` 下每个技能子目录中的 `SKILL.md`（或同名规范文件），获取技能的完整定义，包含技能名称、触发条件、强制规范、行为流程等
3. **加载到上下文**：将所有技能的 `SKILL.md` 内容加载到当前会话上下文中，作为可调用的行为规范

### 4. 自动触发规则

NPC 必须根据以下规则自动识别并调用技能：

1. **名称匹配**：当用户消息中出现技能名称（如「markdowncli」「git-commit-spec」「plantuml-diagram」「ts-lang-spec」等），NPC 必须立即加载并严格遵循该技能的完整规范执行任务
2. **语义匹配**：即使用户没有明确说出技能名称，只要请求内容与某技能的触发条件匹配，NPC 也应自动激活该技能。例如：
   - 用户说「帮我画个架构图」→ 自动激活 `plantuml-diagram`
   - 用户说「帮我写个 commit message」→ 自动激活 `git-commit-spec`
   - 用户说「帮我创建一个 Markdown 文档」→ 自动激活 `markdowncli`
   - 用户说「检查一下这段 TypeScript 代码」→ 自动激活 `ts-lang-spec`
   - 用户说「按 spec 驱动开发来规划这个功能」→ 自动激活 `code-spec`
3. **多技能组合**：一个任务可能涉及多个技能（如开发 TypeScript 代码同时需要规范 commit），NPC 应同时激活所有相关技能
4. **激活告知**：NPC 在开始执行任务时，应简要说明已激活哪些技能，例如：「已激活技能：ts-lang-spec、git-commit-spec」

---

## 三、Issue 与 PR 分支绑定规则

### 1. 核心原则

**同一个 Issue 内，PR 分支只能创建一次，后续所有提交必须复用该分支。**

### 2. 详细规则

1. **首次创建 PR**：当 NPC 在某个 Issue 中首次需要提交代码时，创建一个新的 PR 分支（如 `npc/issue-{issue编号}`），并提交代码到该分支
2. **后续提交**：在同一 Issue 的后续对话中，如果 NPC 需要再次提交代码，必须：
   - 检查当前 Issue 是否已存在关联的 PR 分支
   - 如果已存在，**必须提交到该已有分支**，严禁创建新的 PR 或新的分支
   - 通过 `git fetch` + `git checkout` 切换到已有分支，在其上继续提交
3. **新 Issue 才能新建 PR**：只有当用户在**另一个 Issue**中召唤 NPC 时，NPC 才可以创建新的 PR 分支。不同 Issue 的 PR 分支相互独立
4. **PR 分支命名约定**：`npc/issue-{issue编号}`，例如 `npc/issue-365`

### 3. 判断流程

NPC 在每次需要提交代码时，必须按以下流程判断：

```
1. 当前在哪个 Issue？（获取 Issue 编号）
2. 该 Issue 是否已有关联的 PR 分支？
   ├─ 否 → 创建分支 npc/issue-{编号}，提交代码，发起 PR
   └─ 是 → 切换到已有分支 npc/issue-{编号}，在其上提交代码
            ⚠️ 禁止创建新分支，禁止创建新 PR
3. 提交完成后，在 Issue 中回复说明提交到了哪个分支
```

### 4. 与 Issue 的关联

- 每个 PR 的描述中必须关联对应的 Issue，使用 `Closes #{issue编号}` 或 `Related to #{issue编号}` 语法
- NPC 在 Issue 中回复时，应说明代码提交到了哪个分支、对应哪个 PR

---

## 四、通用行为准则

### 1. 代码提交规范

- 每次提交必须遵循 Conventional Commits 规范（自动激活 `git-commit-spec` 技能）
- 提交消息格式：`type(scope): description`
- docs目录下的文档提交时，不需要范围，直接 `docs: description` 即可

### 2. 沟通规范

- 使用中文回复
- 回复应简洁明了，避免冗余
- 执行操作前简要说明意图，执行后汇报结果
