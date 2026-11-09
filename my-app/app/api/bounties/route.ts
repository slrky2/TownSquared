import { NextResponse } from "next/server";
import { getActor } from "@/lib/bounties/actor";
import { getViewer, listBounties, postBounty } from "@/lib/bounties/store";
import { createBountySchema } from "@/lib/validators/bounty";
import { readJson, reportingResponse, RequestError } from "@/lib/api/errors";
import type { BountiesResponse } from "@/types";

export function GET() {
  return reportingResponse(async () => {
    const actor = await getActor();
    const viewer = actor ? await getViewer(actor) : null;
    const body: BountiesResponse = { bounties: await listBounties(actor), viewer };
    return NextResponse.json(body, { headers: { "Cache-Control": "private, no-store" } });
  }, "Bounty service");
}

export function POST(req: Request) {
  return reportingResponse(async () => {
    const actor = await getActor();
    if (!actor) throw new RequestError(401, "Sign in to post a job.");
    const parsed = createBountySchema.safeParse(await readJson(req));
    if (!parsed.success) throw new RequestError(422, parsed.error.issues[0]?.message ?? "Invalid request");
    return NextResponse.json({ bounty: await postBounty(actor, parsed.data) }, { status: 201 });
  }, "Bounty service");
}
