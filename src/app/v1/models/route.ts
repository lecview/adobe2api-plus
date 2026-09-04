import { eq } from "drizzle-orm";
import { publicModelList } from "@/lib/catalog";
import { normalizePublicModels } from "@/lib/media-model-routing";
import { db } from "@/lib/db";
import { systemSetting } from "@/lib/db/schema";
import { requireServiceApiKey } from "@/lib/service-auth";
import { getRequestId, toErrorResponse } from "@/lib/errors";

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  try {
    await requireServiceApiKey(request);
    const [setting] = await db.select({ publicModels: systemSetting.publicModels }).from(systemSetting).where(eq(systemSetting.id, "singleton")).limit(1);
    const configured = Array.isArray(setting?.publicModels) ? normalizePublicModels(setting.publicModels) : null;
    const all = publicModelList();
    const enabled = new Set<string>(configured ?? []);
    const data = enabled.size ? all.filter((model) => enabled.has(model.id)) : all;
    return Response.json({ object: "list", data }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
