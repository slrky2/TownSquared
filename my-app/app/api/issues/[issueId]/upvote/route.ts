import { NextResponse } from "next/server";
import { toggleUpvote } from "@/lib/db/store";
import { reportingResponse, RequestError } from "@/lib/api/errors";
import { requireReportUser } from "@/lib/reports/auth";

export function POST(_req: Request, ctx: RouteContext<"/api/issues/[issueId]/upvote">) {
  return reportingResponse(async () => {
    const userId = await requireReportUser();
    const id = Number((await ctx.params).issueId);
    if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) throw new RequestError(400, "Invalid report id");
    return NextResponse.json({ report: await toggleUpvote(id, userId) });
  });
}
