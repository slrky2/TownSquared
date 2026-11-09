import { NextResponse } from "next/server";
import { z } from "zod";
import { reportingResponse, RequestError } from "@/lib/api/errors";
import { requireReportUser } from "@/lib/reports/auth";
import { completeBountyPhotoUpload } from "@/lib/bounties/photos";

export const maxDuration = 60;

export function POST(_req: Request, ctx: RouteContext<"/api/bounties/photos/[photoId]/complete">) {
  return reportingResponse(async () => {
    const userId = await requireReportUser("Sign in to upload a job photo.");
    const { photoId } = await ctx.params;
    if (!z.uuid().safeParse(photoId).success) throw new RequestError(400, "Invalid photo id");
    await completeBountyPhotoUpload(photoId, userId);
    return NextResponse.json({ photoId });
  }, "Bounty service");
}
