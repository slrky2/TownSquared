import { randomUUID } from "node:crypto";
import { type Database } from "@/lib/db";
import { ensureReportUser } from "@/lib/db/store";
import { RequestError } from "@/lib/api/errors";
import { normalizeReportPhoto, type PhotoStorage } from "@/lib/reports/storage";

/** SQL identifiers come only from these fixed internal scopes, never from a request. */
export function createPhotoUploads(database: Database, storage: PhotoStorage, scope: "reports" | "bounties") {
  const table = scope === "reports" ? "report_photos" : "bounty_photos";
  const attachedColumn = scope === "reports" ? "report_id" : "bounty_id";
  return {
    async begin(userId: string) {
      const id = randomUUID();
      const stagingKey = `${scope}/staging/${id}.jpg`;
      const objectKey = `${scope}/photos/${id}.jpg`;
      await database.transaction(async (client) => {
        await ensureReportUser(client, userId);
        // A database lock makes upload quotas apply across app instances.
        await client.query("SELECT id FROM report_users WHERE id = $1 FOR UPDATE", [userId]);
        const count = await client.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${table}
          WHERE owner_id = $1 AND created_at > now() - interval '1 hour'`, [userId]);
        if (count.rows[0].count >= 20) throw new RequestError(429, "Photo upload limit reached. Try again in an hour.");
        await client.query(`INSERT INTO ${table} (id, owner_id, staging_key, object_key)
          VALUES ($1,$2,$3,$4)`, [id, userId, stagingKey, objectKey]);
      });
      const upload = await storage.signUpload(stagingKey);
      return { photoId: id, ...upload };
    },
    async complete(id: string, userId: string) {
      await database.transaction(async (client) => {
        const result = await client.query<{ staging_key: string; object_key: string; ready: boolean }>(`SELECT staging_key, object_key, ready FROM ${table}
          WHERE id = $1 AND owner_id = $2 AND (expires_at > now() OR ${attachedColumn} IS NOT NULL) FOR UPDATE`, [id, userId]);
        const photo = result.rows[0];
        if (!photo) throw new RequestError(404, "Photo upload not found or expired.");
        // Finalized objects are never overwritten, even if the signed staging upload is reused.
        if (photo.ready) return;
        const normalized = await normalizeReportPhoto(await storage.read(photo.staging_key));
        await storage.write(photo.object_key, normalized);
        await client.query(`UPDATE ${table} SET ready = true WHERE id = $1`, [id]);
      });
    },
  };
}
