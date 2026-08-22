import { z } from "zod";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { proxyNode } from "@/lib/db/schema";
import { requireAdminRequest, handleAdminError } from "@/lib/admin-api";
import { getRequestId } from "@/lib/errors";
import { testProxy } from "@/lib/proxy-pool";

const schema = z.object({ id: z.string().min(1).optional(), ids: z.array(z.string().min(1)).min(1).max(1000).optional() }).refine((value) => value.id !== undefined || value.ids !== undefined, { message: "id or ids is required" });

export async function POST(request: Request) {
  try {
    await requireAdminRequest(request);
    const input = schema.parse(await request.json());
    const ids = input.ids ?? (input.id ? [input.id] : []);
    const nodes = await db.select().from(proxyNode).where(inArray(proxyNode.id, ids));
    // 并行测试；单条失败不影响其它结果。
    const results = await Promise.all(nodes.map(async (node) => {
      const outcome = await testProxy(node);
      return { id: node.id, host: node.host, port: node.port, ...outcome };
    }));
    return Response.json({ results, request_id: getRequestId(request) });
  } catch (error) { return handleAdminError(error, request); }
}
