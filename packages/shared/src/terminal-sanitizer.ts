/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : terminal-sanitizer.ts
 * Author     : MsgFerry
 * Date       : 2026/08/09
 * Version    : 0.0.1
 * Description: 终端输出清洗——剥离 ANSI 转义、控制字符转为可见标记，保证日志文件为纯文本
 *             逻辑与参考项目 embedded-mcp-toolkit 的 src/utils/terminal-sanitizer.ts 完全一致
 * ======================================================
 */

/** 控制字符 → 可见文本标记映射表（0x00-0x08、0x0B-0x0C、0x0E-0x1F、0x7F） */
const CONTROL_CHARS: Record<number, string> = {
  0x00: '[NUL]',
  0x01: '[SOH]',
  0x02: '[STX]',
  0x03: '[ETX]',
  0x04: '[EOT]',
  0x05: '[ENQ]',
  0x06: '[ACK]',
  0x07: '[BEL]',
  0x08: '[BS]',
  0x0b: '[VT]',
  0x0c: '[FF]',
  0x0e: '[SO]',
  0x0f: '[SI]',
  0x10: '[DLE]',
  0x11: '[DC1]',
  0x12: '[DC2]',
  0x13: '[DC3]',
  0x14: '[DC4]',
  0x15: '[NAK]',
  0x16: '[SYN]',
  0x17: '[ETB]',
  0x18: '[CAN]',
  0x19: '[EM]',
  0x1a: '[SUB]',
  0x1b: '[ESC]',
  0x1c: '[FS]',
  0x1d: '[GS]',
  0x1e: '[RS]',
  0x1f: '[US]',
  0x7f: '[DEL]',
};

/** 匹配所有非打印控制字符（保留 \t 0x09、\n 0x0A） */
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * 清洗串口/SSH 输出中的控制字符，防止终端显示错乱
 * 清洗策略：
 *   1. \r\n → \n（CRLF 归一化为 LF）
 *   2. 孤立的 \r → \n（视为换行）
 *   3. 移除 ANSI CSI 序列（\x1b[...m, \x1b[...A/B/C/D 等）
 *   4. 移除其他控制字符（保留 \n 和 \t）
 * @param raw - 原始输出字符串
 * @returns 清洗后的安全字符串，可安全打印到终端
 */
export function sanitize(raw: string): string {
  return (
    raw
      // 先归一化 CRLF → LF
      .replace(/\r\n/g, '\n')
      // 孤立的 CR 替换为 LF
      .replace(/\r/g, '\n')
      // 移除 ANSI CSI 序列：ESC[ + 参数 + 字母
      // 匹配 \x1b[...m (SGR), \x1b[...A/B/C/D/H/J/K 等光标控制
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      // 移除其他 ANSI 序列（如 ESC]...BEL 等）
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b[^[][0-9;]*[A-Za-z]/g, '')
      // 移除除 \n \t 之外的控制字符（ASCII 0x00-0x08, 0x0B-0x0C, 0x0E-0x1F）
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
  );
}

/**
 * 清理日志行中的控制字符
 * 1. 先剥离 ANSI 转义序列（CSI、OSC 等）
 * 2. 移除回车符 \r
 * 3. 将非打印控制字符替换为可见标记（如 [ESC]、[BEL]）
 *
 * 保留制表符 \t 和换行符 \n。
 * 供 FileLogger 和 Logger 共用。
 *
 * CSI(Control Sequence Introducer): ESC[参数+字母, 如颜色/光标控制
 * OSC(Operating System Command): ESC]内容BEL, 如窗口标题
 *
 * @param line - 原始日志行（可能含控制字符和 ANSI 序列）
 * @returns 纯文本的日志行，ANSI 序列已剥离，控制字符已转为可见标记
 */
export function sanitizeLine(line: string): string {
  // 例：输入 "\x1b[0;32m[SUCCESS]\x1b[0m 编译完成！\x1b]0;title\x07\r\n"
  const stripped = line
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '[CSI]') // "\x1b[0;32m"→"[CSI]"
    .replace(/\x1b\][^\x07]*\x07/g, '[OSC]') // "\x1b]0;title\x07"→"[OSC]"
    .replace(/\x1b[^[][0-9;]*[A-Za-z]/g, '[ANSI]'); // 其他 ESC 开头序列 → "[ANSI]"

  // 此时："[CSI][SUCCESS][CSI] 编译完成！[OSC]\r\n"
  const noCr = stripped.replace(/\r/g, '');
  // 此时："[CSI][SUCCESS][CSI] 编译完成！[OSC]\n"

  return noCr.replace(
    CONTROL_RE,
    (ch) => CONTROL_CHARS[ch.charCodeAt(0)] ?? '',
  );
  // 最终："[CSI][SUCCESS][CSI] 编译完成！[OSC]\n"
}
