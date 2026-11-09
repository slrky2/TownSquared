import { NextResponse } from "next/server";
import { getProfile } from "@/lib/bounties/store";
import { reportingResponse, RequestError } from "@/lib/api/errors";

export function GET(_req: Request, ctx: RouteContext<"/api/profiles/[profileId]">) {
  return reportingResponse(async () => {
    const { profileId } = await ctx.params;
    const profile = /^[a-z0-9-]{1,40}$/.test(profileId) ? await getProfile(profileId) : null;
    if (!profile) throw new RequestError(404, "We couldn't find that person.");
    return NextResponse.json({ profile });
  }, "Bounty service");
}
