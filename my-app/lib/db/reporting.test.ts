import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import { reportingStore } from "./store";
import type { Database } from "./index";
import { reportPhotos } from "@/lib/reports/photos";
import { normalizeReportPhoto, type PhotoStorage } from "@/lib/reports/storage";
import { createReportSchema } from "@/lib/validators/issue";

const migration = await readFile(new URL("../../migrations/001_reporting.sql", import.meta.url), "utf8");
const reportInput = () => createReportSchema.parse({
  description: "A deep pothole near the intersection. Please inspect.",
  category: "Roads", severity: "High", lat: 42.64, lng: -71.31,
});

function databaseFor(pg: PGlite): Database {
  return {
    query: (sql, values) => pg.query(sql, values),
    transaction: (work) => pg.transaction((tx) => work({ query: (sql, values) => tx.query(sql, values) })),
  };
}

describe("persistent reporting SQL and photo lifecycle", () => {
  let pg: PGlite;
  let database: Database;
  let store: ReturnType<typeof reportingStore>;
  let photos: ReturnType<typeof reportPhotos>;
  const objects = new Map<string, Buffer>();
  const storage: PhotoStorage = {
    signUpload: async () => ({ url: "https://storage.example/upload", fields: {} }),
    read: async (key) => {
      const bytes = objects.get(key);
      if (!bytes) throw new Error("Object not found");
      return bytes;
    },
    write: async (key, bytes) => { objects.set(key, bytes); },
    remove: async (key) => { objects.delete(key); },
  };
  let jpeg: Buffer;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(migration);
    database = databaseFor(pg);
    store = reportingStore(database);
    photos = reportPhotos(database, storage);
    jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: "red" } }).jpeg().toBuffer();
  }, 30_000);
  beforeEach(async () => {
    objects.clear();
    await pg.exec("TRUNCATE report_users, reports, report_photos, report_comments, report_votes, report_reactions RESTART IDENTITY CASCADE");
  });
  afterAll(async () => { await pg?.close(); });

  async function readyPhoto(owner = "user_alice") {
    const { photoId } = await photos.begin(owner);
    objects.set(`reports/staging/${photoId}.jpg`, jpeg);
    await photos.complete(photoId, owner);
    return photoId;
  }

  it("starts empty, creates the report/feed together, and keeps internal identity private", async () => {
    expect(await store.listReports(null)).toEqual([]);
    const { report, post } = await store.createReport(reportInput(), "user_alice");
    expect(report.isMine).toBe(true);
    expect(post.issueId).toBe(report.id);
    expect(post.photoUrls).toEqual([]);
    expect((await store.listReports("user_bob"))[0].isMine).toBe(false);
    expect(await store.listPosts(null)).toMatchObject([{ issueId: report.id, isMine: false }]);
    expect(JSON.stringify(await store.listReports(null))).not.toContain("user_alice");
  });

  it("persists comments/votes/reactions with account-specific state and exact counts", async () => {
    const { report } = await store.createReport(reportInput(), "user_alice");
    await store.toggleUpvote(report.id, "user_bob");
    await store.toggleUpvote(report.id, "user_alice");
    await store.toggleReaction(report.id, "user_bob");
    await store.addComment(report.id, "user_bob", "Also saw it today");
    await store.addComment(report.id, "user_alice", "Thank you for checking");
    const fromNewInstance = reportingStore(database);
    expect((await fromNewInstance.listReports("user_bob"))[0]).toMatchObject({
      upvotes: 2, hasUpvoted: true, isMine: false,
      comments: [{ isMine: true }, { isMine: false }],
    });
    expect((await fromNewInstance.listPosts("user_bob"))[0]).toMatchObject({ reactions: 1, hasReacted: true });
    expect((await store.listReports(null))[0]).toMatchObject({ hasUpvoted: false });
    await store.toggleUpvote(report.id, "user_bob");
    expect((await store.listReports("user_bob"))[0]).toMatchObject({ upvotes: 1, hasUpvoted: false });
    await store.toggleReaction(report.id, "user_bob");
    expect((await store.listPosts("user_bob"))[0]).toMatchObject({ reactions: 0, hasReacted: false });
  });

  it("serializes concurrent vote toggles without duplicate account votes", async () => {
    const { report } = await store.createReport(reportInput(), "user_alice");
    await Promise.all(Array.from({ length: 5 }, () => store.toggleUpvote(report.id, "user_bob")));
    expect((await store.listReports("user_bob"))[0]).toMatchObject({ upvotes: 1, hasUpvoted: true });
  });

  it("does not publish drafts; attaches normalized owned photos in order", async () => {
    const first = await readyPhoto();
    const second = await readyPhoto();
    expect(await store.getPhotoKey(first)).toBeNull();
    const { report, post } = await store.createReport({ ...reportInput(), photoIds: [second, first] }, "user_alice");
    expect(report.photoUrls).toEqual([`/api/issues/photos/${second}`, `/api/issues/photos/${first}`]);
    expect(post.photoUrls).toEqual(report.photoUrls);
    expect(await store.getPhotoKey(first)).toBe(`reports/photos/${first}.jpg`);
  });

  it("rejects cross-account completion/attachment, and rolls back report creation", async () => {
    const id = await readyPhoto();
    await expect(photos.complete(id, "user_bob")).rejects.toMatchObject({ status: 404 });
    await expect(store.createReport({ ...reportInput(), photoIds: [id] }, "user_bob")).rejects.toMatchObject({ status: 422 });
    expect(await store.listReports(null)).toEqual([]);
    expect(await store.getPhotoKey(id)).toBeNull();
  });

  it("rejects incomplete, expired, missing, and already-attached photos", async () => {
    const draft = await photos.begin("user_alice");
    await expect(store.createReport({ ...reportInput(), photoIds: [draft.photoId] }, "user_alice")).rejects.toMatchObject({ status: 422 });
    const expired = await readyPhoto();
    await pg.query("UPDATE report_photos SET expires_at = now() - interval '1 second' WHERE id = $1", [expired]);
    await expect(store.createReport({ ...reportInput(), photoIds: [expired] }, "user_alice")).rejects.toMatchObject({ status: 422 });
    await expect(store.createReport({ ...reportInput(), photoIds: ["12345678-1234-4123-8123-123456789012"] }, "user_alice")).rejects.toMatchObject({ status: 422 });
    const attached = await readyPhoto();
    await store.createReport({ ...reportInput(), photoIds: [attached] }, "user_alice");
    await expect(store.createReport({ ...reportInput(), photoIds: [attached] }, "user_alice")).rejects.toMatchObject({ status: 422 });
    expect(await store.listReports(null)).toHaveLength(1);
  });

  it("only attaches a photo once when two report submissions race", async () => {
    const id = await readyPhoto();
    const results = await Promise.allSettled([
      store.createReport({ ...reportInput(), photoIds: [id] }, "user_alice"),
      store.createReport({ ...reportInput(), photoIds: [id] }, "user_alice"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await store.listReports(null)).toHaveLength(1);
  });

  it("rejects fake JPEGs and leaves failed storage writes unready", async () => {
    const { photoId } = await photos.begin("user_alice");
    objects.set(`reports/staging/${photoId}.jpg`, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    await expect(photos.complete(photoId, "user_alice")).rejects.toMatchObject({ status: 422 });
    const failing = reportPhotos(database, { ...storage, write: async () => { throw new Error("S3 unavailable"); } });
    objects.set(`reports/staging/${photoId}.jpg`, jpeg);
    await expect(failing.complete(photoId, "user_alice")).rejects.toThrow("S3 unavailable");
    await expect(store.createReport({ ...reportInput(), photoIds: [photoId] }, "user_alice")).rejects.toMatchObject({ status: 422 });
  });

  it("never overwrites a finalized image after staging-upload replay", async () => {
    const id = await readyPhoto();
    const key = `reports/photos/${id}.jpg`;
    const original = objects.get(key);
    objects.set(`reports/staging/${id}.jpg`, Buffer.from("changed upload"));
    await photos.complete(id, "user_alice");
    expect(objects.get(key)).toEqual(original);
  });

  it("enforces upload quotas across service instances", async () => {
    for (let index = 0; index < 20; index++) await photos.begin("user_alice");
    await expect(reportPhotos(database, storage).begin("user_alice")).rejects.toMatchObject({ status: 429 });
    await expect(photos.begin("user_bob")).resolves.toHaveProperty("photoId");
  });

  it("enforces comment limits and returns 404 for missing report mutations", async () => {
    const { report } = await store.createReport(reportInput(), "user_alice");
    await pg.query(`INSERT INTO report_comments (id, report_id, author_id, text)
      SELECT md5(i::text)::uuid, $1, 'user_alice', 'Existing comment' FROM generate_series(1, 200) i`, [report.id]);
    await expect(store.addComment(report.id, "user_bob", "One more")).rejects.toMatchObject({ status: 409 });
    await expect(store.addComment(9999, "user_bob", "Missing report")).rejects.toMatchObject({ status: 404 });
    await expect(store.toggleUpvote(9999, "user_bob")).rejects.toMatchObject({ status: 404 });
    await expect(store.toggleReaction(9999, "user_bob")).rejects.toMatchObject({ status: 404 });
  });

  it("strips EXIF and rejects non-JPEG or oversized payloads", async () => {
    const withExif = await sharp(jpeg).withMetadata({ exif: { IFD0: { Artist: "Private metadata" } } }).jpeg().toBuffer();
    const normalized = await normalizeReportPhoto(withExif);
    expect((await sharp(normalized).metadata()).exif).toBeUndefined();
    const png = await sharp(jpeg).png().toBuffer();
    await expect(normalizeReportPhoto(png)).rejects.toMatchObject({ status: 422 });
    await expect(normalizeReportPhoto(Buffer.alloc(1_500_001))).rejects.toMatchObject({ status: 422 });
  });
});

it("retains report, comment, votes, reactions and photo associations after database close/reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civic-reporting-test-"));
  let pg: PGlite | undefined;
  try {
    pg = new PGlite(directory);
    await pg.exec(migration);
    let store = reportingStore(databaseFor(pg));
    // An object-storage key is persisted; image bytes are deliberately not stored in PostgreSQL.
    await pg.query("INSERT INTO report_users (id) VALUES ('user_alice')");
    const photoId = "12345678-1234-4123-8123-123456789012";
    await pg.query(`INSERT INTO report_photos (id, owner_id, staging_key, object_key, ready)
      VALUES ($1, 'user_alice', 'reports/staging/test.jpg', 'reports/photos/test.jpg', true)`, [photoId]);
    const { report } = await store.createReport({ ...reportInput(), photoIds: [photoId] }, "user_alice");
    await store.addComment(report.id, "user_bob", "Still here after restart");
    await store.toggleUpvote(report.id, "user_bob");
    await store.toggleReaction(report.id, "user_bob");
    await pg.close();
    pg = new PGlite(directory);
    store = reportingStore(databaseFor(pg));
    expect((await store.listReports("user_bob"))[0]).toMatchObject({
      id: report.id, isMine: false, upvotes: 1, hasUpvoted: true,
      photoUrls: [`/api/issues/photos/${photoId}`],
      comments: [{ text: "Still here after restart", isMine: true }],
    });
    expect((await store.listPosts("user_bob"))[0]).toMatchObject({ issueId: report.id, reactions: 1, hasReacted: true });
    expect(await store.getPhotoKey(photoId)).toBe("reports/photos/test.jpg");
  } finally {
    await pg?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
