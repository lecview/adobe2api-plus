import { z } from "zod";
import { db } from "@/lib/db";
import { proxyNode, proxyRotationState } from "@/lib/db/schema";
import { and, asc, eq, inArray, max, ne, sql } from "drizzle-orm";
import { requireAdminRequest, handleAdminError } from "@/lib/admin-api";
import { getProxySettings, parseProxyUrl, proxyCreateData, serializeProxy } from "@/lib/proxy-pool";
import { encryptSecret } from "@/lib/crypto";
import { AppError, getRequestId } from "@/lib/errors";

const createSchema = z.object({ raw: z.string().min(1), displayOrder: z.number().int().min(0).optional(), enabled: z.boolean().optional() });
const patchSchema = z.object({
  id: z.string().optional(),
  ids: z.array(z.string().min(1)).min(1).max(1000).optional(),
  raw: z.string().optional(),
  displayOrder: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
  // 分字段编辑（编辑弹窗用）：password 留空（不传）表示保持不变；显式 null 表示清空。
  protocol: z.enum(["HTTP", "SOCKS5"]).optional(),
  host: z.string().trim().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().max(500).nullable().optional(),
  password: z.string().max(500).nullable().optional(),
}).refine((value) => value.id !== undefined || value.ids !== undefined, { message: "id or ids is required" });
const reorderSchema = z.object({ order: z.array(z.string().min(1)).min(1).max(1000) });
const deleteSchema = z.object({
  id: z.string().optional(),
  ids: z.array(z.string().min(1)).min(1).max(1000).optional(),
  // cleanup=true：一键清理全部已禁用节点 + 重复节点（相同 protocol/host/port 保留 displayOrder 最小的）。
  cleanup: z.boolean().optional(),
}).refine((value) => value.id !== undefined || value.ids !== undefined || value.cleanup === true, { message: "id, ids or cleanup is required" });

export async function GET(request: Request) {
  try {
    await requireAdminRequest(request);
    const result = await getProxySettings();
    return Response.json({ enabled: result.enabled, nodes: result.nodes.map(serializeProxy), request_id: getRequestId(request) });
  } catch (error) { return handleAdminError(error, request); }
}

export async function POST(request: Request) {
  try {
    await requireAdminRequest(request);
    const input = createSchema.parse(await request.json());
    const lines = input.raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    let startOrder = input.displayOrder;
    if (startOrder === undefined) {
      const [{ max: maxOrder }] = await db.select({ max: max(proxyNode.displayOrder) }).from(proxyNode);
      startOrder = (maxOrder ?? -1) + 1;
    }
    // 解析全部完成后再统一做冲突检查与批量写入。逐条 await 数据库查询会
    // 放大远程 MySQL 的往返延迟（每条一次 findFirst/create），批量一次搞定。
    const parsed: Array<{ displayOrder: number; data: ReturnType<typeof proxyCreateData> }> = [];
    const errors: Array<{ line: number; message: string }> = [];
    for (const [index, raw] of lines.entries()) {
      try { parsed.push({ displayOrder: startOrder + index, data: proxyCreateData({ raw, displayOrder: startOrder + index, enabled: input.enabled }) }); }
      catch (error) { errors.push({ line: index + 1, message: error instanceof Error ? error.message : "invalid proxy" }); }
    }
    if (errors.length) return Response.json({ error: { code: "invalid_proxy_batch", message: "One or more proxy lines are invalid", details: { errors } }, request_id: getRequestId(request) }, { status: 400 });
    const nodes = await db.transaction(async (tx) => {
      // 解析通过后在同一事务内做冲突检查并批量写入，避免并发管理员请求
      // 留下半批代理节点。
      const displayOrders = parsed.map((item) => item.displayOrder);
      const conflicts = await tx.select({ displayOrder: proxyNode.displayOrder }).from(proxyNode).where(inArray(proxyNode.displayOrder, displayOrders));
      if (conflicts.length) throw new AppError("proxy_order_conflict", "Display order is already in use", 409, { display_order: conflicts[0].displayOrder });
      await tx.insert(proxyNode).values(parsed.map((item) => item.data));
      // MySQL 无 INSERT ... RETURNING，按 displayOrder 回查（该字段唯一），顺序与输入一致。
      return tx.select().from(proxyNode).where(inArray(proxyNode.displayOrder, displayOrders)).orderBy(asc(proxyNode.displayOrder));
    });
    return Response.json({ nodes: nodes.map(serializeProxy), node: nodes.length === 1 ? serializeProxy(nodes[0]) : undefined, request_id: getRequestId(request) }, { status: 201 });
  } catch (error) { return handleAdminError(error, request); }
}

export async function PATCH(request: Request) {
  try {
    await requireAdminRequest(request);
    const input = patchSchema.parse(await request.json());

    // 批量更新：仅支持统一启用/禁用（ids 数组），一次事务完成。
    if (input.ids) {
      if (input.raw !== undefined || input.displayOrder !== undefined) {
        throw new AppError("invalid_batch_patch", "Batch updates only support toggling enabled", 400);
      }
      const nodes = await db.transaction(async (tx) => {
        const existing = await tx.select({ id: proxyNode.id }).from(proxyNode).where(inArray(proxyNode.id, input.ids!));
        if (existing.length !== input.ids!.length) throw new AppError("proxy_not_found", "One or more proxies were not found", 404);
        if (input.enabled !== undefined) {
          await tx.update(proxyNode).set({ enabled: input.enabled, version: sql`${proxyNode.version} + 1`, updatedAt: new Date() }).where(inArray(proxyNode.id, input.ids!));
        }
        return tx.select().from(proxyNode).where(inArray(proxyNode.id, input.ids!)).orderBy(asc(proxyNode.displayOrder));
      });
      return Response.json({ nodes: nodes.map(serializeProxy), request_id: getRequestId(request) });
    }

    const [existing] = await db.select().from(proxyNode).where(eq(proxyNode.id, input.id!)).limit(1);
    if (!existing) return Response.json({ error: { message: "Proxy not found", code: "proxy_not_found" } }, { status: 404 });
    if (input.displayOrder !== undefined && input.displayOrder !== existing.displayOrder) {
      const [conflict] = await db.select().from(proxyNode).where(and(eq(proxyNode.displayOrder, input.displayOrder), ne(proxyNode.id, input.id!))).limit(1);
      if (conflict) return Response.json({ error: { message: "Display order is already in use", code: "proxy_order_conflict" } }, { status: 409 });
    }
    // 更新字段：raw 整体替换；否则按分字段（protocol/host/port/username/password/displayOrder/enabled）更新。
    const updates: Record<string, unknown> = {};
    if (input.raw !== undefined) {
      const parsed = parseProxyUrl(input.raw);
      updates.protocol = parsed.protocol;
      updates.host = parsed.host;
      updates.port = parsed.port;
      updates.encryptedUsername = parsed.username ? encryptSecret(parsed.username) : null;
      updates.encryptedPassword = parsed.password ? encryptSecret(parsed.password) : null;
    } else {
      if (input.protocol !== undefined) updates.protocol = input.protocol;
      if (input.host !== undefined) updates.host = input.host;
      if (input.port !== undefined) updates.port = input.port;
      if (input.username !== undefined) updates.encryptedUsername = input.username === null ? null : encryptSecret(input.username);
      if (input.password !== undefined) updates.encryptedPassword = input.password === null ? null : encryptSecret(input.password);
    }
    if (input.displayOrder !== undefined) updates.displayOrder = input.displayOrder;
    if (input.enabled !== undefined) updates.enabled = input.enabled;
    if (!Object.keys(updates).length) throw new AppError("proxy_no_changes", "No proxy changes were provided", 400);
    // MySQL 无 RETURNING，update 后按 id 回查返回完整记录。
    await db.update(proxyNode).set({ ...updates, version: sql`${proxyNode.version} + 1`, updatedAt: new Date() }).where(eq(proxyNode.id, input.id!));
    const [node] = await db.select().from(proxyNode).where(eq(proxyNode.id, input.id!)).limit(1);
    return Response.json({ node: serializeProxy(node), request_id: getRequestId(request) });
  } catch (error) { return handleAdminError(error, request); }
}

export async function PUT(request: Request) {
  try {
    await requireAdminRequest(request);
    const input = reorderSchema.parse(await request.json());
    const nodes = await db.select().from(proxyNode).orderBy(asc(proxyNode.displayOrder));
    const known = new Set(nodes.map((node) => node.id));
    if (nodes.length !== input.order.length || input.order.some((id) => !known.has(id)) || new Set(input.order).size !== input.order.length) {
      return Response.json({ error: { code: "proxy_order_invalid", message: "Order must contain every proxy node exactly once" }, request_id: getRequestId(request) }, { status: 400 });
    }
    const updated = await db.transaction(async (tx) => {
      // 先写入负数临时顺序，避开 displayOrder 唯一键在交换节点时的冲突。
      const temporaryBase = -1000 - nodes.length;
      for (const [index, node] of nodes.entries()) await tx.update(proxyNode).set({ displayOrder: temporaryBase - index, updatedAt: new Date() }).where(eq(proxyNode.id, node.id));
      for (const [index, id] of input.order.entries()) await tx.update(proxyNode).set({ displayOrder: index, version: sql`${proxyNode.version} + 1`, updatedAt: new Date() }).where(eq(proxyNode.id, id));
      await tx.insert(proxyRotationState).values({ id: "singleton", nextOrder: 0 }).onDuplicateKeyUpdate({ set: { nextOrder: 0, version: sql`${proxyRotationState.version} + 1`, updatedAt: new Date() } });
      return tx.select().from(proxyNode).orderBy(asc(proxyNode.displayOrder));
    });
    return Response.json({ nodes: updated.map(serializeProxy), request_id: getRequestId(request) });
  } catch (error) { return handleAdminError(error, request); }
}

export async function DELETE(request: Request) {
  try {
    await requireAdminRequest(request);
    const input = deleteSchema.parse(await request.json());

    // 一键清理：删除全部已禁用节点 + 重复节点（相同 protocol/host/port 保留 displayOrder 最小的），
    // 并重置轮换游标避免 nextOrder 指向已删除的顺序。
    if (input.cleanup) {
      const result = await db.transaction(async (tx) => {
        const nodes = await tx.select().from(proxyNode).orderBy(asc(proxyNode.displayOrder));
        const disabledIds = nodes.filter((node) => !node.enabled).map((node) => node.id);
        const seen = new Map<string, string>();
        const duplicateIds: string[] = [];
        for (const node of nodes) {
          const key = `${node.protocol}|${node.host}|${node.port}`.toLowerCase();
          if (seen.has(key)) duplicateIds.push(node.id);
          else seen.set(key, node.id);
        }
        const toDelete = [...new Set([...disabledIds, ...duplicateIds])];
        if (toDelete.length) await tx.delete(proxyNode).where(inArray(proxyNode.id, toDelete));
        await tx.insert(proxyRotationState).values({ id: "singleton", nextOrder: 0 }).onDuplicateKeyUpdate({ set: { nextOrder: 0, version: sql`${proxyRotationState.version} + 1`, updatedAt: new Date() } });
        const remaining = await tx.select().from(proxyNode).orderBy(asc(proxyNode.displayOrder));
        return { deleted: toDelete.length, deletedIds: toDelete, remaining };
      });
      return Response.json({ deleted: result.deleted, deletedIds: result.deletedIds, nodes: result.remaining.map(serializeProxy), request_id: getRequestId(request) });
    }

    // 常规删除：真正删除指定节点记录（原实现只是禁用，这里修复为删除）。
    const ids = input.ids ?? (input.id ? [input.id] : []);
    const result = await db.transaction(async (tx) => {
      const existing = await tx.select({ id: proxyNode.id }).from(proxyNode).where(inArray(proxyNode.id, ids));
      if (existing.length !== ids.length) throw new AppError("proxy_not_found", "One or more proxies were not found", 404);
      await tx.delete(proxyNode).where(inArray(proxyNode.id, ids));
      await tx.insert(proxyRotationState).values({ id: "singleton", nextOrder: 0 }).onDuplicateKeyUpdate({ set: { nextOrder: 0, version: sql`${proxyRotationState.version} + 1`, updatedAt: new Date() } });
      return tx.select().from(proxyNode).where(inArray(proxyNode.id, ids));
    });
    return Response.json({ deleted: true, ids, nodes: result.map(serializeProxy), request_id: getRequestId(request) });
  } catch (error) { return handleAdminError(error, request); }
}
