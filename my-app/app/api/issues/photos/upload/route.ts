import { NextResponse } from "next/server";
import { reportingResponse } from "@/lib/api/errors";
import { requireReportUser } from "@/lib/reports/auth";
import { beginPhotoUpload } from "@/lib/reports/photos";

export function POST() {
  return reportingResponse(async () => {
    const userId = await requireReportUser();
    return NextResponse.json(await beginPhotoUpload(userId), { status: 201 });
  });
}
