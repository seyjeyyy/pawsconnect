// Read-only. Compares every table, column and function the server names against the schema
// the connected database actually exposes. Prints names only: no credentials, no records.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
dotenv.config({ path: 'server/.env', quiet: true });
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase is not configured.');

const response = await fetch(new URL('/rest/v1/', SUPABASE_URL), {
  headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY },
  signal: AbortSignal.timeout(20000)
});
if (!response.ok) throw new Error('Schema request failed: HTTP ' + response.status);
const spec = await response.json();
const columns = new Map(Object.entries(spec.definitions ?? {}).map(([table, def]) => [table, new Set(Object.keys(def.properties ?? {}))]));
const functions = new Map();
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  if (!path.startsWith('/rpc/')) continue;
  const body = (item.post?.parameters ?? []).find(p => p.in === 'body');
  functions.set(path.slice(5), Object.keys(body?.schema?.properties ?? {}));
}

const serverDir = fileURLToPath(new URL('../server/src/', import.meta.url));
const sources = dir => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
});
const code = sources(serverDir).map(path => readFileSync(path, 'utf8')).join('\n');

function topLevelColumns(list) {
  const names = [];
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

const literal = [...code.matchAll(/\.from\('([a-z_]+)'\)/g)].map(m => m[1]);
const mapped = [...code.matchAll(/table: '([a-z_]+)'/g)].map(m => m[1]);
const missingTables = [...new Set([...literal, ...mapped])].filter(name => !columns.has(name)).sort();

const missingColumns = new Set();
for (const statement of code.split(/(?=\.from\(')/).filter(part => part.startsWith(".from('"))) {
  const table = /^\.from\('([a-z_]+)'\)/.exec(statement)?.[1];
  const known = table && columns.get(table);
  if (!table || !known) continue;
  const chain = statement.slice(0, 900).split(/;\s*\n|\)\);/)[0];
  const named = [];
  for (const [, list] of chain.matchAll(/\.select\('([^']*)'/g)) named.push(...topLevelColumns(list));
  for (const [, column] of chain.matchAll(/\.(?:eq|neq|is|in|ilike|gte|lte|gt|lt|order)\('([a-z_]+)'/g)) named.push(column);
  for (const [, body] of chain.matchAll(/\.(?:insert|update|upsert)\(\{([^{}]*)\}/g)) {
    for (const [, key] of body.matchAll(/(?:^|,)\s*([a-z_]+)\s*(?=:|,|$)/g)) named.push(key);
  }
  for (const column of named) if (/^[a-z_]+$/.test(column) && !known.has(column)) missingColumns.add(table + '.' + column);
}

const functionProblems = new Set();
for (const [, name, body] of code.matchAll(/\.rpc\('([a-z_]+)'(?:,\s*\{([^}]*)\})?/g)) {
  const defined = functions.get(name);
  if (!defined) { functionProblems.add(name + ': function does not exist'); continue; }
  const passed = [...(body ?? '').matchAll(/\b(p_[a-z_]+)\s*:/g)].map(m => m[1]);
  const unknown = passed.filter(arg => !defined.includes(arg));
  if (unknown.length) functionProblems.add(name + ': unknown argument(s) ' + unknown.join(', '));
}

console.log(JSON.stringify({
  tables_exposed: columns.size,
  functions_exposed: functions.size,
  missing_tables: missingTables,
  missing_columns: [...missingColumns].sort(),
  function_problems: [...functionProblems].sort()
}, null, 2));
process.exitCode = missingTables.length || missingColumns.size || functionProblems.size ? 1 : 0;
