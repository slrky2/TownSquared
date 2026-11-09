import { NextResponse } from "next/server";
import { z } from "zod";
import { getPhotoKey } from "@/lib/db/store";
import { photoStorage } from "@/lib/reports/storage";
import { reportingResponse, RequestError } from "@/lib/api/errors";

// Only validated photos attached to public reports can be read here.
export function GET(_req: Request, ctx: RouteContext<"/api/issues/photos/[photoId]">) {
  return reportingResponse(async () => {
    const { photoId } = await ctx.params;
    if (!z.uuid().safeParse(photoId).success) throw new RequestError(404, "Photo not found");
    const key = await getPhotoKey(photoId);
    if (!key) throw new RequestError(404, "Photo not found");
    const bytes = await photoStorage.read(key);
    return new NextResponse(new Uint8Array(bytes), { headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    } });
  });
}
