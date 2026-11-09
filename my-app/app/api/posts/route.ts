import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { listPosts } from "@/lib/db/store";
import { reportingResponse } from "@/lib/api/errors";

export function GET() {
  return reportingResponse(async () => {
    const { userId } = await auth();
    return NextResponse.json({ posts: await listPosts(userId) }, { headers: { "Cache-Control": "private, no-store" } });
  });
}
