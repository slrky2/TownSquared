import { NextResponse } from "next/server";
import { z } from "zod";
import { getImageKey } from "@/lib/bounties/store";
import { photoStorage } from "@/lib/reports/storage";
import { reportingResponse, RequestError } from "@/lib/api/errors";

export function GET(_req: Request, ctx: RouteContext<"/api/bounty-images/[imageId]">) {
  return reportingResponse(async () => {
    const { imageId } = await ctx.params;
    if (!z.uuid().safeParse(imageId).success) throw new RequestError(404, "Photo not found");
    const key = await getImageKey(imageId);
    if (!key) throw new RequestError(404, "Photo not found");
    const bytes = await photoStorage.read(key);
    return new NextResponse(new Uint8Array(bytes), { headers: {
      "Content-Type": "image/jpeg", "Content-Length": String(bytes.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    } });
  }, "Bounty service");
}
