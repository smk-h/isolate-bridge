/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : sync-mock.mjs
 * Author     : MsgFerry
 * Date       : 2026/08/10
 * Version    : 0.0.1
 * Description: 测试辅助脚本——用 cp 命令模拟 file_transfer 文件交换服务器
 *
 * 真实环境没有交换服务器时，用它来仿真 file_transfer 的两种同步语义：
 *   - 上传方向（-pd）：单文件上传，`-pd <src-file> <dst-dir>`
 *   - 拉取方向（-g）：整目录拉回，`-g <src-dir> <dst-dir>`（完全替换本地目录）
 *
 * 用法：
 *   node scripts/sync-mock.mjs -pd {src} {dst}
 *   node scripts/sync-mock.mjs -g  <src-dir> <dst-dir>
 *
 * 服务器根目录从环境变量 MSGFERRY_SYNC_MOCK_SERVER 读取；
 * 相对目录名（outbound/、inbound/）基于服务器根目录解析，
 * 与真实 file_transfer「远程路径不校验、由命令自带上下文」的语义一致。
 *
 * 模拟同步延时：默认 1000ms，用环境变量 MSGFERRY_SYNC_MOCK_DELAY_MS（毫秒）覆盖，
 * 便于测试不同网络/同步延迟场景。设为 0 可完全关闭延时。
 *
 * 退出码：成功 0；参数/环境错误 2；cp 失败 1。
 * ======================================================
 */

import { copyFile, cp, mkdir, access, constants } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 服务器根目录：模拟文件交换服务器上的 vm_shared */
const serverRoot = process.env.MSGFERRY_SYNC_MOCK_SERVER;
if (!serverRoot) {
  console.error('[sync-mock] 环境变量 MSGFERRY_SYNC_MOCK_SERVER 未设置（模拟交换服务器根目录）');
  process.exit(2);
}

/** 模拟同步延时（毫秒），默认 1000ms 近似真实交换服务器一次同步的开销 */
const SYNC_DELAY_MS = Number(process.env.MSGFERRY_SYNC_MOCK_DELAY_MS ?? 1000);

/** 等待模拟延时（非正数时直接跳过，避免引入无意义 setTimeout(0)） */
async function simulateSyncDelay() {
  if (SYNC_DELAY_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, SYNC_DELAY_MS));
  }
}

const [, , flag, src, dst] = process.argv;

/**
 * 解析同步路径：相对路径基于服务器根目录，绝对路径原样使用
 * @param p - 用户命令中的路径（可能相对/绝对）
 * @returns 解析后的绝对路径
 */
function resolvePath(p) {
  if (!p) {
    return '';
  }
  return resolve(serverRoot, p);
}

/** 拉取方向：把服务器 inbound/ 整目录复制到本地镜像（完全替换） */
async function doPull(srcDir, dstDir) {
  const serverSrc = resolvePath(srcDir);
  await access(serverSrc, constants.R_OK).catch(() => {
    console.error(`[sync-mock] 服务器目录不存在: ${serverSrc}`);
    process.exit(2);
  });
  await mkdir(dstDir, { recursive: true });
  // 整目录覆盖：先清空目标再复制，等价于 file_transfer -g 的“完全替换本地目录”
  const { rm } = await import('node:fs/promises');
  await rm(dstDir, { recursive: true, force: true });
  await mkdir(dstDir, { recursive: true });
  await cp(serverSrc, dstDir, { recursive: true, force: true });
  await simulateSyncDelay();
  console.log(`[sync-mock] pull ${serverSrc} -> ${dstDir}`);
  process.exit(0);
}

/** 上传方向：把本地单个任务文件复制到服务器 outbound/ */
async function doPush(srcFile, dstDir) {
  const serverDst = resolvePath(dstDir);
  await mkdir(serverDst, { recursive: true });
  await copyFile(srcFile, join(serverDst, srcFile.split(/[\\/]/).pop()));
  await simulateSyncDelay();
  console.log(`[sync-mock] push ${srcFile} -> ${serverDst}`);
  process.exit(0);
}

// 入口：按 file_transfer 的 -pd / -g 语义分发
if (flag === '-g') {
  await doPull(src, dst).catch((err) => {
    console.error(`[sync-mock] pull 失败: ${err.message}`);
    process.exit(1);
  });
} else if (flag === '-pd') {
  await doPush(src, dst).catch((err) => {
    console.error(`[sync-mock] push 失败: ${err.message}`);
    process.exit(1);
  });
} else {
  console.error(`[sync-mock] 未知参数 ${flag}（仅支持 -pd 上传 / -g 拉取）`);
  process.exit(2);
}
