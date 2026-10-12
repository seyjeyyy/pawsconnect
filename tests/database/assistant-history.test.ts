import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createDatabase, createUser } from '../helpers/db';

// Conversation history is private to its owner. Staff, administrators and the
// super administrator hold no policy that reads another account's messages.
let db: PGlite, alice: string, bob: string, staff: string, system: string, conversation: string;
beforeAll(async () => {
  db = await createDatabase();
  alice = await createUser(db, 'alice@assistant.test'); bob = await createUser(db, 'bob@assistant.test');
  staff = await createUser(db, 'staff@assistant.test'); system = await createUser(db, 'system@assistant.test');
  await db.query("insert into public.user_roles(user_id,role_name) values($1,'administrator'),($2,'super_administrator')", [staff, system]);
  conversation = (await db.query<{ id: string }>('insert into public.assistant_conversations(user_id) values($1) returning id', [alice])).rows[0].id;
  await db.query("insert into public.assistant_messages(conversation_id,user_id,role,content) values($1,$2,'user','Where is my application?'),($1,$2,'assistant','It is under review.')", [conversation, alice]);
});
afterAll(() => db?.close());

describe('assistant conversation history', () => {
  it('is readable only by its owner', async () => {
    expect((await asUser(db, alice, tx => tx.query('select * from public.assistant_messages'))).rows).toHaveLength(2);
    expect((await asUser(db, alice, tx => tx.query('select * from public.assistant_conversations'))).rows).toHaveLength(1);
    for (const other of [bob, staff, system]) {
      expect((await asUser(db, other, tx => tx.query('select * from public.assistant_messages'))).rows, other).toHaveLength(0);
      expect((await asUser(db, other, tx => tx.query('select * from public.assistant_conversations'))).rows, other).toHaveLength(0);
    }
    await expect(asUser(db, null, tx => tx.query('select * from public.assistant_messages'))).rejects.toThrow(/permission denied/);
  });
  it('cannot be written or forged from a signed-in browser session', async () => {
    await expect(asUser(db, bob, tx => tx.query("insert into public.assistant_messages(conversation_id,user_id,role,content) values($1,$2,'assistant','forged')", [conversation, bob]))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, alice, tx => tx.query("update public.assistant_messages set content='edited'"))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, alice, tx => tx.query('delete from public.assistant_conversations'))).rejects.toThrow(/permission denied/);
  });
  it('removes messages with their conversation and keeps other accounts untouched', async () => {
    const other = (await db.query<{ id: string }>('insert into public.assistant_conversations(user_id) values($1) returning id', [bob])).rows[0].id;
    await db.query("insert into public.assistant_messages(conversation_id,user_id,role,content) values($1,$2,'user','Bob asks')", [other, bob]);
    await db.query('delete from public.assistant_conversations where user_id=$1', [alice]);
    expect((await db.query('select 1 from public.assistant_messages where user_id=$1', [alice])).rows).toHaveLength(0);
    expect((await db.query('select 1 from public.assistant_messages where user_id=$1', [bob])).rows).toHaveLength(1);
  });
});
