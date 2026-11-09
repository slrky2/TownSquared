import { NextResponse } from "next/server";
import { addComment } from "@/lib/db/store";
import { commentSchema } from "@/lib/validators/issue";
import { readJson, reportingResponse, RequestError } from "@/lib/api/errors";
import { requireReportUser } from "@/lib/reports/auth";

export function POST(req: Request, ctx: RouteContext<"/api/issues/[issueId]/comments">) {
  return reportingResponse(async () => {
    const userId = await requireReportUser();
    const id = Number((await ctx.params).issueId);
    if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) throw new RequestError(400, "Invalid report id");
    const parsed = commentSchema.safeParse(await readJson(req));
    if (!parsed.success) throw new RequestError(400, parsed.error.issues[0]?.message ?? "Invalid comment");
    return NextResponse.json({ report: await addComment(id, userId, parsed.data.text) }, { status: 201 });
  });
}
