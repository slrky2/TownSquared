import { auth } from "@clerk/nextjs/server";
import { RequestError } from "@/lib/api/errors";

export async function requireReportUser(message = "Sign in to report, comment, or vote."): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new RequestError(401, message);
  return userId;
}
