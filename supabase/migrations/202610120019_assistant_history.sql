-- Conversation history for the PawsConnect assistant. Additive: no existing row changes.
-- The API (service role) is the only writer and always filters by the signed-in user.
-- Direct access is limited to reading one's own rows; nobody else, staff included, can read them.
create table public.assistant_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index assistant_conversations_user_idx on public.assistant_conversations(user_id, updated_at desc);

create table public.assistant_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.assistant_conversations on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  role text not null check(role in ('user','assistant')),
  content text not null check(length(content) between 1 and 20000),
  -- Provider usage for cost tracking; null on user messages.
  input_tokens integer check(input_tokens >= 0),
  output_tokens integer check(output_tokens >= 0),
  created_at timestamptz not null default now()
);
create index assistant_messages_conversation_idx on public.assistant_messages(conversation_id, created_at desc);
create index assistant_messages_user_idx on public.assistant_messages(user_id, created_at desc);

alter table public.assistant_conversations enable row level security;
alter table public.assistant_messages enable row level security;
revoke all on public.assistant_conversations, public.assistant_messages from anon, authenticated;
grant select on public.assistant_conversations, public.assistant_messages to authenticated;
create policy assistant_conversations_own on public.assistant_conversations for select to authenticated using (user_id = auth.uid());
create policy assistant_messages_own on public.assistant_messages for select to authenticated using (user_id = auth.uid());
-- Same rule as every other table since migration 016: a revoked session reads nothing.
create policy active_app_session on public.assistant_conversations as restrictive for all to authenticated using(public.current_session_allowed()) with check(public.current_session_allowed());
create policy active_app_session on public.assistant_messages as restrictive for all to authenticated using(public.current_session_allowed()) with check(public.current_session_allowed());
notify pgrst, 'reload schema';
