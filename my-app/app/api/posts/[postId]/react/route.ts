import { NextResponse } from "next/server";
import { toggleReaction } from "@/lib/db/store";
import { reportingResponse, RequestError } from "@/lib/api/errors";
import { requireReportUser } from "@/lib/reports/auth";

export function POST(_req: Request, ctx: RouteContext<"/api/posts/[postId]/react">) {
  return reportingResponse(async () => {
    const userId = await requireReportUser();
    const id = Number((await ctx.params).postId);
    if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) throw new RequestError(400, "Invalid post id");
    return NextResponse.json({ post: await toggleReaction(id, userId) });
  });
}
