/**
 * 构建常量定义
 */

/** Node 编译目标 */
export const target = "es2020";

/** 需要构建发布产物的子包名（packages/ 下的目录名） */
export const buildTargets = ["mcp-server", "worker"] as const;

/** 每个包的 CLI 命令名（bin 字段） */
export const binNames: Record<string, string> = {
  "mcp-server": "msgferry-mcp",
  "worker": "msgferry-worker",
};

/** 原生/不可 bundle 的依赖，保持 external 并拷贝 node_modules */
export const nativeDeps = ["ssh2", "cpu-features"];

/** 所有 external 依赖（原生 + 框架级） */
export const external = [
  ...nativeDeps,
  "node:path",
  "node:fs",
  "node:os",
  "node:crypto",
  "node:child_process",
  "node:events",
  "node:stream",
  "node:util",
  "node:url",
  "node:buffer",
  "@modelcontextprotocol/server",
];
