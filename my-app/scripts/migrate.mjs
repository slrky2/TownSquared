import nextEnv from "@next/env";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

nextEnv.loadEnvConfig(process.cwd());
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL before running migrations");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000 });
await client.connect();
try {
  await client.query("SELECT pg_advisory_lock(19283401)");
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
  for (const name of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
    const applied = await client.query("SELECT name FROM schema_migrations WHERE name = $1", [name]);
    if (applied.rows.length) continue;
    await client.query("BEGIN");
    try {
      await client.query(await readFile(`${directory}/${name}`, "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      console.log(`Applied ${name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.end();
}
