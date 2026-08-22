import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { mediaAsset, systemSetting } from "@/lib/db/schema";
import { AppError } from "@/lib/errors";
import { getSystemSettings } from "@/lib/system-settings";

export function mediaRoot(): string {
  return path.resolve(config.mediaRoot());
}

/**
 * 系统设置是运行时目录的权威来源；环境变量只作为数据库尚未初始化时的回退。
 */
export async function configuredMediaRoot(): Promise<string> {
  const [setting] = await db.select({ mediaRoot: systemSetting.mediaRoot }).from(systemSetting).where(eq(systemSetting.id, "singleton")).limit(1).catch(() => [] as { mediaRoot: string | null }[]);
  return path.resolve(setting?.mediaRoot?.trim() || config.mediaRoot());
}

export function safeObjectPath(objectKey: string): string {
  const root = mediaRoot();
  const resolved = path.resolve(root, objectKey);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new AppError("invalid_media_path", "Invalid media path", 400);
  return resolved;
}

export async function writeMedia(objectKey: string, bytes: Uint8Array, mimeType: string) {
  const settings = await getSystemSettings();
  if (bytes.byteLength > settings.generatedMaxSizeMb * 1024 * 1024) {
    throw new AppError("media_too_large", "Generated media exceeds the configured size limit", 502);
  }
  const root = path.resolve(await configuredMediaRoot());
  const target = path.resolve(root, objectKey);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new AppError("invalid_media_path", "Invalid media path", 400);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await (await import("node:fs/promises")).writeFile(temporary, bytes, { mode: 0o640 });
  const digest = createHash("sha256").update(bytes).digest("hex");
  await rename(temporary, target);
  return { objectKey, mimeType, byteSize: bytes.byteLength, sha256: digest, path: target };
}

/**
 * 将上游媒体以流方式写入临时文件，边读边校验大小和 SHA-256，最后原子改名。
 * 这样大文件不会先完整驻留在 Worker 内存中。
 */
export async function writeMediaStream(objectKey: string, source: AsyncIterable<Uint8Array>, mimeType: string) {
  const settings = await getSystemSettings();
  const maxBytes = settings.generatedMaxSizeMb * 1024 * 1024;
  const root = path.resolve(await configuredMediaRoot());
  const target = path.resolve(root, objectKey);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new AppError("invalid_media_path", "Invalid media path", 400);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const output = createWriteStream(temporary, { mode: 0o640 });
  const digest = createHash("sha256");
  let byteSize = 0;

  const writeChunk = (bytes: Buffer) => new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      output.off("drain", onDrain);
      output.off("error", onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    output.once("error", onError);
    if (output.write(bytes)) {
      cleanup();
      resolve();
    } else {
      output.once("drain", onDrain);
    }
  });

  const closeOutput = () => new Promise<void>((resolve, reject) => {
    const onClose = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => {
      output.off("close", onClose);
      output.off("error", onError);
    };
    output.once("close", onClose);
    output.once("error", onError);
    output.end();
  });

  try {
    for await (const chunk of source) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteSize += bytes.byteLength;
      if (byteSize > maxBytes) {
        const destroy = (source as AsyncIterable<Uint8Array> & { destroy?: () => void }).destroy;
        destroy?.call(source);
        throw new AppError("media_too_large", "Generated media exceeds the configured size limit", 502);
      }
      digest.update(bytes);
      await writeChunk(bytes);
    }
    await closeOutput();
    await rename(temporary, target);
    return { objectKey, mimeType, byteSize, sha256: digest.digest("hex"), path: target };
  } catch (error) {
    output.destroy();
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function mediaResponse(objectKey: string): Promise<Response> {
  const [asset] = await db.select().from(mediaAsset).where(eq(mediaAsset.objectKey, objectKey)).limit(1);
  if (!asset || asset.status !== "READY") throw new AppError("media_not_found", "Generated media not found", 404);
  const root = path.resolve(await configuredMediaRoot());
  const filePath = path.resolve(root, asset.objectKey);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) throw new AppError("invalid_media_path", "Invalid media path", 400);
  try {
    await stat(filePath);
  } catch {
    throw new AppError("media_missing", "Generated media metadata exists but the file is missing", 500);
  }
  const stream = createReadStream(filePath);
  return new Response(stream as unknown as ReadableStream, { headers: { "Content-Type": asset.mimeType, "Content-Length": String(asset.byteSize), "Cache-Control": "no-store" } });
}

export async function readMediaBytes(objectKey: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const [asset] = await db.select().from(mediaAsset).where(eq(mediaAsset.objectKey, objectKey)).limit(1);
  if (!asset || asset.status !== "READY") throw new AppError("media_not_found", "Generated media not found", 404);
  const root = path.resolve(await configuredMediaRoot());
  const filePath = path.resolve(root, asset.objectKey);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) throw new AppError("invalid_media_path", "Invalid media path", 400);
  try {
    const bytes = new Uint8Array(await readFile(filePath));
    return { bytes, mimeType: asset.mimeType };
  } catch {
    throw new AppError("media_missing", "Generated media metadata exists but the file is missing", 500);
  }
}

export async function removeMedia(objectKey: string) {
  const root = path.resolve(await configuredMediaRoot());
  const target = path.resolve(root, objectKey);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new AppError("invalid_media_path", "Invalid media path", 400);
  await rm(target, { force: true });
}
