import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import * as schema from "./schema.ts";

// ─── Postgres / Drizzle ───────────────────────────────────────────────────────

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}

function resolveDbSslMode(url: string): false | "require" {
  const override = process.env.DATABASE_SSL?.toLowerCase();
  if (override === "false") return false;
  if (override === "true" || override === "require") return "require";

  // Supabase and most hosted Postgres providers require SSL.
  const isLocal = /:\/\/[^@/]*@?(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url);
  return isLocal ? false : "require";
}

// Use postgres-js as the driver for Drizzle
// max: 10 connections, idle_timeout: 20s, connect_timeout: 10s
const queryClient = postgres(connectionString, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  ssl: resolveDbSslMode(connectionString),
});

const enableQueryLogs = process.env.DB_LOG_QUERIES === "true";
export const db = drizzle(queryClient, { schema, logger: enableQueryLogs });

// ─── Supabase Client (for Storage, Auth helpers, Realtime if needed) ──────────

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Optional: only needed when using Supabase Storage for attachments.
export const supabase =
  supabaseUrl && supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      })
    : null;

// ─── Health check ─────────────────────────────────────────────────────────────

export async function checkDbHealth(): Promise<boolean> {
  try {
    await queryClient`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export { schema };
