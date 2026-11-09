import { NextResponse } from "next/server";
import { z } from "zod";
import { reportingResponse, RequestError } from "@/lib/api/errors";
import { requireReportUser } from "@/lib/reports/auth";
import { completePhotoUpload } from "@/lib/reports/photos";

export const maxDuration = 60;

export function POST(_req: Request, ctx: RouteContext<"/api/issues/photos/[photoId]/complete">) {
  return reportingResponse(async () => {
    const userId = await requireReportUser();
    const { photoId } = await ctx.params;
    if (!z.uuid().safeParse(photoId).success) throw new RequestError(400, "Invalid photo id");
    await completePhotoUpload(photoId, userId);
    return NextResponse.json({ photoId });
  });
}
