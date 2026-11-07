-- AV Backup team metadata sync, protocol v1, for Neon (Data API + Managed Better Auth).
-- See db/SYNC_CONTRACT.md.
--
-- Apply once, as the database owner role (`neondb_owner` on Neon), never from the
-- app:  psql "$OWNER_URL" -v ON_ERROR_STOP=1 -f <this file>
-- Additive: touches no existing table, imports nothing, and stores no key.
-- Needs PostgreSQL 16+ (pg_input_is_valid) and Neon's pg_session_jwt (auth.user_id()),
-- which Neon installs when the Data API is enabled. Tested on local PG 16 with a stand-in
-- for pg_session_jwt only, not on Neon.
--
-- Shape: every table is in the unexposed schema avb_private with no grants, and
-- RLS on with no policies as a second lock. The only way in for the app is the
-- public.avb_* SECURITY INVOKER wrappers, which the Data API exposes, around private
-- SECURITY DEFINER functions (a definer function never sits in an exposed schema).
-- Each entry point re-reads live membership for auth.user_id() (the JWT's `sub`). No
-- other claim is read: not `role`, `email` or anything a user could influence.
-- Anyone can create a Better Auth account (Neon cannot restrict sign-up yet); an
-- account alone gets nothing here until the maintainer adds it with set_member.

begin;

create schema avb_private;
revoke all on schema avb_private from public;
grant usage on schema avb_private to authenticated;

-- ---------------------------------------------------------------- tables

create table avb_private.members (
  -- The Better Auth user id (neon_auth.user.id), as the JWT's `sub`. No foreign key:
  -- neon_auth is Better Auth's own schema. Removing access is set_member(..., false).
  user_id      text primary key check (char_length(user_id) between 1 and 255),
  role         text not null check (role in ('admin', 'operator')),
  is_active    boolean not null default true,
  display_name text not null default '' check (char_length(display_name) <= 200),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table avb_private.member_audit (
  audit_id     bigint generated always as identity primary key,
  user_id      text not null,
  action       text not null,
  old_role     text,
  new_role     text,
  old_active   boolean,
  new_active   boolean,
  db_user      text not null default current_user,
  session_user_name text not null default session_user,
  created_at   timestamptz not null default now()
);

create sequence avb_private.change_seq;

create table avb_private.targets (
  target_id       bigint generated always as identity primary key,
  target_type     text not null check (target_type in
    ('assignment', 'session', 'source_line', 'source_skip', 'city', 'report_record', 'team_defaults',
     'team_starts', 'learned_title', 'learned_place')),
  target_key      text not null,
  -- The owning assignment; an assignment points at itself. Null for team-wide data.
  assignment_key  uuid,
  head_version_id uuid,          -- null only for a row only ever seen as a conflict
  deleted         boolean not null default false,
  aggregate_rev   bigint,        -- assignments only: bumps on any change inside it
  change_seq      bigint not null,
  unique (target_type, target_key),
  check ((target_type = 'assignment') = (aggregate_rev is not null)),
  check ((target_type in ('assignment', 'session', 'source_line', 'source_skip')) = (assignment_key is not null))
);
create index on avb_private.targets (change_seq);
create index on avb_private.targets (assignment_key);

create table avb_private.mutations (
  mutation_id  uuid primary key,
  actor_id     text not null,
  request_hash bytea not null,
  response     jsonb not null,
  created_at   timestamptz not null default now()
);

create table avb_private.target_versions (
  version_id        uuid primary key default gen_random_uuid(),
  version_seq       bigint generated always as identity unique,
  target_id         bigint not null references avb_private.targets (target_id),
  parent_version_id uuid references avb_private.target_versions (version_id),
  action            text not null check (action in ('create', 'update', 'delete', 'restore', 'resolve')),
  accepted          boolean not null,  -- false: kept only as a conflict's incoming value
  payload           jsonb,             -- null: a deletion
  actor_id          text not null,
  mutation_id       uuid not null references avb_private.mutations (mutation_id)
                      deferrable initially deferred,
  created_at        timestamptz not null default now()
);
create index on avb_private.target_versions (target_id, version_seq);

alter table avb_private.targets
  add foreign key (head_version_id) references avb_private.target_versions (version_id);

create table avb_private.conflicts (
  conflict_id           uuid primary key default gen_random_uuid(),
  conflict_seq          bigint generated always as identity unique,
  target_id             bigint not null references avb_private.targets (target_id),
  kind                  text not null check (kind in
    ('stale_edit', 'delete_vs_edit', 'edit_vs_delete', 'create_collision', 'parent_deleted',
     'assignment_delete_stale')),
  base_version_id       uuid references avb_private.target_versions (version_id),
  detected_head_id      uuid references avb_private.target_versions (version_id),
  incoming_version_id   uuid not null references avb_private.target_versions (version_id),
  status                text not null default 'open' check (status in ('open', 'resolved')),
  resolution            text check (resolution in ('keep_current', 'accept_incoming', 'merged')),
  resolution_version_id uuid references avb_private.target_versions (version_id),
  resolved_by           text,
  resolved_at           timestamptz,
  created_at            timestamptz not null default now(),
  check ((status = 'resolved') = (resolution is not null))
);
create index on avb_private.conflicts (target_id) where status = 'open';

alter table avb_private.members         enable row level security;
alter table avb_private.member_audit    enable row level security;
alter table avb_private.targets         enable row level security;
alter table avb_private.mutations       enable row level security;
alter table avb_private.target_versions enable row level security;
alter table avb_private.conflicts       enable row level security;

-- ---------------------------------------------------------------- append-only and role audit

create function avb_private.forbid_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'avb:append_only' using errcode = 'P0001', detail = tg_table_name;
end $$;

create trigger append_only before update or delete on avb_private.target_versions
  for each row execute function avb_private.forbid_change();
create trigger append_only before update or delete on avb_private.mutations
  for each row execute function avb_private.forbid_change();
create trigger append_only before update or delete on avb_private.member_audit
  for each row execute function avb_private.forbid_change();
create trigger no_truncate before truncate on avb_private.target_versions
  for each statement execute function avb_private.forbid_change();
create trigger no_truncate before truncate on avb_private.mutations
  for each statement execute function avb_private.forbid_change();
create trigger no_truncate before truncate on avb_private.member_audit
  for each statement execute function avb_private.forbid_change();

create function avb_private.audit_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into avb_private.member_audit (user_id, action, old_role, new_role, old_active, new_active)
  values (coalesce(new.user_id, old.user_id), tg_op, old.role, new.role, old.is_active, new.is_active);
  return null;
end $$;

create trigger audit after insert or update or delete on avb_private.members
  for each row execute function avb_private.audit_member();

-- Maintainer-only (Neon SQL Editor or psql as the owner, never the app): no other role can run it.
-- Takes the user id AND the e-mail, which must name the same Better Auth account. Sign-up is
-- open on Neon, so an e-mail alone could belong to someone who registered it first.
create function avb_private.set_member(p_user_id text, p_email text, p_role text, p_active boolean,
                                       p_display_name text default null)
returns text language plpgsql set search_path = '' as $$
begin
  -- Switching someone off needs no auth account: theirs may already be deleted.
  if p_active and not exists (select from neon_auth."user" u where u.id::text = p_user_id and lower(u.email) = lower(p_email)) then
    raise exception 'avb:no_such_auth_user' using errcode = 'P0001',
      detail = 'No Better Auth user has both that id and that e-mail.';
  end if;
  insert into avb_private.members (user_id, role, is_active, display_name)
  values (p_user_id, p_role, p_active, coalesce(p_display_name, ''))
  on conflict (user_id) do update
    set role = excluded.role, is_active = excluded.is_active, updated_at = now(),
        display_name = coalesce(p_display_name, avb_private.members.display_name);
  return p_user_id;
end $$;

-- ---------------------------------------------------------------- helpers

create function avb_private.fail(p_code text, p_detail text default null, p_state text default 'P0001')
returns void language plpgsql set search_path = '' as $$
begin
  raise exception 'avb:%', p_code using errcode = p_state, detail = coalesce(p_detail, '');
end $$;

-- The live membership check: a still-valid token of a revoked user stops here.
create function avb_private.current_member() returns avb_private.members
language plpgsql stable set search_path = '' as $$
declare v_uid text := nullif(auth.user_id(), ''); m avb_private.members;
begin
  if v_uid is null then perform avb_private.fail('not_authenticated', null, '42501'); end if;
  select * into m from avb_private.members where user_id = v_uid and is_active;
  if not found then perform avb_private.fail('not_member', null, '42501'); end if;
  return m;
end $$;

create function avb_private.require_admin(m avb_private.members) returns void
language plpgsql stable set search_path = '' as $$
begin
  if m.role <> 'admin' then perform avb_private.fail('admin_required', null, '42501'); end if;
end $$;

create function avb_private.check_keys(p_obj jsonb, p_allowed text[], p_what text) returns void
language plpgsql immutable set search_path = '' as $$
declare k text;
begin
  if jsonb_typeof(p_obj) is distinct from 'object' then perform avb_private.fail('not_an_object', p_what); end if;
  for k in select jsonb_object_keys(p_obj) loop
    if not k = any (p_allowed) then perform avb_private.fail('unknown_field', p_what || '.' || k); end if;
  end loop;
end $$;

create function avb_private.check_protocol(p_request jsonb) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if (p_request -> 'protocol_version') is distinct from '1'::jsonb then
    perform avb_private.fail('protocol_version_unsupported', p_request ->> 'protocol_version');
  end if;
end $$;

create function avb_private.uuid_field(p_obj jsonb, p_name text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(p_obj -> p_name) is distinct from 'string'
     or (p_obj ->> p_name) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    perform avb_private.fail('invalid_uuid', p_name);
  end if;
  return (p_obj ->> p_name)::uuid;
end $$;

create function avb_private.int_field(p_obj jsonb, p_name text, p_min bigint, p_max bigint, p_default bigint default null)
returns bigint language plpgsql immutable set search_path = '' as $$
declare v numeric;
begin
  if not p_obj ? p_name and p_default is not null then return p_default; end if;
  if jsonb_typeof(p_obj -> p_name) is distinct from 'number' then perform avb_private.fail('invalid_integer', p_name); end if;
  v := (p_obj ->> p_name)::numeric;
  if v <> trunc(v) or v < p_min or v > p_max then perform avb_private.fail('out_of_range', p_name); end if;
  return v::bigint;
end $$;

-- field -> [kind, limit, required]. Anything not listed here is refused, which is what
-- keeps local paths, themes, column widths and runtime backup state off the server.
create function avb_private.payload_spec(p_type text) returns jsonb
language sql immutable set search_path = '' as $$
  select case p_type
    when 'assignment' then '{
      "label":["text",200,true], "sourceBasename":["basename",255,false], "createdAt":["timestamp_null",0,false],
      "defaults":["nested","team_defaults",false], "starts":["nested","team_starts",false]}'::jsonb
    when 'session' then '{
      "orderKey":["order_key",64,true], "include":["bool",0,true], "date":["date_null",0,true],
      "start":["text_null",16,false], "end":["text_null",16,false], "hint":["text_null",8,false],
      "type":["text",32,false], "activity":["text",200,false], "place":["text",500,false], "city":["text",200,false],
      "topic":["text",1000,false], "events":["list",200,false], "languages":["list",100,false],
      "author":["text",64,false], "format":["text",16,false], "duration":["scalar",32,false],
      "clips":["scalar",32,false], "cameras":["scalar",32,false], "folder":["scalar",32,false],
      "session":["scalar",32,false], "camPlan":["scalar",32,false], "backedUp":["timestamp_null",0,false],
      "title":["text",1000,false], "subtitle":["text",1000,false], "placeText":["text",1000,false],
      "source":["text",4000,false], "sharedFolder":["bool",0,false], "flags":["text_map",500,false],
      "geo":["text_null",300,false], "startedAt":["timestamp_null",0,false]}'::jsonb
    -- What was read from the poster or sheet, in order: one target per line part, so a
    -- long line splits across parts instead of being cut. See SYNC_CONTRACT.md.
    when 'source_line' then '{
      "line":["int",99999,true], "part":["int",9999,true], "cells":["cells",256,true],
      "continuesCell":["bool",0,true]}'::jsonb
    when 'source_skip' then '{
      "index":["int",99999,true], "days":["date_list",366,true], "reason":["text",32,true],
      "rowText":["text",32768,true]}'::jsonb
    when 'city' then '{
      "name":["text",300,true], "city":["text",200,true], "state":["text",200,false], "country":["text",200,false]}'::jsonb
    when 'report_record' then '{
      "id":["text",300,true], "folder":["scalar",32,false], "format":["text",16,false], "session":["scalar",32,false],
      "author":["text",64,false], "type":["text",32,false], "date":["date_null",0,false], "duration":["scalar",32,false],
      "activity":["text",200,false], "place":["text",500,false], "topic":["text",1000,false], "clips":["scalar",32,false],
      "cameras":["scalar",32,false], "events":["list",200,false], "languages":["list",100,false],
      "city":["text",200,false], "state":["text",200,false], "country":["text",200,false]}'::jsonb
    when 'team_defaults' then '{
      "author":["text",64,false], "format":["text",16,false], "camsFormal":["scalar",32,false],
      "camsInformal":["scalar",32,false]}'::jsonb
    when 'team_starts' then '{"formal":["scalar",32,false], "informal":["scalar",32,false]}'::jsonb
    when 'learned_title' then '{
      "key":["text",300,true], "topic":["text",1000,false], "type":["text",32,false], "activity":["text",200,false],
      "events":["list",200,false], "languages":["list",100,false]}'::jsonb
    when 'learned_place' then '{
      "key":["text",300,true], "place":["text",500,false], "city":["text",200,false], "languages":["list",100,false]}'::jsonb
  end
$$;

create function avb_private.validate_payload(p_type text, p_payload jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare
  v_spec jsonb := avb_private.payload_spec(p_type);
  f record; v jsonb; v_kind text; v_max int; v_t text; ok boolean; v_where text;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' then perform avb_private.fail('payload_required', p_type); end if;
  if octet_length(p_payload::text) > 32768 then perform avb_private.fail('payload_too_large', p_type); end if;
  perform avb_private.check_keys(p_payload, array(select jsonb_object_keys(v_spec)), p_type);

  for f in select key, value from jsonb_each(v_spec) loop
    v_where := p_type || '.' || f.key;
    if not p_payload ? f.key then
      if (f.value ->> 2)::boolean then perform avb_private.fail('missing_field', v_where); end if;
      continue;
    end if;
    v := p_payload -> f.key;
    v_t := jsonb_typeof(v);
    v_kind := f.value ->> 0;
    if v_kind = 'nested' then
      perform avb_private.validate_payload(f.value ->> 1, v);
      continue;
    end if;
    v_max := (f.value ->> 1)::int;
    ok := case v_kind
      when 'text' then v_t = 'string' and char_length(v #>> '{}') <= v_max
      when 'text_null' then v_t = 'null' or (v_t = 'string' and char_length(v #>> '{}') <= v_max)
      when 'scalar' then v_t in ('null', 'number') or (v_t = 'string' and char_length(v #>> '{}') <= v_max)
      when 'bool' then v_t = 'boolean'
      when 'order_key' then v_t = 'string' and (v #>> '{}') ~ '^[0-9A-Za-z]{1,64}$'
      -- A file name, never a path: the local location of a file is not server data.
      when 'basename' then v_t = 'string' and char_length(v #>> '{}') <= v_max
        and (v #>> '{}') !~ '[/\\]' and (v #>> '{}') !~ '^[A-Za-z]:'
      when 'date_null' then v_t = 'null' or (v_t = 'string' and ((v #>> '{}') = ''
        or ((v #>> '{}') ~ '^\d{4}-\d{2}-\d{2}$' and pg_input_is_valid(v #>> '{}', 'date'))))
      when 'timestamp_null' then v_t = 'null' or (v_t = 'string'
        and (v #>> '{}') ~ '^\d{4}-\d{2}-\d{2}T' and pg_input_is_valid(v #>> '{}', 'timestamptz'))
      when 'int' then case when v_t = 'number' then (v #>> '{}')::numeric between 0 and v_max
        and (v #>> '{}')::numeric = trunc((v #>> '{}')::numeric) else false end
      -- Cell texts as read; only the payload limit bounds their length.
      when 'cells' then v_t = 'array' and jsonb_array_length(v) <= v_max and not exists (
        select from jsonb_array_elements(v) e where jsonb_typeof(e) <> 'string')
      when 'date_list' then v_t = 'array' and jsonb_array_length(v) between 1 and v_max and not exists (
        select from jsonb_array_elements(v) e
        where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' or not pg_input_is_valid(e #>> '{}', 'date'))
      when 'list' then v_t = 'array' and jsonb_array_length(v) <= 64 and not exists (
        select from jsonb_array_elements(v) e
        where jsonb_typeof(e) <> 'string' or char_length(e #>> '{}') > v_max)
      when 'text_map' then v_t = 'object' and not exists (
        select from jsonb_each(v) e
        where char_length(e.key) > 64 or jsonb_typeof(e.value) <> 'string'
           or char_length(e.value #>> '{}') > v_max)
        and (select count(*) from jsonb_object_keys(v)) <= 32
    end;
    if not ok then perform avb_private.fail('invalid_field', v_where); end if;
  end loop;
end $$;

-- A target's key format, and its tie to the payload: a natural-key record can't be
-- filed under another record's key, and two devices importing one sheet share keys.
create function avb_private.check_target(p_type text, p_key text, p_payload jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare v_natural text;
begin
  if p_key is null then perform avb_private.fail('invalid_key', p_type); end if;
  case p_type
    when 'assignment', 'session' then
      if p_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        perform avb_private.fail('invalid_key', p_type);
      end if;
    -- <assignment>:<line>:<part> and <assignment>:<index>, matching the payload.
    when 'source_line' then
      if p_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{1,5}:\d{1,4}$'
         or (p_payload is not null and split_part(p_key, ':', 2) || ':' || split_part(p_key, ':', 3)
             is distinct from (p_payload ->> 'line') || ':' || (p_payload ->> 'part')) then
        perform avb_private.fail('invalid_key', p_type);
      end if;
    when 'source_skip' then
      if p_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{1,5}$'
         or (p_payload is not null and split_part(p_key, ':', 2) is distinct from p_payload ->> 'index') then
        perform avb_private.fail('invalid_key', p_type);
      end if;
    when 'team_defaults', 'team_starts' then
      if p_key <> 'team' then perform avb_private.fail('invalid_key', p_type); end if;
    when 'city' then v_natural := lower(btrim(coalesce(p_payload ->> 'name', p_key)));
    when 'report_record' then v_natural := upper(btrim(coalesce(p_payload ->> 'id', p_key)));
    when 'learned_title', 'learned_place' then v_natural := lower(btrim(coalesce(p_payload ->> 'key', p_key)));
    else perform avb_private.fail('unknown_target_type', p_type);
  end case;
  if v_natural is not null and (p_key <> v_natural or char_length(p_key) not between 1 and 300) then
    perform avb_private.fail('invalid_key', p_type);
  end if;
end $$;

-- One new change_seq for the target and, if it sits in an assignment, one more
-- aggregate_rev (and change_seq) on the assignment. Called only under the write lock.
create function avb_private.touch(p_target bigint) returns void
language sql set search_path = '' as $$
  update avb_private.targets t
     set change_seq = nextval('avb_private.change_seq'),
         aggregate_rev = t.aggregate_rev + 1
   where t.target_id = p_target
      or (t.target_type = 'assignment' and t.target_key = (
            select c.assignment_key::text from avb_private.targets c where c.target_id = p_target));
$$;

create function avb_private.add_version(p_target bigint, p_parent uuid, p_action text, p_accepted boolean,
                                        p_payload jsonb, p_actor text, p_mutation uuid) returns uuid
language sql set search_path = '' as $$
  insert into avb_private.target_versions (target_id, parent_version_id, action, accepted, payload, actor_id, mutation_id)
  values (p_target, p_parent, p_action, p_accepted, p_payload, p_actor, p_mutation)
  returning version_id;
$$;

-- Keep an incoming value that can't be applied. The same value already waiting on
-- this target coalesces into that conflict; nothing is ever dropped.
create function avb_private.open_conflict(t avb_private.targets, p_kind text, p_base uuid, p_action text,
                                          p_incoming jsonb, p_actor text, p_mutation uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare v_id uuid; v_kind text; v_incoming uuid;
begin
  select c.conflict_id, c.kind into v_id, v_kind
    from avb_private.conflicts c join avb_private.target_versions v on v.version_id = c.incoming_version_id
   where c.target_id = t.target_id and c.status = 'open' and v.payload is not distinct from p_incoming
   limit 1;
  if v_id is null then
    v_kind := p_kind;
    v_incoming := avb_private.add_version(t.target_id, p_base, p_action, false, p_incoming, p_actor, p_mutation);
    insert into avb_private.conflicts (target_id, kind, base_version_id, detected_head_id, incoming_version_id)
    values (t.target_id, p_kind, p_base, t.head_version_id, v_incoming)
    returning conflict_id into v_id;
    perform avb_private.touch(t.target_id);
  end if;
  return jsonb_build_object('status', 'conflict', 'conflict_id', v_id, 'conflict_kind', v_kind,
                            'head_version_id', t.head_version_id);
end $$;

create function avb_private.result_for(p_target bigint, p_extra jsonb) returns jsonb
language sql stable set search_path = '' as $$
  select p_extra || jsonb_build_object(
    'target_type', t.target_type, 'target_key', t.target_key, 'head_version_id', t.head_version_id,
    'deleted', t.deleted, 'aggregate_rev', (
      select a.aggregate_rev from avb_private.targets a
       where a.target_type = 'assignment' and a.target_key = t.assignment_key::text))
  from avb_private.targets t where t.target_id = p_target;
$$;

create function avb_private.parent_deleted(t avb_private.targets) returns boolean
language sql stable set search_path = '' as $$
  select exists (select from avb_private.targets a
                  where a.target_type = 'assignment' and a.target_key = t.assignment_key::text and a.deleted);
$$;

-- ---------------------------------------------------------------- operations

create function avb_private.apply_target_op(m avb_private.members, p_mutation uuid, p_op jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_kind text := p_op ->> 'op';
  v_type text := p_op ->> 'type';
  v_key  text := p_op ->> 'key';
  t avb_private.targets;
  v_base avb_private.target_versions;
  v_incoming jsonb;
  v_head jsonb;
  v_parent uuid;
  v_conflict text;
  v_version uuid;
begin
  perform avb_private.check_keys(p_op, case v_kind
    when 'create' then array['op', 'type', 'key', 'assignment_key', 'payload']
    when 'update' then array['op', 'type', 'key', 'base_version_id', 'payload']
    else array['op', 'type', 'key', 'base_version_id'] end, 'operation');
  perform avb_private.check_target(v_type, v_key, case when v_kind in ('create', 'update') then p_op -> 'payload' end);

  -- Whole-schedule deletion has one door, and it is not this one.
  if v_type = 'assignment' and v_kind in ('delete', 'restore') then
    perform avb_private.fail('use_delete_assignment', null, '42501');
  end if;
  if v_type in ('team_defaults', 'team_starts') and v_kind = 'delete' then
    perform avb_private.fail('not_deletable', v_type);
  end if;

  if v_kind in ('create', 'update') then
    perform avb_private.validate_payload(v_type, p_op -> 'payload');
    v_incoming := p_op -> 'payload';
  end if;

  select * into t from avb_private.targets where target_type = v_type and target_key = v_key;

  if v_kind = 'create' then
    if p_op ? 'assignment_key' <> (v_type in ('session', 'source_line', 'source_skip')) then
      perform avb_private.fail('assignment_key_only_for_children', v_type);
    end if;
    if v_type in ('source_line', 'source_skip') and split_part(v_key, ':', 1) <> p_op ->> 'assignment_key' then
      perform avb_private.fail('invalid_key', v_type);
    end if;
    if v_type in ('session', 'source_line', 'source_skip') then
      v_parent := avb_private.uuid_field(p_op, 'assignment_key');
      if not exists (select from avb_private.targets where target_type = 'assignment' and target_key = v_parent::text) then
        perform avb_private.fail('assignment_not_found', v_parent::text);
      end if;
    elsif v_type = 'assignment' then
      v_parent := v_key::uuid;
    end if;
    if t.target_id is null then
      if v_type in ('assignment', 'session') and exists (
        select from avb_private.targets where target_key = v_key and target_type in ('assignment', 'session')) then
        perform avb_private.fail('uid_collision', v_key);
      end if;
      insert into avb_private.targets (target_type, target_key, assignment_key, aggregate_rev, change_seq)
      values (v_type, v_key, v_parent, case when v_type = 'assignment' then 0 end, nextval('avb_private.change_seq'))
      returning * into t;
    elsif t.assignment_key is distinct from v_parent then
      perform avb_private.fail('uid_assignment_mismatch', v_key);
    end if;
  else
    if t.target_id is null then perform avb_private.fail('target_not_found', v_type || ':' || v_key); end if;
    select * into v_base from avb_private.target_versions
     where version_id = avb_private.uuid_field(p_op, 'base_version_id') and target_id = t.target_id;
    if not found then perform avb_private.fail('base_version_mismatch', p_op ->> 'base_version_id'); end if;
    if v_kind = 'update' and t.deleted and v_base.version_id = t.head_version_id and not avb_private.parent_deleted(t) then
      perform avb_private.fail('restore_required', v_key);
    end if;
    if v_kind = 'restore' then
      if v_base.payload is not null then perform avb_private.fail('restore_base_not_tombstone', v_key); end if;
      -- The last accepted value before this tombstone, however it came to be deleted.
      select payload into v_incoming from avb_private.target_versions
       where target_id = t.target_id and accepted and payload is not null and version_seq < v_base.version_seq
       order by version_seq desc limit 1;
      if v_incoming is null then perform avb_private.fail('nothing_to_restore', v_key); end if;
    end if;
  end if;

  select payload into v_head from avb_private.target_versions where version_id = t.head_version_id;

  -- Same value: nothing to record, and nothing to argue about.
  if t.head_version_id is not null and v_incoming is not distinct from v_head then
    return avb_private.result_for(t.target_id, jsonb_build_object('status', 'noop'));
  end if;

  -- No timestamps and no winner: anything not based on the current head waits for a person.
  v_conflict := case
    when avb_private.parent_deleted(t) then 'parent_deleted'
    when v_kind = 'create' then case when t.head_version_id is not null then 'create_collision' end
    when v_base.version_id is distinct from t.head_version_id then case
      when t.deleted then 'edit_vs_delete'
      when v_incoming is null then 'delete_vs_edit'
      else 'stale_edit' end
  end;
  if v_conflict is not null then
    return avb_private.result_for(t.target_id, avb_private.open_conflict(
      t, v_conflict, v_base.version_id, v_kind, v_incoming, m.user_id, p_mutation));
  end if;

  v_version := avb_private.add_version(t.target_id, t.head_version_id, v_kind, true, v_incoming, m.user_id, p_mutation);
  update avb_private.targets set head_version_id = v_version, deleted = (v_incoming is null) where target_id = t.target_id;
  perform avb_private.touch(t.target_id);
  return avb_private.result_for(t.target_id, jsonb_build_object('status', 'applied', 'version_id', v_version));
end $$;

create function avb_private.assignment_target(p_op jsonb) returns avb_private.targets
language plpgsql stable set search_path = '' as $$
declare t avb_private.targets;
begin
  select * into t from avb_private.targets
   where target_type = 'assignment' and target_key = avb_private.uuid_field(p_op, 'assignment_key')::text;
  if not found then perform avb_private.fail('assignment_not_found', p_op ->> 'assignment_key'); end if;
  return t;
end $$;

-- Marks only the assignment: children keep their heads, so restore brings back
-- everything and no child value is lost. A stale request never deletes.
create function avb_private.apply_delete_assignment(m avb_private.members, p_mutation uuid, p_op jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare t avb_private.targets; v_rev bigint; v_version uuid;
begin
  perform avb_private.require_admin(m);
  perform avb_private.check_keys(p_op, array['op', 'assignment_key', 'expected_aggregate_rev'], 'operation');
  t := avb_private.assignment_target(p_op);
  v_rev := avb_private.int_field(p_op, 'expected_aggregate_rev', 0, 9007199254740991);
  if t.deleted then return avb_private.result_for(t.target_id, jsonb_build_object('status', 'noop')); end if;
  if t.aggregate_rev <> v_rev then
    return avb_private.result_for(t.target_id, avb_private.open_conflict(
      t, 'assignment_delete_stale', t.head_version_id, 'delete', null, m.user_id, p_mutation));
  end if;
  v_version := avb_private.add_version(t.target_id, t.head_version_id, 'delete', true, null, m.user_id, p_mutation);
  update avb_private.targets set head_version_id = v_version, deleted = true where target_id = t.target_id;
  perform avb_private.touch(t.target_id);
  return avb_private.result_for(t.target_id, jsonb_build_object('status', 'applied', 'version_id', v_version));
end $$;

create function avb_private.apply_restore_assignment(m avb_private.members, p_mutation uuid, p_op jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare t avb_private.targets; v_rev bigint; v_version uuid; v_payload jsonb;
begin
  perform avb_private.require_admin(m);
  perform avb_private.check_keys(p_op, array['op', 'assignment_key', 'expected_aggregate_rev'], 'operation');
  t := avb_private.assignment_target(p_op);
  v_rev := avb_private.int_field(p_op, 'expected_aggregate_rev', 0, 9007199254740991);
  if not t.deleted then return avb_private.result_for(t.target_id, jsonb_build_object('status', 'noop')); end if;
  if t.aggregate_rev <> v_rev then perform avb_private.fail('aggregate_rev_mismatch', t.aggregate_rev::text); end if;
  select p.payload into v_payload
    from avb_private.target_versions d join avb_private.target_versions p on p.version_id = d.parent_version_id
   where d.version_id = t.head_version_id;
  v_version := avb_private.add_version(t.target_id, t.head_version_id, 'restore', true, v_payload, m.user_id, p_mutation);
  update avb_private.targets set head_version_id = v_version, deleted = false where target_id = t.target_id;
  perform avb_private.touch(t.target_id);
  return avb_private.result_for(t.target_id, jsonb_build_object('status', 'applied', 'version_id', v_version));
end $$;

create function avb_private.apply_resolve(m avb_private.members, p_mutation uuid, p_op jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  c avb_private.conflicts; t avb_private.targets;
  v_res text := p_op ->> 'resolution';
  v_payload jsonb; v_version uuid;
begin
  perform avb_private.check_keys(p_op, array['op', 'conflict_id', 'expected_head_version_id', 'resolution', 'payload'], 'operation');
  select * into c from avb_private.conflicts where conflict_id = avb_private.uuid_field(p_op, 'conflict_id');
  if not found then perform avb_private.fail('conflict_not_found', p_op ->> 'conflict_id'); end if;
  if c.status <> 'open' then perform avb_private.fail('conflict_not_open', c.conflict_id::text); end if;
  if v_res is null or v_res not in ('keep_current', 'accept_incoming', 'merged') then
    perform avb_private.fail('invalid_resolution', v_res);
  end if;
  if p_op ? 'payload' <> (v_res = 'merged') then perform avb_private.fail('payload_only_for_merged', v_res); end if;
  select * into t from avb_private.targets where target_id = c.target_id;

  -- A deletion attempt that lost its race is the admin's to close, and it can only be
  -- closed. To delete, send delete_assignment again against the current revision.
  if c.kind = 'assignment_delete_stale' then
    perform avb_private.require_admin(m);
    if v_res <> 'keep_current' then perform avb_private.fail('use_delete_assignment', null, '42501'); end if;
  end if;

  -- Decided against what the resolver actually saw, or not at all.
  if (p_op ->> 'expected_head_version_id') is distinct from t.head_version_id::text then
    perform avb_private.fail('stale_resolution', t.head_version_id::text);
  end if;

  if v_res = 'keep_current' then
    v_version := t.head_version_id;
  else
    if avb_private.parent_deleted(t) then perform avb_private.fail('parent_deleted', t.target_key); end if;
    if v_res = 'merged' then
      perform avb_private.check_target(t.target_type, t.target_key, p_op -> 'payload');
      perform avb_private.validate_payload(t.target_type, p_op -> 'payload');
      v_payload := p_op -> 'payload';
    else
      select payload into v_payload from avb_private.target_versions where version_id = c.incoming_version_id;
    end if;
    v_version := avb_private.add_version(t.target_id, t.head_version_id, 'resolve', true, v_payload, m.user_id, p_mutation);
    update avb_private.targets set head_version_id = v_version, deleted = (v_payload is null) where target_id = t.target_id;
  end if;

  update avb_private.conflicts
     set status = 'resolved', resolution = v_res, resolution_version_id = v_version, resolved_by = m.user_id, resolved_at = now()
   where conflict_id = c.conflict_id;
  perform avb_private.touch(t.target_id);
  return avb_private.result_for(t.target_id, jsonb_build_object('status', 'resolved', 'conflict_id', c.conflict_id, 'version_id', v_version));
end $$;

-- ---------------------------------------------------------------- entry points

create function avb_private.sync_apply(p_request jsonb) returns jsonb
language plpgsql security definer
set search_path = '' set lock_timeout = '5s'
as $$
declare
  m avb_private.members := avb_private.current_member();
  v_mid uuid; v_hash bytea; v_prev avb_private.mutations; v_ops jsonb; v_op jsonb;
  v_results jsonb := '[]'; v_seen text[] := '{}'; v_mark text; v_i int := 0; v_r jsonb; v_response jsonb;
begin
  perform avb_private.check_keys(p_request, array['protocol_version', 'mutation_id', 'operations'], 'request');
  perform avb_private.check_protocol(p_request);
  if octet_length(p_request::text) > 2097152 then perform avb_private.fail('request_too_large'); end if;
  v_mid := avb_private.uuid_field(p_request, 'mutation_id');
  v_ops := p_request -> 'operations';
  if jsonb_typeof(v_ops) is distinct from 'array' or jsonb_array_length(v_ops) not between 1 and 500 then
    perform avb_private.fail('invalid_operations', 'array of 1 to 500');
  end if;
  v_hash := sha256(convert_to(p_request::text, 'UTF8'));

  -- One writer at a time: commit order then equals change_seq order, so a reader's
  -- cursor can never pass a change that commits later. Small team, short batches.
  perform pg_advisory_xact_lock(7277001);
  m := avb_private.current_member();  -- revoked while waiting for the lock means revoked

  select * into v_prev from avb_private.mutations where mutation_id = v_mid;
  if found then
    if v_prev.actor_id <> m.user_id or v_prev.request_hash <> v_hash then
      perform avb_private.fail('mutation_id_reused', v_mid::text);
    end if;
    return v_prev.response;
  end if;

  for v_op in select value from jsonb_array_elements(v_ops) loop
    if jsonb_typeof(v_op) is distinct from 'object' then perform avb_private.fail('not_an_object', 'operation'); end if;
    -- The target each op actually touches; a resolution counts as its conflict's target.
    v_mark := case v_op ->> 'op'
      when 'resolve_conflict' then (
        select t.target_type || '/' || t.target_key
          from avb_private.conflicts c join avb_private.targets t on t.target_id = c.target_id
         where c.conflict_id = avb_private.uuid_field(v_op, 'conflict_id'))
      when 'delete_assignment' then 'assignment/' || (v_op ->> 'assignment_key')
      when 'restore_assignment' then 'assignment/' || (v_op ->> 'assignment_key')
      else (v_op ->> 'type') || '/' || (v_op ->> 'key') end;
    if v_mark = any (v_seen) then perform avb_private.fail('duplicate_target_in_batch', v_mark); end if;
    v_seen := v_seen || v_mark;
    v_r := case v_op ->> 'op'
      when 'create' then avb_private.apply_target_op(m, v_mid, v_op)
      when 'update' then avb_private.apply_target_op(m, v_mid, v_op)
      when 'delete' then avb_private.apply_target_op(m, v_mid, v_op)
      when 'restore' then avb_private.apply_target_op(m, v_mid, v_op)
      when 'delete_assignment' then avb_private.apply_delete_assignment(m, v_mid, v_op)
      when 'restore_assignment' then avb_private.apply_restore_assignment(m, v_mid, v_op)
      when 'resolve_conflict' then avb_private.apply_resolve(m, v_mid, v_op)
    end;
    if v_r is null then perform avb_private.fail('unknown_op', v_op ->> 'op'); end if;
    v_results := v_results || (jsonb_build_object('index', v_i, 'op', v_op ->> 'op') || v_r);
    v_i := v_i + 1;
  end loop;

  v_response := jsonb_build_object('protocol_version', 1, 'mutation_id', v_mid, 'results', v_results);
  insert into avb_private.mutations (mutation_id, actor_id, request_hash, response)
  values (v_mid, m.user_id, v_hash, v_response);
  return v_response;
end $$;

create function avb_private.sync_pull(p_request jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  m avb_private.members := avb_private.current_member();
  v_after bigint; v_limit int; v_items jsonb; v_count int; v_next bigint;
begin
  perform avb_private.check_keys(p_request, array['protocol_version', 'after', 'limit'], 'request');
  perform avb_private.check_protocol(p_request);
  v_after := avb_private.int_field(p_request, 'after', 0, 9007199254740991, 0);
  v_limit := avb_private.int_field(p_request, 'limit', 1, 500, 200);
  select coalesce(jsonb_agg(jsonb_build_object(
           'target_type', p.target_type, 'target_key', p.target_key, 'assignment_key', p.assignment_key,
           'change_seq', p.change_seq, 'head_version_id', p.head_version_id, 'deleted', p.deleted,
           'aggregate_rev', p.aggregate_rev, 'payload', v.payload,
           'updated_by', v.actor_id, 'updated_at', v.created_at,
           'open_conflicts', (select count(*) from avb_private.conflicts c
                               where c.target_id = p.target_id and c.status = 'open'))
           order by p.change_seq) filter (where p.rn <= v_limit), '[]'),
         count(*), max(p.change_seq) filter (where p.rn <= v_limit)
    into v_items, v_count, v_next
    from (select t.*, row_number() over (order by t.change_seq) rn from avb_private.targets t
           where t.change_seq > v_after order by t.change_seq limit v_limit + 1) p
    left join avb_private.target_versions v on v.version_id = p.head_version_id;
  return jsonb_build_object('protocol_version', 1, 'items', v_items,
    'next_cursor', coalesce(v_next, v_after), 'has_more', v_count > v_limit);
end $$;

create function avb_private.version_json(p_version uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('version_id', v.version_id, 'action', v.action, 'accepted', v.accepted,
           'parent_version_id', v.parent_version_id, 'payload', v.payload, 'actor_id', v.actor_id,
           'mutation_id', v.mutation_id, 'created_at', v.created_at, 'version_seq', v.version_seq)
    from avb_private.target_versions v where v.version_id = p_version;
$$;

create function avb_private.target_history(p_request jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  m avb_private.members := avb_private.current_member();
  v_target bigint; v_limit int; v_before bigint; v_items jsonb; v_count int; v_next bigint;
begin
  perform avb_private.check_keys(p_request, array['protocol_version', 'type', 'key', 'before', 'limit'], 'request');
  perform avb_private.check_protocol(p_request);
  select target_id into v_target from avb_private.targets
   where target_type = p_request ->> 'type' and target_key = p_request ->> 'key';
  if v_target is null then perform avb_private.fail('target_not_found'); end if;
  v_limit := avb_private.int_field(p_request, 'limit', 1, 100, 50);
  v_before := avb_private.int_field(p_request, 'before', 1, 9007199254740991, 9007199254740991);
  select coalesce(jsonb_agg(avb_private.version_json(p.version_id) order by p.version_seq desc)
           filter (where p.rn <= v_limit), '[]'),
         count(*), min(p.version_seq) filter (where p.rn <= v_limit)
    into v_items, v_count, v_next
    from (select v.version_id, v.version_seq, row_number() over (order by v.version_seq desc) rn
            from avb_private.target_versions v
           where v.target_id = v_target and v.version_seq < v_before
           order by v.version_seq desc limit v_limit + 1) p;
  return jsonb_build_object('protocol_version', 1, 'items', v_items,
    'next_before', case when v_count > v_limit then v_next end, 'has_more', v_count > v_limit);
end $$;

create function avb_private.conflicts_list(p_request jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  m avb_private.members := avb_private.current_member();
  v_status text := coalesce(p_request ->> 'status', 'open');
  v_assignment uuid; v_after bigint; v_limit int; v_items jsonb; v_count int; v_next bigint;
begin
  perform avb_private.check_keys(p_request, array['protocol_version', 'status', 'assignment_key', 'after', 'limit'], 'request');
  perform avb_private.check_protocol(p_request);
  if v_status not in ('open', 'resolved', 'all') then perform avb_private.fail('invalid_status', v_status); end if;
  if p_request ? 'assignment_key' then v_assignment := avb_private.uuid_field(p_request, 'assignment_key'); end if;
  v_after := avb_private.int_field(p_request, 'after', 0, 9007199254740991, 0);
  v_limit := avb_private.int_field(p_request, 'limit', 1, 100, 50);
  select coalesce(jsonb_agg(jsonb_build_object(
           'conflict_id', p.conflict_id, 'conflict_seq', p.conflict_seq, 'kind', p.kind, 'status', p.status,
           'target_type', p.target_type, 'target_key', p.target_key, 'assignment_key', p.assignment_key,
           'created_at', p.created_at, 'resolution', p.resolution,
           'resolved_by', p.resolved_by, 'resolved_at', p.resolved_at,
           'resolution_version_id', p.resolution_version_id,
           'base', avb_private.version_json(p.base_version_id),
           'detected_head', avb_private.version_json(p.detected_head_id),
           'incoming', avb_private.version_json(p.incoming_version_id),
           'current_head', avb_private.version_json(p.head_version_id),
           'target_deleted', p.deleted,
           'assignment_rev', (select a.aggregate_rev from avb_private.targets a
                               where a.target_type = 'assignment' and a.target_key = p.assignment_key::text))
           order by p.conflict_seq) filter (where p.rn <= v_limit), '[]'),
         count(*), max(p.conflict_seq) filter (where p.rn <= v_limit)
    into v_items, v_count, v_next
    from (select c.*, t.target_type, t.target_key, t.assignment_key, t.head_version_id, t.deleted,
                 row_number() over (order by c.conflict_seq) rn
            from avb_private.conflicts c join avb_private.targets t on t.target_id = c.target_id
           where c.conflict_seq > v_after
             and (v_status = 'all' or c.status = v_status)
             and (v_assignment is null or t.assignment_key = v_assignment)
           order by c.conflict_seq limit v_limit + 1) p;
  return jsonb_build_object('protocol_version', 1, 'items', v_items,
    'next_cursor', coalesce(v_next, v_after), 'has_more', v_count > v_limit);
end $$;

create function avb_private.me() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare m avb_private.members := avb_private.current_member();
begin
  return jsonb_build_object('protocol_version', 1, 'user_id', m.user_id, 'role', m.role,
    'display_name', m.display_name);
end $$;

create function avb_private.team_members() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare m avb_private.members := avb_private.current_member();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('user_id', x.user_id, 'display_name', x.display_name,
                     'role', x.role, 'is_active', x.is_active) order by x.display_name, x.user_id)
                     from avb_private.members x), '[]');
end $$;

-- ---------------------------------------------------------------- what the Data API sees

create function public.avb_sync_apply(p_request jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select avb_private.sync_apply(p_request) $$;
create function public.avb_sync_pull(p_request jsonb) returns jsonb
language sql stable security invoker set search_path = '' as $$ select avb_private.sync_pull(p_request) $$;
create function public.avb_target_history(p_request jsonb) returns jsonb
language sql stable security invoker set search_path = '' as $$ select avb_private.target_history(p_request) $$;
create function public.avb_conflicts(p_request jsonb) returns jsonb
language sql stable security invoker set search_path = '' as $$ select avb_private.conflicts_list(p_request) $$;
create function public.avb_me() returns jsonb
language sql stable security invoker set search_path = '' as $$ select avb_private.me() $$;
create function public.avb_team_members() returns jsonb
language sql stable security invoker set search_path = '' as $$ select avb_private.team_members() $$;

-- ---------------------------------------------------------------- grants, last so nothing is missed

-- Postgres hands every function to PUBLIC, and Neon's optional "Grant public schema
-- access" adds default privileges for authenticated: take all of that back.
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'avb_private' or (n.nspname = 'public' and p.proname like 'avb\_%')
  loop
    execute format('revoke all on function %s from public, anonymous, authenticated', f);
  end loop;
end $$;
revoke all on all tables in schema avb_private from public, anonymous, authenticated;
revoke all on all sequences in schema avb_private from public, anonymous, authenticated;

grant execute on function
  public.avb_sync_apply(jsonb), public.avb_sync_pull(jsonb), public.avb_target_history(jsonb),
  public.avb_conflicts(jsonb), public.avb_me(), public.avb_team_members(),
  avb_private.sync_apply(jsonb), avb_private.sync_pull(jsonb), avb_private.target_history(jsonb),
  avb_private.conflicts_list(jsonb), avb_private.me(), avb_private.team_members()
to authenticated;

commit;
