/**
 * @smai-kit/msgferry-mcp-server
 * MsgFerry 内网 MCP Server 入口
 *
 * 通过 stdio 协议与 Claude Code 通信，
 * 内部走 HGFS 文件队列与外网 Worker 通信。
 *
 * 后续将实现工具：
 * - submit_ssh_task：提交 SSH 任务
 * - query_task_status：查询任务状态
 * - cancel_task：取消任务
 * - check_bridge_health：检查 Worker 心跳
 */

export const PACKAGE_NAME = '@smai-kit/msgferry-mcp-server';
