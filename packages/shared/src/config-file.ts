/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : config-file.ts
 * Author     : MsgFerry
 * Date       : 2026/08/08
 * Version    : 0.0.1
 * Description: 共享 JSON 配置文件读取与“优先级取值”工具
 *             优先级：命令行参数 > 环境变量 > 配置文件 > 内置默认值
 * ======================================================
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 任意扁平 JSON 配置对象 */
export type ConfigFileShape = Record<string, unknown>;

/**
 * 将共享根目录下的相对路径解析为绝对路径
 * @param root - HGFS 共享根目录
 * @param relPath - 相对路径（如 config/worker.json）
 * @returns 拼接后的绝对路径
 */
export function resolveUnderRoot(root: string, relPath: string): string {
  return join(root, relPath);
}

/**
 * 读取 JSON 配置文件
 * - 文件不存在返回空对象（后续走默认值）
 * - 文件存在但解析失败 / 不是 JSON 对象时抛错
 * @param filePath - 配置文件绝对路径
 * @returns 解析后的配置对象
 */
export function readJsonConfigFile<T extends object>(filePath: string): T {
  if (!existsSync(filePath)) {
    return {} as T;
  }
  const raw = readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config file is not valid JSON: ${filePath}: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`config file must be a JSON object: ${filePath}`);
  }
  return parsed as T;
}

/**
 * 带优先级的值解析：命令行参数 > 环境变量 > 配置文件 > 默认值
 * @param opts - 解析选项
 * @returns 最终值（可能为 undefined）
 */
export function pickConfigValue(opts: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  flag?: string;       // 如 '--hgfs-root'
  envKey?: string;     // 如 'MSGFERRY_HGFS_ROOT'
  fileValue?: unknown; // 配置文件中的原始值
  defaultValue?: string;
}): string | undefined {
  const { argv, env, flag, envKey, fileValue, defaultValue } = opts;
  if (flag) {
    const idx = argv.indexOf(flag);
    if (idx !== -1 && idx + 1 < argv.length) {
      return argv[idx + 1];
    }
  }
  if (envKey && env[envKey]) {
    return env[envKey];
  }
  if (fileValue !== undefined && fileValue !== null && fileValue !== '') {
    return String(fileValue);
  }
  return defaultValue;
}

/**
 * 数值型取值，非法值回退到默认值
 * @param opts - 解析选项
 * @returns 解析后的数值
 */
export function pickConfigNumber(opts: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  flag?: string;
  envKey?: string;
  fileValue?: unknown;
  defaultValue: number;
}): number {
  const raw = pickConfigValue({
    argv: opts.argv,
    env: opts.env,
    flag: opts.flag,
    envKey: opts.envKey,
    fileValue: opts.fileValue,
  });
  if (raw === undefined) {
    return opts.defaultValue;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : opts.defaultValue;
}
