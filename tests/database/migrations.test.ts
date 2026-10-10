import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createDatabase, migrationFiles } from '../helpers/db';

describe('supabase migrations', () => {
  it('apply cleanly, in order, to an empty database, followed by the seed', async () => {
    expect(migrationFiles().length).toBeGreaterThan(0);
    const db = await createDatabase();
    const tables = await db.query<{ count: number }>(`select count(*)::int as count from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`);
    expect(tables.rows[0].count).toBeGreaterThan(40);

    const seed = readFileSync(new URL('../../supabase/seed.sql', import.meta.url), 'utf8');
    await db.exec(seed);
    await db.exec(seed); // idempotent
    const categories = await db.query<{ count: number }>('select count(*)::int as count from public.product_categories');
    expect(categories.rows[0].count).toBe(11);
    // The seed must never create catalog, animal or transaction records.
    for (const table of ['products', 'pets', 'orders', 'donations']) {
      const { rows } = await db.query<{ count: number }>(`select count(*)::int as count from public.${table}`);
      expect(rows[0].count, table).toBe(0);
    }
    await db.close();
  });

  it('enable row level security on every public table', async () => {
    const db = await createDatabase();
    const { rows } = await db.query<{ tablename: string }>(`select tablename from pg_tables where schemaname = 'public' and not rowsecurity and tablename <> 'spatial_ref_sys'`);
    expect(rows.map(r => r.tablename)).toEqual([]);
    await db.close();
  });
});
