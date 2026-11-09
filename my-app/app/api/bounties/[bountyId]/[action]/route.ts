import { NextResponse } from "next/server";
import { getActor } from "@/lib/bounties/actor";
import { takeStep } from "@/lib/bounties/store";
import { bountyActionSchema } from "@/lib/validators/bounty";
import { reportingResponse, RequestError } from "@/lib/api/errors";

const SIGNED_OUT_MESSAGE = {
  claim: "Sign in to claim this job.", done: "Sign in to mark this job done.", approve: "Sign in to approve this payout.",
} as const;

export function POST(_req: Request, ctx: RouteContext<"/api/bounties/[bountyId]/[action]">) {
  return reportingResponse(async () => {
    const { bountyId, action } = await ctx.params;
    const step = bountyActionSchema.safeParse(action);
    const id = Number(bountyId);
    if (!step.success || !Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw new RequestError(404, "Not found");
    const actor = await getActor();
    if (!actor) throw new RequestError(401, SIGNED_OUT_MESSAGE[step.data]);
    return NextResponse.json({ bounty: await takeStep(actor, id, step.data) });
  }, "Bounty service");
}
