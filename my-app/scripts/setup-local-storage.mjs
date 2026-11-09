import nextEnv from "@next/env";
import { CreateBucketCommand, PutBucketCorsCommand, PutBucketLifecycleConfigurationCommand } from "@aws-sdk/client-s3";
import { storageConfig } from "./storage-config.mjs";

nextEnv.loadEnvConfig(process.cwd());
const endpoint = new URL(process.env.REPORTS_S3_ENDPOINT || "https://invalid.example");
if (!["localhost", "127.0.0.1"].includes(endpoint.hostname)) {
  throw new Error("This setup script is only for local object storage; configure production buckets separately.");
}
const { client, bucket } = storageConfig();
try {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
} catch (error) {
  if (!["BucketAlreadyOwnedByYou", "BucketAlreadyExists"].includes(error.name)) throw error;
}
// MinIO supplies CORS headers for its browser uploads itself; AWS bucket CORS is configured in production.
try {
  await client.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: [{
    AllowedOrigins: ["http://localhost:3000"], AllowedMethods: ["POST"], AllowedHeaders: ["*"], MaxAgeSeconds: 300,
  }] } }));
} catch (error) {
  if (error.name !== "NotImplemented") throw error;
}
await client.send(new PutBucketLifecycleConfigurationCommand({ Bucket: bucket, LifecycleConfiguration: {
  Rules: ["reports", "bounties"].map((scope) => ({ ID: `expire-${scope}-staging`, Status: "Enabled", Filter: { Prefix: `${scope}/staging/` }, Expiration: { Days: 1 } })),
} }));
console.log(`Local bucket ${bucket} is ready.`);
client.destroy();
