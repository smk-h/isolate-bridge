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

/** 当前北京时间各字段 */
export function beijingFields(): {
  y: number;
  m: string;
  d: string;
  hh: string;
  mm: string;
  ss: string;
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
  };
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
