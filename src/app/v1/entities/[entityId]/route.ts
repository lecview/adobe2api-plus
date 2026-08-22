import { DELETE as deleteEntity } from "@/app/v1/entities/route";

/** 兼容旧版按路径删除实体的公开契约。 */
export async function DELETE(request: Request, { params }: { params: Promise<{ entityId: string }> }) {
  const { entityId } = await params;
  const delegated = new Request(request.url, {
    method: "DELETE",
    headers: request.headers,
    body: JSON.stringify({ id: entityId, upstream_id: entityId }),
  });
  return deleteEntity(delegated);
}
