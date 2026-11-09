/** Durable bounty jobs and simulated wallets. Every state/balance change is transactional. */
import { randomUUID } from "node:crypto";
import db, { type Database, type SqlClient } from "@/lib/db";
import { RequestError } from "@/lib/api/errors";
import type { Bounty, BountyAction, BountyStatus, BountyViewer, PosterProfile } from "@/types";
import type { CreateBountyInput } from "@/lib/validators/bounty";

export interface Actor { id: string; name: string; isCityStaff: boolean }
const CITY_ID = "city";
const CITY_NAME = "City of Lowell";
const STARTING_WALLET_CENTS = 3500;

/**
 * Work that needs city equipment or is unsafe for a neighbor: roads, lights,
 * signs, sewers, utilities. A keyword check on the title and details; it
 * catches the obvious cases, not every phrasing.
 */
const CITY_REPAIR_PATTERN =
  /\b(pot ?holes?|asphalt|manholes?|sewers?|storm drains?|water mains?|(fire )?hydrants?|street ?lights?|traffic (lights?|signals?)|stop signs?|crosswalks?|power lines?|(downed|live) wires?|utility poles?|gas leaks?)\b/i;


export class BountyError extends RequestError {}

type BountyRow = {
  id: number; title: string; details: string; rewardCents: number;
  posterId: string; posterName: string; posterProfileId: string;
  claimerId: string | null; claimerName: string | null;
  lat: number | null; lng: number | null; place: string;
  imageId: string | null; status: BountyStatus; createdAt: Date | string;
};

const SELECT_BOUNTY = `SELECT b.id, b.title, b.details, b.reward_cents AS "rewardCents",
  b.poster_id AS "posterId", p.name AS "posterName", p.public_id AS "posterProfileId",
  b.claimer_id AS "claimerId", c.name AS "claimerName", b.lat, b.lng, b.place, b.status,
  b.created_at AS "createdAt",
  (SELECT id::text FROM bounty_photos WHERE bounty_id = b.id) AS "imageId"
  FROM bounties b JOIN bounty_people p ON p.id = b.poster_id
  LEFT JOIN bounty_people c ON c.id = b.claimer_id`;

/** Whether the actor stands in for the poster: they posted it, or it's a city job and they're staff. */
function isPosterSide(row: BountyRow, actor: Actor): boolean {
  return row.posterId === actor.id || (row.posterId === CITY_ID && actor.isCityStaff);
}

/**
 * The single source of truth for who may take which step. Returns the error
 * to raise, or null if the step is allowed. The UI's buttons come from this
 * too (via `viewerCan`), so they can't drift from what the server enforces.
 */
function checkStep(row: BountyRow, actor: Actor, step: BountyAction): BountyError | null {
  const cityJob = row.posterId === CITY_ID;
  switch (step) {
    case "claim":
      if (row.status === "done" || row.status === "paid") {
        return new BountyError(409, "This job is already finished.");
      }
      if (row.status !== "open") return new BountyError(409, "Someone already claimed this job.");
      if (isPosterSide(row, actor)) {
        return new BountyError(
          409,
          cityJob ? "City staff can't claim city jobs." : "You can't claim your own bounty.",
        );
      }
      return null;
    case "done":
      if (row.status !== "claimed" || row.claimerId !== actor.id) {
        return new BountyError(409, "Only the person who claimed this job can mark it done.");
      }
      return null;
    case "approve":
      if (!isPosterSide(row, actor)) {
        return new BountyError(
          403,
          cityJob ? "Only city staff can approve city jobs." : "Only the poster can approve the payout.",
        );
      }
      if (row.status !== "done") return new BountyError(409, "The job isn't marked done yet.");
      return null;
  }
}


const STEPS: BountyAction[] = ["claim", "done", "approve"];
function toBounty(row: BountyRow, actor: Actor | null): Bounty {
  return {
    id: row.id, title: row.title, details: row.details, reward: row.rewardCents / 100,
    posterName: row.posterName, posterProfileId: row.posterProfileId,
    imageUrl: row.imageId ? `/api/bounty-images/${row.imageId}` : null,
    postedByCity: row.posterId === CITY_ID,
    claimerName: actor && row.claimerId === actor.id ? "you" : row.claimerName,
    lat: row.lat, lng: row.lng, place: row.place, status: row.status,
    createdAt: new Date(row.createdAt).toISOString(),
    mine: actor && isPosterSide(row, actor) ? "posted" : actor && row.claimerId === actor.id ? "claimed" : null,
    viewerCan: actor ? STEPS.find((step) => checkStep(row, actor, step) === null) ?? null : null,
  };
}

async function remember(client: SqlClient, id: string, name: string) {
  await client.query(`INSERT INTO bounty_people (id, public_id, name, is_city) VALUES ($1,$2,$3,$4)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`, [id, id === CITY_ID ? "city" : `u-${randomUUID()}`, name, id === CITY_ID]);
}

async function rememberActor(client: SqlClient, actor: Actor) {
  await remember(client, actor.id, actor.name);
  // The opening grant and ledger entry happen exactly once, including simultaneous first visits.
  const opened = await client.query(`INSERT INTO bounty_wallets (user_id, balance_cents) VALUES ($1,$2)
    ON CONFLICT (user_id) DO NOTHING RETURNING user_id`, [actor.id, STARTING_WALLET_CENTS]);
  if (opened.rows.length) await client.query(`INSERT INTO bounty_wallet_entries (user_id, kind, amount_cents)
    VALUES ($1,'opening',$2)`, [actor.id, STARTING_WALLET_CENTS]);
}

export type PostBountyInput = CreateBountyInput;

export function bountyStore(database: Database) {
  async function row(client: SqlClient, id: number, lock = false) {
    const result = await client.query<BountyRow>(`${SELECT_BOUNTY} WHERE b.id = $1${lock ? " FOR UPDATE OF b" : ""}`, [id]);
    if (!result.rows[0]) throw new BountyError(404, "That bounty doesn't exist.");
    return result.rows[0];
  }
  return {
    async listBounties(actor: Actor | null) {
      const result = await database.query<BountyRow>(`${SELECT_BOUNTY} ORDER BY b.created_at DESC, b.id DESC`);
      return result.rows.map((r) => toBounty(r, actor));
    },
    async getViewer(actor: Actor): Promise<BountyViewer> {
      return database.transaction(async (client) => {
        await rememberActor(client, actor);
        const result = await client.query<{ balance_cents: string }>("SELECT balance_cents FROM bounty_wallets WHERE user_id = $1", [actor.id]);
        return { name: actor.name, isCityStaff: actor.isCityStaff, wallet: Number(result.rows[0].balance_cents) / 100 };
      });
    },
    async getProfile(publicId: string): Promise<PosterProfile | null> {
      const result = await database.query<{ public_id: string; name: string; is_city: boolean; posted: number; completed: number }>(`SELECT p.public_id, p.name, p.is_city,
        (SELECT count(*)::integer FROM bounties b WHERE b.poster_id = p.id) AS posted,
        (SELECT count(*)::integer FROM bounties b WHERE b.claimer_id = p.id AND b.status = 'paid') AS completed
        FROM bounty_people p WHERE p.public_id = $1`, [publicId]);
      const p = result.rows[0];
      return p ? { id: p.public_id, name: p.name, isCity: p.is_city, jobsPosted: p.posted, jobsCompleted: p.completed } : null;
    },
    async getImageKey(id: string) {
      const result = await database.query<{ object_key: string }>("SELECT object_key FROM bounty_photos WHERE id = $1 AND ready AND bounty_id IS NOT NULL", [id]);
      return result.rows[0]?.object_key ?? null;
    },
    async postBounty(actor: Actor, input: PostBountyInput) {
      if (input.asCity && !actor.isCityStaff) throw new BountyError(403, "Only city staff can post city bounties.");
      if (CITY_REPAIR_PATTERN.test(`${input.title} ${input.details}`)) throw new BountyError(422, "That sounds like a city repair, not a bounty. City crews handle roads, streetlights, signs and utilities.");
      const rewardCents = Math.round(input.reward * 100);
      if (!Number.isSafeInteger(rewardCents) || rewardCents < 1 || rewardCents > 100000) throw new BountyError(422, "Reward must be between $0.01 and $1,000.");
      return database.transaction(async (client) => {
        await rememberActor(client, actor);
        const posterId = input.asCity ? CITY_ID : actor.id;
        if (input.asCity) await remember(client, CITY_ID, CITY_NAME);
        if (input.photoId) {
          const photo = await client.query(`SELECT id FROM bounty_photos WHERE id = $1 AND owner_id = $2
            AND bounty_id IS NULL AND ready AND expires_at > now() FOR UPDATE`, [input.photoId, actor.id]);
          if (!photo.rows.length) throw new BountyError(422, "Photo is unavailable, expired, or belongs to another user. Upload it again.");
        }
        if (!input.asCity) {
          const held = await client.query(`UPDATE bounty_wallets SET balance_cents = balance_cents - $2
            WHERE user_id = $1 AND balance_cents >= $2 RETURNING user_id`, [actor.id, rewardCents]);
          if (!held.rows.length) throw new BountyError(422, "Not enough in your wallet to fund this bounty.");
        }
        const created = await client.query<{ id: number }>(`INSERT INTO bounties
          (title, details, reward_cents, poster_id, lat, lng, place) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [input.title.trim(), input.details.trim(), rewardCents, posterId, input.lat, input.lng, input.place.trim()]);
        const id = created.rows[0].id;
        if (input.photoId) await client.query("UPDATE bounty_photos SET bounty_id = $1 WHERE id = $2", [id, input.photoId]);
        if (!input.asCity) await client.query(`INSERT INTO bounty_wallet_entries (user_id, bounty_id, kind, amount_cents)
          VALUES ($1,$2,'hold',$3)`, [actor.id, id, -rewardCents]);
        await client.query("INSERT INTO bounty_events (bounty_id, actor_id, action) VALUES ($1,$2,'post')", [id, actor.id]);
        return toBounty(await row(client, id), actor);
      });
    },
    async takeStep(actor: Actor, id: number, step: BountyAction) {
      return database.transaction(async (client) => {
        // A row lock serializes competing claims and approvals across every app instance.
        const bounty = await row(client, id, true);
        const error = checkStep(bounty, actor, step);
        if (error) throw error;
        await rememberActor(client, actor);
        if (step === "claim") {
          await client.query("UPDATE bounties SET claimer_id = $2, status = 'claimed' WHERE id = $1", [id, actor.id]);
        } else if (step === "done") {
          await client.query("UPDATE bounties SET status = 'done' WHERE id = $1", [id]);
        } else {
          await client.query("UPDATE bounty_wallets SET balance_cents = balance_cents + $2 WHERE user_id = $1", [bounty.claimerId, bounty.rewardCents]);
          await client.query(`INSERT INTO bounty_wallet_entries (user_id, bounty_id, kind, amount_cents)
            VALUES ($1,$2,'payout',$3)`, [bounty.claimerId, id, bounty.rewardCents]);
          await client.query("UPDATE bounties SET status = 'paid' WHERE id = $1", [id]);
        }
        await client.query("INSERT INTO bounty_events (bounty_id, actor_id, action) VALUES ($1,$2,$3)", [id, actor.id, step]);
        return toBounty(await row(client, id), actor);
      });
    },
  };
}

export const { listBounties, getViewer, getProfile, getImageKey, postBounty, takeStep } = bountyStore(db);
