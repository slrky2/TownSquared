import { randomUUID } from "node:crypto";
import db, { type Database, type SqlClient } from "./index";
import { RequestError } from "@/lib/api/errors";
import type { NewReport } from "@/lib/validators/issue";
import type { CityPost, CityReport } from "@/types";

const photoUrl = (id: string) => `/api/issues/photos/${id}`;
const iso = (date: Date | string) => new Date(date).toISOString();

type ReportRow = {
  id: number; title: string; description: string; category: CityReport["category"];
  severity: CityReport["severity"]; lat: number; lng: number; location: string;
  author_id: string; author_name: string; created_at: Date | string;
  photo_ids: string[]; upvotes: number; has_upvoted: boolean;
  reactions: number; has_reacted: boolean;
  comments: Array<{ id: string; author_id: string; author_name: string; text: string; created_at: string }>;
};

// Aggregate each relation separately so votes/comments/photos cannot multiply counts.
const REPORT_SELECT = `SELECT r.*, 'neighbor_' || u.public_number AS author_name,
  ARRAY(SELECT p.id::text FROM report_photos p WHERE p.report_id = r.id ORDER BY p.position) AS photo_ids,
  (SELECT count(*)::integer FROM report_votes v WHERE v.report_id = r.id) AS upvotes,
  EXISTS(SELECT 1 FROM report_votes v WHERE v.report_id = r.id AND v.user_id = $1) AS has_upvoted,
  (SELECT count(*)::integer FROM report_reactions v WHERE v.report_id = r.id) AS reactions,
  EXISTS(SELECT 1 FROM report_reactions v WHERE v.report_id = r.id AND v.user_id = $1) AS has_reacted,
  COALESCE((SELECT json_agg(c ORDER BY c.created_at, c.id) FROM (
    SELECT c.id, c.author_id, c.text, c.created_at, 'neighbor_' || cu.public_number AS author_name
    FROM report_comments c JOIN report_users cu ON cu.id = c.author_id WHERE c.report_id = r.id
  ) c), '[]'::json) AS comments
  FROM reports r JOIN report_users u ON u.id = r.author_id`;

function toReport(row: ReportRow, userId: string | null): CityReport {
  return {
    id: row.id, title: row.title, description: row.description,
    category: row.category, severity: row.severity, lat: row.lat, lng: row.lng,
    location: row.location, photoUrls: row.photo_ids.map(photoUrl),
    authorName: row.author_name, isMine: row.author_id === userId,
    reportedAt: iso(row.created_at), upvotes: row.upvotes, hasUpvoted: row.has_upvoted,
    comments: row.comments.map((c) => ({
      id: c.id, authorName: c.author_name, text: c.text,
      createdAt: iso(c.created_at), isMine: c.author_id === userId,
    })),
  };
}

function toPost(row: ReportRow, userId: string | null): CityPost {
  return {
    id: row.id, issueId: row.id, kind: "report", title: row.title, caption: row.description,
    author: { name: row.author_name, type: "resident", subtitle: `Reported a ${row.category.toLowerCase()} problem` },
    location: row.location, coords: { lat: row.lat, lng: row.lng },
    photoUrls: row.photo_ids.map(photoUrl), postedAt: iso(row.created_at),
    reactions: row.reactions, hasReacted: row.has_reacted, isMine: row.author_id === userId,
  };
}

export async function ensureReportUser(client: SqlClient, userId: string) {
  await client.query("INSERT INTO report_users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [userId]);
}

/** Dependency injection lets the same SQL run against PostgreSQL in production and tests. */
export function reportingStore(database: Database) {
  async function row(client: SqlClient, id: number, userId: string | null) {
    const result = await client.query<ReportRow>(`${REPORT_SELECT} WHERE r.id = $2`, [userId, id]);
    if (!result.rows[0]) throw new RequestError(404, "Report not found.");
    return result.rows[0];
  }

  async function lockReport(client: SqlClient, id: number) {
    const result = await client.query("SELECT id FROM reports WHERE id = $1 FOR UPDATE", [id]);
    if (!result.rows.length) throw new RequestError(404, "Report not found.");
  }

  return {
    async listReports(userId: string | null) {
      const result = await database.query<ReportRow>(`${REPORT_SELECT} ORDER BY r.created_at DESC, r.id DESC`, [userId]);
      return result.rows.map((r) => toReport(r, userId));
    },
    async listPosts(userId: string | null) {
      const result = await database.query<ReportRow>(`${REPORT_SELECT} ORDER BY r.created_at DESC, r.id DESC`, [userId]);
      return result.rows.map((r) => toPost(r, userId));
    },
    async createReport(input: NewReport, userId: string) {
      return database.transaction(async (client) => {
        await ensureReportUser(client, userId);
        // Lock in stable order to avoid deadlocks when requests share photo ids.
        if (input.photoIds.length) {
          const photos = await client.query(`SELECT id FROM report_photos
            WHERE id = ANY($1::uuid[]) AND owner_id = $2 AND report_id IS NULL
            AND ready AND expires_at > now() ORDER BY id FOR UPDATE`, [input.photoIds, userId]);
          if (photos.rows.length !== input.photoIds.length) {
            throw new RequestError(422, "A photo is unavailable, expired, or belongs to another user. Upload it again.");
          }
        }
        const sentence = input.description.split(/(?<=[.!?])\s|\n/)[0].trim();
        const title = sentence.length <= 80 ? sentence : `${sentence.slice(0, 79).trimEnd()}…`;
        const created = await client.query<{ id: number }>(`INSERT INTO reports
          (author_id, title, description, category, severity, lat, lng, location)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [
          userId, title, input.description, input.category, input.severity, input.lat, input.lng,
          input.locationDetails || `${input.lat.toFixed(4)}, ${input.lng.toFixed(4)}`,
        ]);
        const id = created.rows[0].id;
        for (const [position, photoId] of input.photoIds.entries()) {
          await client.query("UPDATE report_photos SET report_id = $1, position = $2 WHERE id = $3", [id, position, photoId]);
        }
        // Feed posts are a projection of reports, so both become visible atomically.
        const createdRow = await row(client, id, userId);
        return { report: toReport(createdRow, userId), post: toPost(createdRow, userId) };
      });
    },
    async toggleUpvote(id: number, userId: string) {
      return database.transaction(async (client) => {
        await ensureReportUser(client, userId);
        await lockReport(client, id);
        const removed = await client.query("DELETE FROM report_votes WHERE report_id = $1 AND user_id = $2 RETURNING user_id", [id, userId]);
        if (!removed.rows.length) await client.query("INSERT INTO report_votes (report_id, user_id) VALUES ($1,$2)", [id, userId]);
        return toReport(await row(client, id, userId), userId);
      });
    },
    async addComment(id: number, userId: string, text: string) {
      return database.transaction(async (client) => {
        await ensureReportUser(client, userId);
        await lockReport(client, id);
        const count = await client.query<{ count: number }>("SELECT count(*)::integer AS count FROM report_comments WHERE report_id = $1", [id]);
        if (count.rows[0].count >= 200) throw new RequestError(409, "This report has reached its comment limit.");
        await client.query("INSERT INTO report_comments (id, report_id, author_id, text) VALUES ($1,$2,$3,$4)", [randomUUID(), id, userId, text]);
        return toReport(await row(client, id, userId), userId);
      });
    },
    async toggleReaction(id: number, userId: string) {
      return database.transaction(async (client) => {
        await ensureReportUser(client, userId);
        await lockReport(client, id);
        const removed = await client.query("DELETE FROM report_reactions WHERE report_id = $1 AND user_id = $2 RETURNING user_id", [id, userId]);
        if (!removed.rows.length) await client.query("INSERT INTO report_reactions (report_id, user_id) VALUES ($1,$2)", [id, userId]);
        return toPost(await row(client, id, userId), userId);
      });
    },
    async getPhotoKey(id: string) {
      const result = await database.query<{ object_key: string }>("SELECT object_key FROM report_photos WHERE id = $1 AND report_id IS NOT NULL AND ready", [id]);
      return result.rows[0]?.object_key ?? null;
    },
  };
}

export const { listReports, listPosts, createReport, toggleUpvote, addComment, toggleReaction, getPhotoKey } = reportingStore(db);
