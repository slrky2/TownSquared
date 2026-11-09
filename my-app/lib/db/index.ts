import { Pool } from "pg";

export interface SqlClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string, values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface Database extends SqlClient {
  transaction<T>(work: (client: SqlClient) => Promise<T>): Promise<T>;
}

// Reuse connections across development hot reloads; application data lives in PostgreSQL.
const globalForDb = globalThis as typeof globalThis & { __reportingPool?: Pool };
function getPool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for reporting");
  if (!globalForDb.__reportingPool) {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
    });
    pool.on("error", () => console.error("Reporting database idle connection failed"));
    globalForDb.__reportingPool = pool;
  }
  return globalForDb.__reportingPool;
}

const db: Database = {
  query: (sql, values) => getPool().query(sql, values),
  async transaction(work) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};

export default db;
