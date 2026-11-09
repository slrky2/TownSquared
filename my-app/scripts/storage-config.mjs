import { S3Client } from "@aws-sdk/client-s3";

export function storageConfig() {
  const bucket = process.env.REPORTS_S3_BUCKET;
  if (!bucket) throw new Error("Set REPORTS_S3_BUCKET");
  return {
    bucket,
    client: new S3Client({
      region: process.env.REPORTS_S3_REGION || "us-east-1",
      endpoint: process.env.REPORTS_S3_ENDPOINT || undefined,
      forcePathStyle: process.env.REPORTS_S3_FORCE_PATH_STYLE === "true",
      ...(process.env.REPORTS_S3_ACCESS_KEY_ID ? { credentials: {
        accessKeyId: process.env.REPORTS_S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.REPORTS_S3_SECRET_ACCESS_KEY || "",
      } } : {}),
      maxAttempts: 2,
    }),
  };
}
