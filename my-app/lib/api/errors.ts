import { NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";

export class RequestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Bound JSON reads even when Content-Length is missing or incorrect. */
export async function readJson(request: Request, maxBytes = 16_384): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, "A JSON body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RequestError(413, "Request is too large.");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, "Invalid JSON.");
  } finally {
    reader.releaseLock();
  }
}

export async function reportingResponse(work: () => Promise<Response>, service = "Reporting"): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    // Preserve Next.js request-time/prerender control flow instead of turning it into a 503.
    unstable_rethrow(error);
    if (error instanceof RequestError) {
      return NextResponse.json({ message: error.message }, { status: error.status });
    }
    console.error(`${service} request failed`, error instanceof Error ? error.name : "Unknown error");
    return NextResponse.json({ message: `${service} is temporarily unavailable. Please try again.` }, { status: 503 });
  }
}
