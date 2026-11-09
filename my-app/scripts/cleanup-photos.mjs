import nextEnv from "@next/env";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import pg from "pg";
import { storageConfig } from "./storage-config.mjs";

nextEnv.loadEnvConfig(process.cwd());
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000 });
const storage = storageConfig();
await client.connect();
let removed = 0;
try {
  // Each deletion holds the same photo lock as attachment/finalization. Only expired,
  // unattached drafts are eligible, never published report or bounty photos.
  for (const [table, attachedColumn] of [["report_photos", "report_id"], ["bounty_photos", "bounty_id"]]) {
    while (true) {
      await client.query("BEGIN");
      try {
        const result = await client.query(`SELECT id, staging_key, object_key FROM ${table}
          WHERE ${attachedColumn} IS NULL AND expires_at < now() ORDER BY expires_at
          LIMIT 1 FOR UPDATE SKIP LOCKED`);
        const photo = result.rows[0];
        if (!photo) { await client.query("COMMIT"); break; }
        for (const key of [photo.staging_key, photo.object_key]) {
          await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }), { abortSignal: AbortSignal.timeout(10_000) });
        }
        await client.query(`DELETE FROM ${table} WHERE id = $1`, [photo.id]);
        await client.query("COMMIT");
        removed++;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  }
  console.log(`Removed ${removed} expired, unattached photo drafts.`);
} finally {
  await client.end();
  storage.client.destroy();
}
