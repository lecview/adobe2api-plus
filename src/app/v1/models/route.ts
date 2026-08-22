import { eq } from "drizzle-orm";
import { publicModelList } from "@/lib/catalog";
import { db } from "@/lib/db";
import { systemSetting } from "@/lib/db/schema";
import { requireServiceApiKey } from "@/lib/service-auth";
import { getRequestId, toErrorResponse } from "@/lib/errors";

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  try {
    await requireServiceApiKey(request);
    const [setting] = await db.select({ publicModels: systemSetting.publicModels }).from(systemSetting).where(eq(systemSetting.id, "singleton")).limit(1);
    const configured = Array.isArray(setting?.publicModels) ? setting.publicModels.filter((value): value is string => typeof value === "string") : null;
    const data = configured ? publicModelList().filter((model) => configured.includes(model.id)) : publicModelList();
    return Response.json({ object: "list", data }, { headers: { "x-request-id": requestId } });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
