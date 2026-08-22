/**
 * Forter PoW / ftr 服务端铸造。
 *
 * 依据 analysis/out/algorithm-reconstruction.md 与 ftr-format.md（2026-08-18 以真实样本验证）：
 * - challenge 由 Forter 公开端点 `cdn123.forter.com/?u=<deviceId>&v=2` 服务端签发：
 *   `{"c":"<b64>","d":<难度>,"v":"2"}`（d 默认 3，即 md5 十六进制末尾 3 位为 0）。
 * - `num` = 最小 y（从 2 起）使 `md5(challenge + y)` 末尾 `d` 位为 "0"（hashcash 型 PoW，
 *   与 Forter SDK worker `w()`/`T()` 逐字节一致）。
 * - ftr 拼接：`{deviceId}_{ts}__{ex}_{siteId}ck_{challenge}-{num}-v2_tt`
 *   （真实样本 `c6075547..._1786959838119__UDF43-m4_31ck_ECL7M0ED7vg=-4910-v2_tt`）。
 *
 * 本模块不持有任何 Adobe 凭证；只调用公开 challenge 端点与纯计算。
 */
import { createHash } from "node:crypto";

export type ForterChallenge = { challenge: string; difficulty: number; version: string };

export const FORTER_CHALLENGE_URL = "https://cdn123.forter.com/";
export const FORTER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

/** 求解 Forter PoW：找最小 num（≥2）使 md5(challenge + num) 末 difficulty 位全为 "0"。 */
export function solvePow(challenge: string, difficulty: number): number {
  const target = "0".repeat(Math.max(1, difficulty));
  let num = 2;
  for (;;) {
    const hash = createHash("md5").update(challenge + String(num), "utf8").digest("hex");
    if (hash.endsWith(target)) return num;
    num += 1;
  }
}

/** 向 Forter 公开端点请求新 challenge（服务端签发）。 */
export async function fetchForterChallenge(
  deviceId: string,
  options: { baseUrl?: string; userAgent?: string; signal?: AbortSignal } = {},
): Promise<ForterChallenge> {
  const base = options.baseUrl ?? FORTER_CHALLENGE_URL;
  const url = `${base}?u=${encodeURIComponent(deviceId)}&v=2`;
  const response = await fetch(url, {
    headers: { "User-Agent": options.userAgent ?? FORTER_USER_AGENT, Accept: "application/json" },
    signal: options.signal,
  });
  if (response.status !== 200) {
    throw new Error(`Forter challenge request failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { c?: string; d?: number; v?: string };
  const challenge = body.c ?? "";
  if (!challenge) throw new Error("Forter challenge response missing field 'c'");
  return { challenge, difficulty: Number(body.d) || 3, version: String(body.v ?? "2") };
}

export type MintFtrInput = {
  /** 会话起始 ms 时间戳；缺省用当前时间。 */
  ts?: number;
  /** 浏览器特性标志串，真实样本为 "UDF43-m4"。 */
  ex?: string;
  /** 站点号（Forter siteNumber），真实样本 "31"。 */
  siteId?: string;
};

/** 用现有 deviceId 铸造 ftr：取新 challenge → 解 PoW → 拼接。 */
export async function mintFtr(
  deviceId: string,
  input: MintFtrInput = {},
  options: { fetchChallenge?: (deviceId: string) => Promise<ForterChallenge> } = {},
): Promise<string> {
  const challenge = await (options.fetchChallenge ?? fetchForterChallenge)(deviceId);
  const num = solvePow(challenge.challenge, challenge.difficulty);
  return assembleFtr(deviceId, challenge.challenge, num, input);
}

/** 纯拼接（不请求网络），便于测试与离线铸造。 */
export function assembleFtr(deviceId: string, challenge: string, num: number, input: MintFtrInput = {}): string {
  const ts = input.ts ?? Date.now();
  const ex = input.ex ?? "UDF43-m4";
  const siteId = input.siteId ?? "31";
  return `${deviceId}_${ts}__${ex}_${siteId}ck_${challenge}-${num}-v2_tt`;
}

/** 从完整 sherlock 会话 cookie 中提取 Forter 设备 id（forterToken 格式 `<deviceId>,<ts>` 或 6 段 ftr）。 */
export function forterDeviceIdFromCookie(cookieStr: string): string {
  const match = cookieStr.match(/(?:^|;\s*)forterToken=([^;]+)/);
  const value = match ? decodeURIComponent(match[1]) : "";
  return value.split(",")[0]?.split("_")[0] ?? "";
}
