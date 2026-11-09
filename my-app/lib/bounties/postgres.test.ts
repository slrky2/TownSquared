import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { Database } from "@/lib/db";
import { bountyStore, type Actor } from "./store";
import { createBountySchema } from "@/lib/validators/bounty";
import { createPhotoUploads } from "@/lib/photos/uploads";
import { photoStorage } from "@/lib/reports/storage";
import sharp from "sharp";

// Opt-in tests use real independent PostgreSQL connections, in a disposable schema.
// No existing application tables or rows are read or deleted.
describe.skipIf(!process.env.BOUNTY_TEST_DATABASE_URL)("bounty concurrency on real PostgreSQL", () => {
  let pool: Pool;
  let database: Database;
  const schema = `bounty_test_${randomUUID().replaceAll("-", "")}`;
  const alice: Actor = { id: "user_alice", name: "Alice", isCityStaff: false };
  const bob: Actor = { id: "user_bob", name: "Bob", isCityStaff: false };
  const carol: Actor = { id: "user_carol", name: "Carol", isCityStaff: false };
  const input = (extra = {}) => createBountySchema.parse({ title: "Rake leaves", reward: 20, place: "Lowell", ...extra });

  beforeAll(async () => {
    const url = process.env.BOUNTY_TEST_DATABASE_URL!;
    if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw new Error("Concurrency tests require a local PostgreSQL URL");
    pool = new Pool({ connectionString: url, max: 8, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5000 });
    await pool.query(`CREATE SCHEMA ${schema}`);
    for (const name of ["001_reporting.sql", "002_bounties.sql"]) {
      await pool.query(await readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
    }
    database = {
      query: (sql, values) => pool.query(sql, values),
      async transaction(work) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await work(client);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally { client.release(); }
      },
    };
  }, 30_000);
  beforeEach(async () => {
    await pool.query("TRUNCATE bounty_events, bounty_wallet_entries, bounty_photos, bounties, bounty_wallets, bounty_people, report_users CASCADE");
  });
  afterAll(async () => {
    if (pool) {
      try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
      finally { await pool.end(); }
    }
  });

  it("prevents duplicate opening grants, overspending, double claims and double payouts across connections", async () => {
    const a = bountyStore(database);
    const b = bountyStore(database);
    await Promise.all([a.getViewer(alice), b.getViewer(alice), a.getViewer(alice)]);
    expect((await pool.query("SELECT * FROM bounty_wallet_entries WHERE kind = 'opening'")).rows).toHaveLength(1);
    const posts = await Promise.allSettled([a.postBounty(alice, input()), b.postBounty(alice, input())]);
    const posted = posts.filter((r) => r.status === "fulfilled");
    expect(posted).toHaveLength(1);
    expect((await a.getViewer(alice)).wallet).toBe(15);
    const job = posted[0].value;
    const claims = await Promise.allSettled([a.takeStep(bob, job.id, "claim"), b.takeStep(carol, job.id, "claim")]);
    expect(claims.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = claims[0].status === "fulfilled" ? bob : carol;
    await a.takeStep(winner, job.id, "done");
    const approvals = await Promise.allSettled([a.takeStep(alice, job.id, "approve"), b.takeStep(alice, job.id, "approve")]);
    expect(approvals.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await b.getViewer(winner)).wallet).toBe(55);
    expect((await pool.query("SELECT * FROM bounty_wallet_entries WHERE kind = 'payout'")).rows).toHaveLength(1);
  });

  it("cannot spend the same photo twice while simultaneous submissions race", async () => {
    const store = bountyStore(database);
    await pool.query("INSERT INTO report_users (id) VALUES ($1)", [alice.id]);
    const id = randomUUID();
    await pool.query(`INSERT INTO bounty_photos (id, owner_id, staging_key, object_key, ready)
      VALUES ($1,$2,'bounties/staging/test.jpg','bounties/photos/test.jpg',true)`, [id, alice.id]);
    const posts = await Promise.allSettled([
      store.postBounty(alice, input({ photoId: id, reward: 5 })),
      bountyStore(database).postBounty(alice, input({ photoId: id, reward: 5 })),
    ]);
    expect(posts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await store.getViewer(alice)).wallet).toBe(30);
    expect(await store.listBounties(null)).toHaveLength(1);
  });

  it.skipIf(process.env.BOUNTY_TEST_STORAGE !== "1")("uploads, validates and attaches a real object-storage photo", async () => {
    if (!["localhost", "127.0.0.1"].includes(new URL(process.env.REPORTS_S3_ENDPOINT!).hostname)) throw new Error("Storage smoke tests require a local endpoint");
    const photos = createPhotoUploads(database, photoStorage, "bounties");
    const upload = await photos.begin(alice.id);
    try {
      const bytes = await sharp({ create: { width: 12, height: 12, channels: 3, background: "red" } }).jpeg().toBuffer();
      const body = new FormData();
      for (const [key, value] of Object.entries(upload.fields)) body.append(key, value);
      body.append("file", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), "bounty.jpg");
      const response = await fetch(upload.url, { method: "POST", body, headers: { Origin: "http://localhost:3000" } });
      expect(response.ok).toBe(true);
      expect(["*", "http://localhost:3000"]).toContain(response.headers.get("access-control-allow-origin"));
      await photos.complete(upload.photoId, alice.id);
      const store = bountyStore(database);
      const job = await store.postBounty(alice, input({ photoId: upload.photoId }));
      expect(job.imageUrl).toBe(`/api/bounty-images/${upload.photoId}`);
      const key = await store.getImageKey(upload.photoId);
      expect(key).toBe(`bounties/photos/${upload.photoId}.jpg`);
      const stored = await photoStorage.read(key!);
      expect((await sharp(stored).metadata()).format).toBe("jpeg");
      expect((await bountyStore(database).listBounties(null))[0].imageUrl).toBe(job.imageUrl);
    } finally {
      // Only these generated test objects are removed, regardless of test outcome.
      await photoStorage.remove(`bounties/staging/${upload.photoId}.jpg`);
      await photoStorage.remove(`bounties/photos/${upload.photoId}.jpg`);
    }
  }, 30_000);
});
