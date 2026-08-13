/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : timestamp.ts
 * Author     : MsgFerry
 * Date       : 2026/08/09
 * Version    : 0.0.1
 * Description: 北京时间时间戳工具——统一业务日志文件名与日志行内的时间戳格式
 *             格式与参考项目 embedded-mcp-toolkit 的 src/utils/timestamp.ts 完全一致
 * ======================================================
 */

/** 当前北京时间各字段（含毫秒） */
export function beijingFields(): {
  y: number;
  m: string;
  d: string;
  hh: string;
  mm: string;
  ss: string;
  ms: string;
} {
  const now = new Date();
  const bj = new Date(
    now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }),
  );
  return {
    y: bj.getFullYear(),
    m: String(bj.getMonth() + 1).padStart(2, '0'),
    d: String(bj.getDate()).padStart(2, '0'),
    hh: String(bj.getHours()).padStart(2, '0'),
    mm: String(bj.getMinutes()).padStart(2, '0'),
    ss: String(bj.getSeconds()).padStart(2, '0'),
    ms: String(bj.getMilliseconds()).padStart(3, '0'),
  };
}

/**
 * 将 UTC 毫秒时间戳转换为北京时间各字段（含毫秒）
 * 用于把任务结构体中的毫秒时间戳统一转成可读的北京时间
 * @param tsMs - UTC 毫秒时间戳（epoch ms）
 * @returns 北京时间各字段
 */
export function beijingFieldsFromMs(tsMs: number): {
  y: number;
  m: string;
  d: string;
  hh: string;
  mm: string;
  ss: string;
  ms: string;
} {
  const d = new Date(tsMs);
  const bj = new Date(
    d.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }),
  );
  return {
    y: bj.getFullYear(),
    m: String(bj.getMonth() + 1).padStart(2, '0'),
    d: String(bj.getDate()).padStart(2, '0'),
    hh: String(bj.getHours()).padStart(2, '0'),
    mm: String(bj.getMinutes()).padStart(2, '0'),
    ss: String(bj.getSeconds()).padStart(2, '0'),
    ms: String(bj.getMilliseconds()).padStart(3, '0'),
  };
}

/**
 * 将 UTC 毫秒时间戳格式化为北京时间字符串，精确到毫秒
 * 格式: YYYY-MM-DD HH:mm:ss.SSS（北京时间 CST）
 * @param tsMs - UTC 毫秒时间戳（epoch ms）
 * @returns 形如 2026-08-13 20:38:45.123
 */
export function formatBeijingTimestamp(tsMs: number): string {
  const f = beijingFieldsFromMs(tsMs);
  return `${f.y}-${f.m}-${f.d} ${f.hh}:${f.mm}:${f.ss}.${f.ms}`;
}

/**
 * 日志文件名用时间戳（不含空格/冒号）
 * 格式: YYYY-MM-DD_HHMMSS（北京时间）
 *   - 日期用 '-' 分隔，便于肉眼识别
 *   - 时分秒紧凑无分隔符，缩短文件名
 *   - 各字段从大到小且定宽，字典序等于时间序
 */
export function fileTimestamp(): string {
  const f = beijingFields();
  return `${f.y}-${f.m}-${f.d}_${f.hh}${f.mm}${f.ss}`;
}

/**
 * 日志行内时间戳
 * 格式: [YYYY-MM-DD HH:mm:ss]
 */
export function logTimestamp(): string {
  const f = beijingFields();
  return `[${f.y}-${f.m}-${f.d} ${f.hh}:${f.mm}:${f.ss}]`;
}

/**
 * 将 UTC 时间转为北京时间(CST)显示
 * 格式: YYYY-MM-DD HH:mm:ss
 * @param utc - UTC 时间字符串
 * @returns 北京时间格式化字符串
 */
export function formatBeijingTime(utc: string): string {
  const d = new Date(utc);
  const bj = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const y = bj.getFullYear();
  const m = String(bj.getMonth() + 1).padStart(2, '0');
  const day = String(bj.getDate()).padStart(2, '0');
  const h = String(bj.getHours()).padStart(2, '0');
  const min = String(bj.getMinutes()).padStart(2, '0');
  const s = String(bj.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}:${s}`;
}

/**
 * 从任务产生时间的北京时间字符串中提取任务文件时间戳段
 * 任务文件名时间部分格式: yyyymmdd-hhmmssxxx（xxx 为毫秒）
 * 与任务 JSON 中的 submit_time（YYYY-MM-DD HH:mm:ss.SSS）保持一致。
 * @param submitTime - 任务产生时间字符串（YYYY-MM-DD HH:mm:ss.SSS）
 * @returns 形如 20260813-203845123
 */
export function submitTimeToFileTime(submitTime: string): string {
  // 2026-08-13 20:38:45.123 -> 20260813-203845123
  return submitTime
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replaceAll('.', '')
    .replace(' ', '-');
}

/**
 * 生成任务文件（不含后缀）的基名
 * 格式: yyyymmdd-hhmmssxxx-{task_id 前 8 位}
 * 其中时间部分来自任务产生时间（submit_time），保证与任务 JSON 中的任务产生时间点一致。
 * @param submitTime - 任务产生时间字符串（YYYY-MM-DD HH:mm:ss.SSS）
 * @param taskId - 任务唯一标识（完整 UUID）
 * @returns 形如 20260813-203845123-550e8400
 */
export function taskFileBaseName(submitTime: string, taskId: string): string {
  const timePart = submitTimeToFileTime(submitTime);
  const shortId = taskId.slice(0, 8);
  return `${timePart}-${shortId}`;
}

/**
 * 生成任务文件完整文件名（含 .json 后缀）
 * 格式: yyyymmdd-hhmmssxxx-{task_id 前 8 位}.json
 * @param submitTime - 任务产生时间字符串（YYYY-MM-DD HH:mm:ss.SSS）
 * @param taskId - 任务唯一标识（完整 UUID）
 * @returns 形如 20260813-203845123-550e8400.json
 */
export function taskFileName(submitTime: string, taskId: string): string {
  return `${taskFileBaseName(submitTime, taskId)}.json`;
}

/**
 * 从任务文件名中解析出 task_id 前 8 位
 * 文件名格式: yyyymmdd-hhmmssxxx-{uuid8}（可带 .json 等后缀）
 * @param name - 任务文件名
 * @returns task_id 前 8 位（大写化），无法解析返回空串
 */
export function parseTaskIdFromFileName(name: string): string {
  // 匹配 yyyymmdd-hhmmssxxx-<8位短id>
  const m = /^\d{8}-\d{9}-([^\s.]{8})/.exec(name);
  return m ? m[1] : '';
}
