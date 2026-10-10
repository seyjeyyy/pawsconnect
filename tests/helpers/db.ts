import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { postgis } from '@electric-sql/pglite-postgis';

const migrationsDir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));

// The minimum of a Supabase project that the migrations depend on: the three
// API roles, auth.users + auth.uid(), storage tables, and the default grants
// Supabase applies to new objects in `public` (which the migrations must
// actively narrow, so reproducing them here keeps the RLS tests honest).
const supabaseShim = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema extensions;
  create schema auth;
  create schema storage;
  grant usage on schema public, extensions, auth, storage to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    raw_user_meta_data jsonb not null default '{}',
    email_confirmed_at timestamptz,
    created_at timestamptz not null default now()
  );
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.role() returns text language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select jsonb_build_object('sub', current_setting('request.jwt.claim.sub', true)) $$;

  create table storage.buckets (
    id text primary key, name text not null unique, public boolean not null default false,
    file_size_limit bigint, allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets, name text not null,
    owner uuid, created_at timestamptz not null default now()
  );
  alter table storage.objects enable row level security;
  grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
  create function storage.foldername(name text) returns text[] language sql immutable as
    $$ select (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1] $$;
`;

export const migrationFiles = () => readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

/** A fresh in-process Postgres with PostGIS and every migration applied. */
export async function createDatabase() {
  const db = await PGlite.create({ extensions: { pgcrypto, postgis } });
  await db.exec(supabaseShim);
  await db.exec('set search_path = public, extensions');
  for (const file of migrationFiles()) {
    try {
      await db.exec(readFileSync(migrationsDir + file, 'utf8'));
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
    }
  }
  return db;
}

export async function createUser(db: PGlite, email: string, metadata: Record<string, unknown> = {}) {
  const { rows } = await db.query<{ id: string }>('insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id', [email, metadata]);
  return rows[0].id;
}

/** Runs `fn` the way PostgREST would for a signed-in user: as `authenticated`, with RLS applied. */
export function asUser<T>(db: PGlite, userId: string | null, fn: (tx: Transaction) => Promise<T>) {
  return db.transaction(async tx => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
    await tx.exec(`set local role ${userId ? 'authenticated' : 'anon'}`);
    return fn(tx);
  }) as Promise<T>;
}
