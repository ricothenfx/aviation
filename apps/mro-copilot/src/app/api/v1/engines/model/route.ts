import { engineModelSchema } from "@/lib/api/schemas";
import { rulModelInfo } from "@/lib/ai/client";
import { handleRouteError, jsonResponse, newRequestId, requireSession } from "@/lib/api/respond";

/**
 * GET /api/v1/engines/model (F4 additive, api-contracts.md §1): the serving
 * artifact's provenance + committed honest metrics (D-07) — surfaces the
 * ai-service /internal/v1/model through the public API for the dashboard.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const requestId = newRequestId();
  try {
    await requireSession("viewer");
    const info = await rulModelInfo(requestId);
    return jsonResponse(
      engineModelSchema.parse({
        modelVersion: info.version,
        modelSha256: info.sha256,
        trainedAt: info.trainedAt,
        dataset: info.dataset,
        metrics: { rmse: info.metrics.rmse, nasaScore: info.metrics.nasaScore },
      }),
    );
  } catch (err) {
    return handleRouteError(err, requestId);
  }
}
