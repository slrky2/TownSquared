import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import sharp from "sharp";
import { RequestError } from "@/lib/api/errors";
import { REPORT_LIMITS } from "@/lib/utils/report";

export interface PhotoStorage {
  signUpload(key: string): Promise<{ url: string; fields: Record<string, string> }>;
  read(key: string): Promise<Buffer>;
  write(key: string, bytes: Buffer): Promise<void>;
  remove(key: string): Promise<void>;
}

let client: S3Client | undefined;
function config() {
  const bucket = process.env.REPORTS_S3_BUCKET;
  if (!bucket) throw new Error("REPORTS_S3_BUCKET is required for photos");
  client ??= new S3Client({
    region: process.env.REPORTS_S3_REGION || "us-east-1",
    endpoint: process.env.REPORTS_S3_ENDPOINT || undefined,
    forcePathStyle: process.env.REPORTS_S3_FORCE_PATH_STYLE === "true",
    // Production can also use the SDK's default IAM credential chain.
    ...(process.env.REPORTS_S3_ACCESS_KEY_ID ? { credentials: {
      accessKeyId: process.env.REPORTS_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.REPORTS_S3_SECRET_ACCESS_KEY || "",
    } } : {}),
    maxAttempts: 2,
  });
  return { client, bucket };
}

export const photoStorage: PhotoStorage = {
  async signUpload(key) {
    const { client, bucket } = config();
    return createPresignedPost(client, {
      Bucket: bucket, Key: key, Expires: 300,
      Fields: { "Content-Type": "image/jpeg" },
      Conditions: [
        ["content-length-range", 1, REPORT_LIMITS.maxPhotoBytes],
        ["eq", "$Content-Type", "image/jpeg"],
      ],
    });
  },
  async read(key) {
    const { client, bucket } = config();
    let response;
    try {
      response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(10_000) });
    } catch (error) {
      if (error instanceof Error && error.name === "NoSuchKey") throw new RequestError(422, "Photo upload not found. Upload it again.");
      throw error;
    }
    if (!response.Body) throw new RequestError(422, "Photo upload is empty.");
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > REPORT_LIMITS.maxPhotoBytes) throw new RequestError(422, "Photo is too large.");
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) {
      // Stop the underlying HTTP stream after rejecting an oversized object.
      if ("destroy" in response.Body && typeof response.Body.destroy === "function") response.Body.destroy();
      throw error;
    }
    return Buffer.concat(chunks);
  },
  async write(key, bytes) {
    const { client, bucket } = config();
    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: bytes, ContentType: "image/jpeg",
      CacheControl: "public, max-age=31536000, immutable",
    }), { abortSignal: AbortSignal.timeout(10_000) });
  },
  async remove(key) {
    const { client, bucket } = config();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(10_000) });
  },
};

/** Decode actual pixels, bound decompression, and strip metadata before publication. */
export async function normalizeReportPhoto(bytes: Buffer): Promise<Buffer> {
  if (!bytes.length || bytes.length > REPORT_LIMITS.maxPhotoBytes) throw new RequestError(422, "Photo is empty or too large.");
  try {
    const image = sharp(bytes, { limitInputPixels: 20_000_000, failOn: "warning" });
    const metadata = await image.metadata();
    if (metadata.format !== "jpeg") throw new Error("Not a JPEG");
    const normalized = await image.rotate().resize(1280, 1280, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    if (normalized.length > REPORT_LIMITS.maxPhotoBytes) throw new Error("Normalized photo is too large");
    return normalized;
  } catch {
    throw new RequestError(422, "Photo could not be decoded as a JPEG. Choose another image.");
  }
}
