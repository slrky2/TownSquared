import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { bountyStore, type Actor } from "./store";
import { createBountySchema } from "@/lib/validators/bounty";
import { createPhotoUploads } from "@/lib/photos/uploads";
import { reportPhotos } from "@/lib/reports/photos";
import type { PhotoStorage } from "@/lib/reports/storage";
import type { Database } from "@/lib/db";
import sharp from "sharp";

const migrations = await Promise.all(["001_reporting.sql", "002_bounties.sql"].map((name) =>
  readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8")));
const alice: Actor = { id: "user_alice", name: "Alice A.", isCityStaff: false };
const bob: Actor = { id: "user_bob", name: "Bob B.", isCityStaff: false };
const carol: Actor = { id: "user_carol", name: "Carol C.", isCityStaff: false };
const staff: Actor = { id: "user_staff", name: "City Staff", isCityStaff: true };
const input = (extra = {}) => createBountySchema.parse({ title: "Rake leaves", reward: 20, place: "Lowell", ...extra });

function databaseFor(pg: PGlite): Database {
  return {
    query: (sql, values) => pg.query(sql, values),
    transaction: (work) => pg.transaction((tx) => work({ query: (sql, values) => tx.query(sql, values) })),
  };
}

describe("persistent bounties and simulated wallets", () => {
  let pg: PGlite;
  let database: Database;
  let store: ReturnType<typeof bountyStore>;
  const objects = new Map<string, Buffer>();
  const storage: PhotoStorage = {
    signUpload: async () => ({ url: "https://storage.example", fields: {} }),
    read: async (key) => { const bytes = objects.get(key); if (!bytes) throw new Error("Missing object"); return bytes; },
    write: async (key, bytes) => { objects.set(key, bytes); },
    remove: async (key) => { objects.delete(key); },
  };
  let jpeg: Buffer;

  beforeAll(async () => {
    pg = new PGlite();
    for (const sql of migrations) await pg.exec(sql);
    database = databaseFor(pg);
    store = bountyStore(database);
    jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).jpeg().toBuffer();
  }, 30_000);
  beforeEach(async () => {
    objects.clear();
    await pg.exec("TRUNCATE bounty_events, bounty_wallet_entries, bounty_photos, bounties, bounty_wallets, bounty_people, report_users CASCADE");
  });
  afterAll(async () => { await pg?.close(); });

  async function readyPhoto(owner = alice.id) {
    const photos = createPhotoUploads(database, storage, "bounties");
    const { photoId } = await photos.begin(owner);
    objects.set(`bounties/staging/${photoId}.jpg`, jpeg);
    await photos.complete(photoId, owner);
    return photoId;
  }

  it("starts empty and grants the initial balance only once across store instances", async () => {
    expect(await store.listBounties(null)).toEqual([]);
    await Promise.all(Array.from({ length: 3 }, () => store.getViewer(alice)));
    expect((await bountyStore(database).getViewer(alice)).wallet).toBe(35);
    const grants = await pg.query("SELECT * FROM bounty_wallet_entries WHERE user_id = $1 AND kind = 'opening'", [alice.id]);
    expect(grants.rows).toHaveLength(1);
  });

  it("holds the reward, completes the workflow, and credits the worker once", async () => {
    const job = await store.postBounty(alice, input());
    expect(job).toMatchObject({ status: "open", mine: "posted", reward: 20 });
    expect((await store.getViewer(alice)).wallet).toBe(15);
    expect(await store.takeStep(bob, job.id, "claim")).toMatchObject({ status: "claimed", mine: "claimed", viewerCan: "done" });
    await store.takeStep(bob, job.id, "done");
    expect(await store.takeStep(alice, job.id, "approve")).toMatchObject({ status: "paid" });
    expect((await store.getViewer(bob)).wallet).toBe(55);
    await expect(store.takeStep(alice, job.id, "approve")).rejects.toMatchObject({ status: 409 });
    expect((await store.getViewer(bob)).wallet).toBe(55);
    const events = await pg.query<{ action: string }>("SELECT action FROM bounty_events WHERE bounty_id = $1 ORDER BY id", [job.id]);
    expect(events.rows.map((r) => r.action)).toEqual(["post", "claim", "done", "approve"]);
    const entries = await pg.query<{ balance: string; ledger: string }>(`SELECT w.balance_cents AS balance,
      (SELECT sum(amount_cents)::text FROM bounty_wallet_entries e WHERE e.user_id = w.user_id) AS ledger
      FROM bounty_wallets w`);
    for (const entry of entries.rows) expect(Number(entry.balance)).toBe(Number(entry.ledger));
  });

  it("enforces poster, worker and staff authorization", async () => {
    const job = await store.postBounty(alice, input());
    await expect(store.takeStep(alice, job.id, "claim")).rejects.toMatchObject({ status: 409 });
    await expect(store.takeStep(bob, job.id, "done")).rejects.toMatchObject({ status: 409 });
    await store.takeStep(bob, job.id, "claim");
    await expect(store.takeStep(carol, job.id, "done")).rejects.toMatchObject({ status: 409 });
    await store.takeStep(bob, job.id, "done");
    await expect(store.takeStep(carol, job.id, "approve")).rejects.toMatchObject({ status: 403 });
    await expect(store.takeStep(staff, job.id, "approve")).rejects.toMatchObject({ status: 403 });
    await expect(store.postBounty(alice, input({ asCity: true }))).rejects.toMatchObject({ status: 403 });
    await expect(store.takeStep(alice, 2147483647, "claim")).rejects.toMatchObject({ status: 404 });
  });

  it("supports city jobs without debiting the staff wallet and keeps city approval restricted", async () => {
    const job = await store.postBounty(staff, input({ asCity: true, reward: 50 }));
    expect(job).toMatchObject({ postedByCity: true, posterProfileId: "city" });
    expect((await store.getViewer(staff)).wallet).toBe(35);
    await expect(store.takeStep(staff, job.id, "claim")).rejects.toMatchObject({ status: 409 });
    await store.takeStep(bob, job.id, "claim");
    await store.takeStep(bob, job.id, "done");
    await expect(store.takeStep(alice, job.id, "approve")).rejects.toMatchObject({ status: 403 });
    await store.takeStep(staff, job.id, "approve");
    expect((await store.getViewer(bob)).wallet).toBe(85);
  });

  it("serializes competing claims, approvals, and spending attempts", async () => {
    const job = await store.postBounty(alice, input());
    const claims = await Promise.allSettled([store.takeStep(bob, job.id, "claim"), store.takeStep(carol, job.id, "claim")]);
    expect(claims.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const worker = claims[0].status === "fulfilled" ? bob : carol;
    await store.takeStep(worker, job.id, "done");
    const approvals = await Promise.allSettled([store.takeStep(alice, job.id, "approve"), store.takeStep(alice, job.id, "approve")]);
    expect(approvals.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await store.getViewer(worker)).wallet).toBe(55);
    const spending = await Promise.allSettled([store.postBounty(staff, input()), store.postBounty(staff, input())]);
    expect(spending.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await store.getViewer(staff)).wallet).toBe(15);
  });

  it("rolls back held funds and job creation when the transaction fails", async () => {
    await store.getViewer(alice);
    await pg.exec(`CREATE FUNCTION reject_bounty_event() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'test failure'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_reject_event BEFORE INSERT ON bounty_events FOR EACH ROW EXECUTE FUNCTION reject_bounty_event()`);
    try {
      await expect(store.postBounty(alice, input())).rejects.toThrow("test failure");
      expect((await store.getViewer(alice)).wallet).toBe(35);
      expect(await store.listBounties(null)).toEqual([]);
      expect((await pg.query("SELECT * FROM bounty_wallet_entries WHERE kind = 'hold'")).rows).toHaveLength(0);
    } finally {
      await pg.exec("DROP TRIGGER test_reject_event ON bounty_events; DROP FUNCTION reject_bounty_event()");
    }
  });

  it("rolls back a payout if its audit write fails", async () => {
    const job = await store.postBounty(alice, input());
    await store.takeStep(bob, job.id, "claim");
    await store.takeStep(bob, job.id, "done");
    // Force a uniqueness failure after the wallet update to exercise rollback.
    await pg.query("INSERT INTO bounty_events (bounty_id, actor_id, action) VALUES ($1,$2,'approve')", [job.id, alice.id]);
    await expect(store.takeStep(alice, job.id, "approve")).rejects.toThrow();
    expect((await store.getViewer(bob)).wallet).toBe(35);
    expect((await store.listBounties(null))[0].status).toBe("done");
    expect((await pg.query("SELECT * FROM bounty_wallet_entries WHERE kind = 'payout'")).rows).toHaveLength(0);
  });

  it("attaches owned, validated photos once and never publishes draft images", async () => {
    const id = await readyPhoto();
    expect(await store.getImageKey(id)).toBeNull();
    await expect(store.postBounty(bob, input({ photoId: id }))).rejects.toMatchObject({ status: 422 });
    const job = await store.postBounty(alice, input({ photoId: id }));
    expect(job.imageUrl).toBe(`/api/bounty-images/${id}`);
    expect(await store.getImageKey(id)).toBe(`bounties/photos/${id}.jpg`);
    await expect(store.postBounty(alice, input({ photoId: id, reward: 1 }))).rejects.toMatchObject({ status: 422 });
    expect((await store.getViewer(alice)).wallet).toBe(15);
  });

  it("rejects incomplete/expired photos and cannot attach a report photo", async () => {
    const uploads = createPhotoUploads(database, storage, "bounties");
    const draft = await uploads.begin(alice.id);
    await expect(store.postBounty(alice, input({ photoId: draft.photoId }))).rejects.toMatchObject({ status: 422 });
    const id = await readyPhoto();
    await pg.query("UPDATE bounty_photos SET expires_at = now() - interval '1 second' WHERE id = $1", [id]);
    await expect(store.postBounty(alice, input({ photoId: id }))).rejects.toMatchObject({ status: 422 });
    const report = await reportPhotos(database, storage).begin(alice.id);
    await expect(store.postBounty(alice, input({ photoId: report.photoId }))).rejects.toMatchObject({ status: 422 });
    expect(await store.listBounties(null)).toEqual([]);
  });

  it("keeps profile IDs stable, updates names, and exposes counts without internal IDs", async () => {
    const job = await store.postBounty(alice, input());
    await store.getViewer({ ...alice, name: "New Name" });
    const updated = (await bountyStore(database).listBounties(null))[0];
    expect(updated.posterProfileId).toBe(job.posterProfileId);
    expect(await store.getProfile(job.posterProfileId)).toMatchObject({ name: "New Name", jobsPosted: 1, jobsCompleted: 0 });
    expect(await store.getProfile("missing")).toBeNull();
    await store.takeStep(bob, job.id, "claim");
    await store.takeStep(bob, job.id, "done");
    await store.takeStep(alice, job.id, "approve");
    const worker = await pg.query<{ public_id: string }>("SELECT public_id FROM bounty_people WHERE id = $1", [bob.id]);
    expect(await store.getProfile(worker.rows[0].public_id)).toMatchObject({ jobsCompleted: 1 });
    expect(JSON.stringify(await store.listBounties(null))).not.toContain("user_");
  });

  it("rejects city repairs, insufficient funds, forged input and fractional cents", async () => {
    await expect(store.postBounty(alice, input({ title: "Fix a pothole" }))).rejects.toMatchObject({ status: 422 });
    await expect(store.postBounty(alice, input({ reward: 40 }))).rejects.toMatchObject({ status: 422 });
    expect((await store.getViewer(alice)).wallet).toBe(35);
    expect(createBountySchema.safeParse({ ...input(), reward: 0.001 }).success).toBe(false);
    expect(createBountySchema.safeParse({ ...input(), posterId: bob.id }).success).toBe(false);
    expect(createBountySchema.safeParse({ ...input(), image: "data:image/jpeg;base64,AA==" }).success).toBe(false);
  });
});

it("retains bounty, profile, photo and balance state after closing/reopening the database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "civic-bounties-test-"));
  let pg: PGlite | undefined;
  try {
    pg = new PGlite(directory);
    for (const sql of migrations) await pg.exec(sql);
    let store = bountyStore(databaseFor(pg));
    await pg.query("INSERT INTO report_users (id) VALUES ($1)", [alice.id]);
    const photoId = "12345678-1234-4123-8123-123456789012";
    await pg.query(`INSERT INTO bounty_photos (id, owner_id, staging_key, object_key, ready)
      VALUES ($1,$2,'bounties/staging/test.jpg','bounties/photos/test.jpg',true)`, [photoId, alice.id]);
    const job = await store.postBounty(alice, input({ photoId }));
    await store.takeStep(bob, job.id, "claim");
    await store.takeStep(bob, job.id, "done");
    await store.takeStep(alice, job.id, "approve");
    await pg.close();
    pg = new PGlite(directory);
    store = bountyStore(databaseFor(pg));
    expect((await store.listBounties(null))[0]).toMatchObject({ id: job.id, status: "paid", posterProfileId: job.posterProfileId, imageUrl: `/api/bounty-images/${photoId}` });
    expect((await store.getViewer(alice)).wallet).toBe(15);
    expect((await store.getViewer(bob)).wallet).toBe(55);
    expect(await store.getProfile(job.posterProfileId)).toMatchObject({ jobsPosted: 1 });
    expect(await store.getImageKey(photoId)).toBe("bounties/photos/test.jpg");
  } finally {
    await pg?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
