import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { createReport, listReports } from "@/lib/db/store";
import { createReportSchema } from "@/lib/validators/issue";
import { readJson, reportingResponse, RequestError } from "@/lib/api/errors";
import { requireReportUser } from "@/lib/reports/auth";

export function GET() {
  return reportingResponse(async () => {
    const { userId } = await auth();
    return NextResponse.json({ reports: await listReports(userId) }, { headers: { "Cache-Control": "private, no-store" } });
  });
}

export function POST(req: Request) {
  return reportingResponse(async () => {
    const userId = await requireReportUser();
    const parsed = createReportSchema.safeParse(await readJson(req));
    if (!parsed.success) throw new RequestError(400, parsed.error.issues[0]?.message ?? "Invalid report");
    return NextResponse.json(await createReport(parsed.data, userId), { status: 201 });
  });
}
