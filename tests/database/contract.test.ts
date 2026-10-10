import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../helpers/db';

// The API talks to the database through untyped `.from('table')` and
// `.rpc('function', { args })` calls. This test reads those calls out of the
// server source and checks each one against the schema the migrations produce,
// so a renamed table, a missing function or a misspelled column or argument
// fails here instead of at runtime.
const serverDir = fileURLToPath(new URL('../../server/src/', import.meta.url));
const sources = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
});
const code = sources(serverDir).map(path => readFileSync(path, 'utf8')).join('\n');

/** Top-level column names of a PostgREST select list; embedded resources such as `orders(...)` belong to other tables. */
function topLevelColumns(list: string) {
  const names: string[] = [];
  let depth = 0, current = '';
  for (const ch of list + ',') {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      if (!current.includes('(') && !current.includes('*')) names.push(current.trim());
      current = '';
    } else current += ch;
  }
  return names;
}

let db: PGlite;
beforeAll(async () => { db = await createDatabase(); });
afterAll(() => db.close());

describe('server ↔ database contract', () => {
  it('every table the API reads or writes exists', async () => {
    const existing = new Set((await db.query<{ table_name: string }>(`select table_name from information_schema.tables where table_schema = 'public'`)).rows.map(r => r.table_name));
    const literal = [...code.matchAll(/\.from\('([a-z_]+)'\)/g)].map(m => m[1]);
    // Tables named in lookup maps, e.g. `{ table: 'products' }`.
    const mapped = [...code.matchAll(/table: '([a-z_]+)'/g)].map(m => m[1]);
    const missing = [...new Set([...literal, ...mapped])].filter(name => !existing.has(name)).sort();
    expect(missing).toEqual([]);
  });

  it('every column the API names in a select, filter, order or inline write exists on its table', async () => {
    const { rows } = await db.query<{ table_name: string; column_name: string }>(`select table_name, column_name from information_schema.columns where table_schema = 'public'`);
    const columns = new Map<string, Set<string>>();
    for (const r of rows) columns.set(r.table_name, (columns.get(r.table_name) ?? new Set<string>()).add(r.column_name));

    const problems: string[] = [];
    const statements = code.split(/(?=\.from\(')/).filter(part => part.startsWith(".from('"));
    for (const statement of statements) {
      const table = /^\.from\('([a-z_]+)'\)/.exec(statement)?.[1];
      const known = table && columns.get(table);
      if (!table || !known) continue;
      // Stay inside this call chain: stop at the end of the statement.
      const chain = statement.slice(0, 900).split(/;\s*\n|\)\);/)[0];
      const named: string[] = [];
      for (const [, list] of chain.matchAll(/\.select\('([^']*)'/g)) named.push(...topLevelColumns(list));
      for (const [, column] of chain.matchAll(/\.(?:eq|neq|is|in|ilike|gte|lte|gt|lt|order)\('([a-z_]+)'/g)) named.push(column);
      for (const [, body] of chain.matchAll(/\.(?:insert|update|upsert)\(\{([^{}]*)\}/g)) {
        for (const [, key] of body.matchAll(/(?:^|,)\s*([a-z_]+)\s*(?=:|,|$)/g)) named.push(key);
      }
      for (const column of named) if (/^[a-z_]+$/.test(column) && !known.has(column)) problems.push(`${table}.${column}`);
    }
    expect([...new Set(problems)].sort()).toEqual([]);
  });

  it('every embedded relationship is unambiguous', async () => {
    // PostgREST refuses `table(...)` embeds when two foreign keys link the tables, unless the
    // embed names one (`table!constraint(...)`). That failure only shows up at runtime.
    const { rows } = await db.query<{ a: string; b: string; n: number }>(`
      select c.conrelid::regclass::text as a, c.confrelid::regclass::text as b, count(*)::int as n
      from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace group by 1, 2`);
    const links = (x: string, y: string) => rows.filter(r => (r.a === x && r.b === y) || (r.a === y && r.b === x)).reduce((sum, r) => sum + r.n, 0);
    const problems: string[] = [];
    const check = (table: string, select: string) => {
      for (const [, embed, hint] of select.matchAll(/(?:^|,)\s*(?:[a-z_]+:)?([a-z_]+)(![a-z_]+)?\(/g)) {
        const count = links(table, embed);
        if (count === 0) problems.push(`${table} -> ${embed}: no relationship`);
        else if (count > 1 && !hint) problems.push(`${table} -> ${embed}: ${count} relationships, name one with !constraint`);
      }
    };
    for (const [, table, select] of code.matchAll(/table: '([a-z_]+)'[^}]*?select: '([^']+)'/g)) check(table, select);
    for (const statement of code.split(/(?=\.from\(')/).filter(part => part.startsWith(".from('"))) {
      const table = /^\.from\('([a-z_]+)'\)/.exec(statement)?.[1];
      const chain = statement.slice(0, 900).split(/;\s*\n|\)\);/)[0];
      if (table) for (const [, select] of chain.matchAll(/\.select\('([^']*)'/g)) check(table, select);
    }
    expect([...new Set(problems)].sort()).toEqual([]);
  });

  it('every RPC the API calls exists with exactly the argument names it passes', async () => {
    const { rows } = await db.query<{ proname: string; args: string[] | null }>(`select proname, proargnames as args from pg_proc where pronamespace = 'public'::regnamespace`);
    const functions = new Map(rows.map(r => [r.proname, (r.args ?? []).filter(a => a.startsWith('p_'))]));
    const problems: string[] = [];
    for (const [, name, body] of code.matchAll(/\.rpc\('([a-z_]+)'(?:,\s*\{([^}]*)\})?/g)) {
      const defined = functions.get(name);
      if (!defined) { problems.push(`${name}: function does not exist`); continue; }
      const passed = [...(body ?? '').matchAll(/\b(p_[a-z_]+)\s*:/g)].map(m => m[1]);
      const unknown = passed.filter(arg => !defined.includes(arg));
      if (unknown.length) problems.push(`${name}: unknown argument(s) ${unknown.join(', ')} (defined: ${defined.join(', ')})`);
    }
    expect([...new Set(problems)].sort()).toEqual([]);
  });
});
