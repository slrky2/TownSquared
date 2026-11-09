import { NextResponse } from "next/server";
import { reportingResponse } from "@/lib/api/errors";
import { requireReportUser } from "@/lib/reports/auth";
import { beginBountyPhotoUpload } from "@/lib/bounties/photos";

export function POST() {
  return reportingResponse(async () => {
    const userId = await requireReportUser("Sign in to upload a job photo.");
    return NextResponse.json(await beginBountyPhotoUpload(userId), { status: 201 });
  }, "Bounty service");
}
