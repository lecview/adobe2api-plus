/**
 * x-arp-session-id（sherlockToken）解析工具。
 *
 * 账号选择阶段每次都从该账号绑定的 refreshprofile Cookie 中读取 Sherlock，
 * 本模块不查询数据库，也不保存进程级缓存。
 */

/** cookie 字符串中提取 sherlockToken（即官网的 x-arp-session-id）。 */
export function extractSherlockToken(cookieStr: string): string {
  const match = cookieStr.match(/(?:^|;\s*)sherlockToken=([^;]+)/);
  return match ? match[1] : "";
}

export type SherlockFields = { sid: string; ark: string; bfp: string; ftr: string };

/** 解析并校验 Sherlock 必须来自同一 SDK 回调的完整四字段结构。 */
export function parseSherlockToken(value: string): SherlockFields | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const fields = { sid: record.sid, ark: record.ark, bfp: record.bfp, ftr: record.ftr };
    if (Object.values(fields).some((field) => typeof field !== "string" || !field)) return null;
    return fields as SherlockFields;
  } catch {
    return null;
  }
}

/** 从 Cookie 中取得结构完整的 Sherlock；缺失或不完整时返回空串。 */
export function completeSherlockFromCookie(cookieStr: string): string {
  const value = extractSherlockToken(cookieStr);
  return value && parseSherlockToken(value) ? value : "";
}
