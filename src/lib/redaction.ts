const SECRET_KEY = /(password|secret|token|cookie|authorization|api.?key|credential|database.?url|proxy.?user|proxy.?pass)/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, SECRET_KEY.test(key) ? "[REDACTED]" : redact(child)]),
  );
}

export function maskSecret(value: string | null | undefined, visible = 4): string | null {
  if (!value) return null;
  if (value.length <= visible * 2) return "*".repeat(value.length);
  return `${value.slice(0, visible)}…${value.slice(-visible)}`;
}
