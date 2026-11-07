-- Behavioural tests for the sync migration. Each block switches to the real API role
-- and calls the same public.avb_* functions the app will call.
\set ON_ERROR_STOP on
set client_min_messages = warning;

create schema t;
grant usage on schema t to anonymous, authenticated, neondb_owner;
create table t.results (id serial primary key, name text, passed boolean, detail text);

create function t.ok(p_name text, p_pass boolean, p_detail text default null) returns void
language sql security definer set search_path = '' as $$
  insert into t.results (name, passed, detail) values (p_name, coalesce(p_pass, false), p_detail) $$;
create function t.eq(p_name text, p_got anyelement, p_want anyelement) returns void
language sql as $$ select t.ok(p_name, p_got is not distinct from p_want, format('got %s want %s', p_got, p_want)) $$;

create function t.uid(p_name text) returns text language sql stable security definer set search_path = '' as $$
  select id from neon_auth."user" where email = p_name || '@test.invalid' $$;

-- A verified JWT as the Data API presents it: sub and role, plus claims that must be ignored
-- (aal, a Supabase leftover, and admin roles in metadata). p_aal is only ever an ignored claim.
create function t.login(p_name text, p_aal text default 'aal1', p_role text default 'authenticated') returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', t.uid(p_name), 'role', p_role, 'aal', p_aal,
    'app_metadata', jsonb_build_object('role', 'admin'), 'user_metadata', jsonb_build_object('role', 'admin'))::text, false);
  perform set_config('role', p_role, false);
end $$;
create function t.anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{}', false);   -- no role claim: the Data API's anonymous
  perform set_config('role', 'anonymous', false);
end $$;
create function t.super() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', false);
  perform set_config('role', 'none', false);
end $$;

-- Runs p_sql; passes only if it raises p_want (a SQLSTATE or part of the message).
create function t.raises(p_name text, p_sql text, p_want text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    perform t.ok(p_name, sqlstate = p_want or sqlerrm like '%' || p_want || '%', sqlstate || ' ' || sqlerrm);
    return;
  end;
  perform t.ok(p_name, false, 'no error raised, wanted ' || p_want);
end $$;

create function t.apply(p_ops jsonb, p_mid uuid default gen_random_uuid()) returns jsonb language sql as $$
  select public.avb_sync_apply(jsonb_build_object('protocol_version', 1, 'mutation_id', p_mid, 'operations', p_ops)) $$;
create function t.one(p_op jsonb) returns jsonb language sql as $$ select t.apply(jsonb_build_array(p_op)) -> 'results' -> 0 $$;
-- A statement string for t.raises.
create function t.q(p_op jsonb) returns text language sql as $$ select format('select t.one(%L::jsonb)', p_op) $$;

create function t.meta(p_label text) returns jsonb language sql as $$
  select jsonb_build_object('label', p_label, 'sourceBasename', 'poster.pdf') $$;
create function t.row(p_order text, p_topic text default '') returns jsonb language sql as $$
  select jsonb_build_object('orderKey', p_order, 'include', true, 'date', '2026-11-07', 'topic', p_topic) $$;
create function t.c_assign(p_key uuid, p_payload jsonb) returns jsonb language sql as $$
  select jsonb_build_object('op', 'create', 'type', 'assignment', 'key', p_key, 'payload', p_payload) $$;
create function t.c_row(p_a uuid, p_key uuid, p_payload jsonb) returns jsonb language sql as $$
  select jsonb_build_object('op', 'create', 'type', 'session', 'key', p_key, 'assignment_key', p_a, 'payload', p_payload) $$;
create function t.u(p_type text, p_key text, p_base text, p_payload jsonb) returns jsonb language sql as $$
  select jsonb_build_object('op', 'update', 'type', p_type, 'key', p_key, 'base_version_id', p_base, 'payload', p_payload) $$;
create function t.d(p_type text, p_key text, p_base text) returns jsonb language sql as $$
  select jsonb_build_object('op', 'delete', 'type', p_type, 'key', p_key, 'base_version_id', p_base) $$;
create function t.del_a(p_a uuid, p_rev bigint) returns jsonb language sql as $$
  select jsonb_build_object('op', 'delete_assignment', 'assignment_key', p_a, 'expected_aggregate_rev', p_rev) $$;
create function t.res_a(p_a uuid, p_rev bigint) returns jsonb language sql as $$
  select jsonb_build_object('op', 'restore_assignment', 'assignment_key', p_a, 'expected_aggregate_rev', p_rev) $$;
create function t.resolve(p_c text, p_head text, p_res text, p_payload jsonb default null) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('op', 'resolve_conflict', 'conflict_id', p_c, 'resolution', p_res, 'payload', p_payload))
    || case when p_head is null then '{}'::jsonb else jsonb_build_object('expected_head_version_id', p_head) end $$;

-- Reads go through the API as the caller: the head as a client would see it.
create function t.head(p_type text, p_key text) returns jsonb language plpgsql as $$
declare v_after bigint := 0; r jsonb; i jsonb;
begin
  loop
    r := public.avb_sync_pull(jsonb_build_object('protocol_version', 1, 'after', v_after, 'limit', 500));
    for i in select value from jsonb_array_elements(r -> 'items') loop
      if i ->> 'target_type' = p_type and i ->> 'target_key' = p_key then return i; end if;
    end loop;
    exit when not (r ->> 'has_more')::boolean;
    v_after := (r ->> 'next_cursor')::bigint;
  end loop;
  return null;
end $$;
create function t.open_conflicts(p_a uuid default null) returns jsonb language sql as $$
  select public.avb_conflicts(jsonb_strip_nulls(jsonb_build_object('protocol_version', 1, 'assignment_key', p_a, 'limit', 100))) -> 'items' $$;

grant execute on all functions in schema t to anonymous, authenticated, neondb_owner;
grant select on t.results to anonymous, authenticated, neondb_owner;

insert into neon_auth."user" (email) values
  ('admin1@test.invalid'), ('op1@test.invalid'), ('op2@test.invalid'), ('gone@test.invalid'),
  ('stranger@test.invalid'), ('deleted@test.invalid');

-- ---------------------------------------------------------------- bootstrap by the maintainer

set role neondb_owner;
\o /dev/null
select avb_private.set_member(t.uid('admin1'), 'admin1@test.invalid', 'admin', true, 'Admin One');
select avb_private.set_member(t.uid('op1'), 'op1@test.invalid', 'operator', true, 'Op One');
select avb_private.set_member(t.uid('op2'), 'op2@test.invalid', 'operator', true, 'Op Two');
select avb_private.set_member(t.uid('gone'), 'gone@test.invalid', 'operator', true, 'Soon Gone');
select avb_private.set_member(t.uid('deleted'), 'deleted@test.invalid', 'operator', true, 'Deleted Later');
\o
reset role;

-- ---------------------------------------------------------------- catalog: what is exposed

do $$
declare n int;
begin
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'avb_private' and c.relkind = 'r' and not c.relrowsecurity;
  perform t.eq('catalog: RLS on for every private table', n, 0);

  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace, unnest(array['anonymous', 'authenticated', 'public']) r(role)
   where s.nspname = 'avb_private' and c.relkind in ('r', 'S')
     and (case when r.role = 'public' then c.relacl is not null and exists (
            select from aclexplode(c.relacl) a where a.grantee = 0)
          else c.relkind = 'r' and (has_table_privilege(r.role, c.oid, 'select,insert,update,delete,truncate,references,trigger'))
            or c.relkind = 'S' and has_sequence_privilege(r.role, c.oid, 'usage,select,update') end);
  perform t.eq('catalog: no API role has any right on a private table or sequence', n, 0);

  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
   where s.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'f', 'p');
  perform t.eq('catalog: migration added no table or view to public', n, 0);

  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname in ('avb_private') and p.prosecdef and not coalesce(p.proconfig @> array['search_path=""'], false);
  perform t.eq('catalog: every definer function pins search_path', n, 0);

  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname like 'avb\_%' and p.prosecdef;
  perform t.eq('catalog: no definer function in the exposed schema', n, 0);

  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace, unnest(array['anonymous']) r(role)
   where (s.nspname = 'avb_private' or (s.nspname = 'public' and p.proname like 'avb\_%'))
     and has_function_privilege(r.role, p.oid, 'execute');
  perform t.eq('catalog: anonymous can execute no avb function', n, 0);

  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where (s.nspname = 'avb_private' or (s.nspname = 'public' and p.proname like 'avb\_%'))
     and exists (select from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0);
  perform t.eq('catalog: PUBLIC can execute no avb function', n, 0);

  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'avb_private' and has_function_privilege('authenticated', p.oid, 'execute')
     and p.proname not in ('sync_apply', 'sync_pull', 'target_history', 'conflicts_list', 'me', 'team_members');
  perform t.eq('catalog: authenticated can execute only the six private entry points', n, 0);

  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'avb_private' and p.proname in ('sync_apply', 'sync_pull', 'target_history', 'conflicts_list', 'me', 'team_members')
     and not p.prosecdef;
  perform t.eq('catalog: entry points are definer functions', n, 0);
end $$;

-- ---------------------------------------------------------------- anon and non-members

do $$
declare a uuid := gen_random_uuid();
begin
  perform t.anon();
  perform t.raises('anon: me', 'select public.avb_me()', '42501');
  perform t.raises('anon: pull', $s$select public.avb_sync_pull('{"protocol_version":1}')$s$, '42501');
  perform t.raises('anon: apply', $s$select public.avb_sync_apply('{"protocol_version":1}')$s$, '42501');
  perform t.raises('anon: conflicts', $s$select public.avb_conflicts('{"protocol_version":1}')$s$, '42501');
  perform t.raises('anon: history', $s$select public.avb_target_history('{"protocol_version":1}')$s$, '42501');
  perform t.raises('anon: team', 'select public.avb_team_members()', '42501');
  perform t.raises('anon: private entry point', $s$select avb_private.sync_pull('{"protocol_version":1}')$s$, '42501');
  perform t.raises('anon: private table', 'select * from avb_private.targets', '42501');

  perform t.login('stranger');
  perform t.raises('signed-in non-member: me', 'select public.avb_me()', 'avb:not_member');
  perform t.raises('signed-in non-member: pull', $s$select public.avb_sync_pull('{"protocol_version":1}')$s$, 'avb:not_member');
  perform t.raises('signed-in non-member: apply', t.q(t.c_assign(a, t.meta('x'))), 'avb:not_member');
  perform t.raises('signed-in non-member: team', 'select public.avb_team_members()', 'avb:not_member');

  -- A token-less call that still has the authenticated role must not pass either.
  perform set_config('request.jwt.claims', '', false);
  perform t.raises('authenticated role, no uid: denied', 'select public.avb_me()', 'avb:not_authenticated');

  perform t.super();
end $$;

-- ---------------------------------------------------------------- operator rights

do $$
declare
  a uuid := gen_random_uuid(); r1 uuid := gen_random_uuid(); r2 uuid := gen_random_uuid(); r3 uuid := gen_random_uuid();
  r jsonb; v_base text; v_base2 text; m jsonb;
begin
  perform t.login('op1');
  m := public.avb_me();
  perform t.eq('me: role comes from membership, not claims', m ->> 'role', 'operator');
  r := t.apply(jsonb_build_array(t.c_assign(a, t.meta('Event')), t.c_row(a, r1, t.row('a', 'one')), t.c_row(a, r2, t.row('b', 'two'))));
  perform t.eq('operator: creates assignment and rows', r #>> '{results,2,status}', 'applied');
  perform t.eq('server sets the actor to the caller',
    (public.avb_target_history(jsonb_build_object('protocol_version', 1, 'type', 'session', 'key', r1)) #>> '{items,0,actor_id}'), t.uid('op1'));

  perform t.login('op2');
  perform t.eq('other operator reads the whole team''s schedule', t.head('session', r1::text) #>> '{payload,topic}', 'one');
  v_base := t.head('session', r1::text) ->> 'head_version_id';
  r := t.one(t.u('session', r1::text, v_base, t.row('a', 'one edited')));
  perform t.eq('other operator edits any row', r ->> 'status', 'applied');
  r := t.one(t.c_row(a, r3, t.row('c', 'three')));
  perform t.eq('other operator adds a row', r ->> 'status', 'applied');
  v_base2 := t.head('session', r3::text) ->> 'head_version_id';
  r := t.one(t.d('session', r3::text, v_base2));
  perform t.eq('other operator deletes a row', r ->> 'status', 'applied');
  perform t.eq('deleted row is a tombstone', (t.head('session', r3::text) ->> 'deleted')::boolean, true);

  -- Explicit restore; an ordinary edit can't bring a row back.
  v_base2 := t.head('session', r3::text) ->> 'head_version_id';
  perform t.raises('edit of a seen tombstone needs restore', t.q(t.u('session', r3::text, v_base2, t.row('c', 'x'))), 'avb:restore_required');
  r := t.one(jsonb_build_object('op', 'restore', 'type', 'session', 'key', r3, 'base_version_id', v_base2));
  perform t.eq('restore returns the row', t.head('session', r3::text) #>> '{payload,topic}', 'three');
  perform t.eq('restore is not deleted', (t.head('session', r3::text) ->> 'deleted')::boolean, false);

  -- Deleting every row leaves the assignment.
  for r in select value from jsonb_array_elements(jsonb_build_array(r1, r2, r3)) loop
    perform t.one(t.d('session', r #>> '{}', t.head('session', r #>> '{}') ->> 'head_version_id'));
  end loop;
  perform t.eq('deleting all rows leaves the shell', (t.head('assignment', a::text) ->> 'deleted')::boolean, false);
  perform t.super();
end $$;

-- ---------------------------------------------------------------- whole-assignment deletion

do $$
declare
  a uuid := gen_random_uuid(); r1 uuid := gen_random_uuid(); r jsonb; h jsonb; v_meta text; rev bigint;
  v_cid text; other uuid := gen_random_uuid();
begin
  perform t.login('op1');
  perform t.apply(jsonb_build_array(t.c_assign(a, t.meta('Keep me')), t.c_row(a, r1, t.row('a', 'kept'))));
  h := t.head('assignment', a::text); v_meta := h ->> 'head_version_id'; rev := (h ->> 'aggregate_rev')::bigint;

  -- Every door an operator might try, also with an aal2 token and admin claims in metadata.
  perform t.raises('op: delete_assignment refused', t.q(t.del_a(a, rev)), 'avb:admin_required');
  perform t.login('op1', 'aal2');
  perform t.raises('op+aal2: delete_assignment refused', t.q(t.del_a(a, rev)), 'avb:admin_required');
  perform t.raises('op: generic delete on assignment', t.q(t.d('assignment', a::text, v_meta)), 'avb:use_delete_assignment');
  perform t.raises('op: restore_assignment refused', t.q(t.res_a(a, rev)), 'avb:admin_required');
  perform t.raises('op: null metadata', t.q(t.u('assignment', a::text, v_meta, 'null'::jsonb)), 'avb:payload_required');
  perform t.raises('op: empty metadata', t.q(t.u('assignment', a::text, v_meta, '{}'::jsonb)), 'avb:missing_field');
  perform t.raises('op: deleted flag in metadata', t.q(t.u('assignment', a::text, v_meta, t.meta('x') || '{"deleted":true}')), 'avb:unknown_field');
  perform t.raises('op: claims assignment is a session', t.q(t.d('session', a::text, v_meta)), 'avb:target_not_found');
  perform t.raises('op: session wearing the assignment uid', t.q(t.c_row(a, a, t.row('z'))), 'avb:uid_collision');
  perform t.raises('op: assignment wearing a session uid', t.q(t.c_assign(r1, t.meta('x'))), 'avb:uid_collision');
  perform t.raises('op: unknown type', t.q(jsonb_build_object('op', 'delete', 'type', 'targets', 'key', a, 'base_version_id', v_meta)), 'avb:unknown_target_type');
  perform t.raises('op: unknown op', t.q(jsonb_build_object('op', 'drop', 'type', 'assignment', 'key', a)), 'avb:unknown_op');
  r := t.one(t.c_assign(a, t.meta('Replaced!')));
  perform t.eq('op: re-create cannot overwrite, it conflicts', r ->> 'conflict_kind', 'create_collision');
  perform t.eq('op: re-create leaves the head', t.head('assignment', a::text) #>> '{payload,label}', 'Keep me');

  -- Direct table and helper access.
  perform t.raises('op: direct DELETE targets', format('delete from avb_private.targets where target_key = %L', a), '42501');
  perform t.raises('op: direct UPDATE targets', 'update avb_private.targets set deleted = true', '42501');
  perform t.raises('op: direct INSERT version', 'insert into avb_private.target_versions (target_id, action, accepted, actor_id, mutation_id) values (1, ''delete'', true, gen_random_uuid(), gen_random_uuid())', '42501');
  perform t.raises('op: direct SELECT versions', 'select * from avb_private.target_versions', '42501');
  perform t.raises('op: direct SELECT conflicts', 'select * from avb_private.conflicts', '42501');
  perform t.raises('op: direct SELECT mutations', 'select * from avb_private.mutations', '42501');
  perform t.raises('op: direct SELECT member audit', 'select * from avb_private.member_audit', '42501');
  perform t.raises('op: helper denied', format('select avb_private.apply_delete_assignment(null, %L, %L)', gen_random_uuid(), t.del_a(a, rev)), '42501');
  perform t.raises('op: touch denied', 'select avb_private.touch(1)', '42501');
  perform t.raises('op: set_member denied', $s$select avb_private.set_member('x', 'op1@test.invalid', 'admin', true)$s$, '42501');

  -- A token's `sub` must be present: no sub, no access, whatever else it carries.
  perform set_config('request.jwt.claims', '{"role":"authenticated","email":"admin1@test.invalid"}', false);
  perform t.raises('token without sub: refused', t.q(t.del_a(a, 0)), 'avb:not_authenticated');
  perform t.login('admin1', 'aal1');
  perform t.eq('assignment survived all of that', (t.head('assignment', a::text) ->> 'deleted')::boolean, false);
  perform t.eq('child survived all of that', t.head('session', r1::text) #>> '{payload,topic}', 'kept');

  -- Admin (no MFA needed): allowed, children untouched, restore brings all back.
  perform t.login('admin1', 'aal1');
  h := t.head('assignment', a::text); rev := (h ->> 'aggregate_rev')::bigint;
  r := t.one(t.del_a(a, rev));
  perform t.eq('admin: delete applied', r ->> 'status', 'applied');
  h := t.head('assignment', a::text);
  perform t.eq('assignment tombstone visible', (h ->> 'deleted')::boolean, true);
  perform t.eq('no cascade: child head unchanged', t.head('session', r1::text) #>> '{payload,topic}', 'kept');
  perform t.eq('delete again is a noop', t.one(t.del_a(a, (h ->> 'aggregate_rev')::bigint)) ->> 'status', 'noop');
  perform t.raises('restore with stale revision refused', t.q(t.res_a(a, rev)), 'avb:aggregate_rev_mismatch');
  perform t.login('op1');
  perform t.raises('op: cannot restore either', t.q(t.res_a(a, (h ->> 'aggregate_rev')::bigint)), 'avb:admin_required');

  perform t.login('admin1', 'aal2');
  r := t.one(t.res_a(a, (h ->> 'aggregate_rev')::bigint));
  perform t.eq('admin: restore applied', r ->> 'status', 'applied');
  perform t.eq('restore brings metadata back', t.head('assignment', a::text) #>> '{payload,label}', 'Keep me');
  perform t.super();
end $$;

-- ---------------------------------------------------------------- role escalation and revocation

do $$
declare a uuid := gen_random_uuid(); r1 uuid := gen_random_uuid(); r jsonb; v_base text; n int;
begin
  perform t.login('op1');
  perform t.raises('escalate: update members', format('update avb_private.members set role = ''admin'' where user_id = %L', t.uid('op1')), '42501');
  perform t.raises('escalate: insert member', format('insert into avb_private.members (user_id, role) values (%L, ''admin'')', t.uid('stranger')), '42501');
  perform t.raises('escalate: unknown top-level field', format('select public.avb_sync_apply(%L::jsonb)',
    jsonb_build_object('protocol_version', 1, 'mutation_id', gen_random_uuid(), 'operations', '[]'::jsonb, 'role', 'admin')), 'avb:unknown_field');
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname like 'avb\_%' and p.proname ~ '(member|role|grant)' and p.proname <> 'avb_team_members';
  perform t.eq('no role-granting RPC exists', n, 0);
  perform t.super();
  perform t.ok('no token-claimed admin: app_metadata role ignored', (select count(*) from avb_private.members where user_id = t.uid('op1') and role = 'operator') = 1);

  -- Inactive user with a token that would still verify.
  perform t.login('gone');
  perform t.apply(jsonb_build_array(t.c_assign(a, t.meta('By gone')), t.c_row(a, r1, t.row('a', 'x'))));
  v_base := t.head('session', r1::text) ->> 'head_version_id';
  perform t.super();
  set local role neondb_owner;
  perform avb_private.set_member(t.uid('gone'), 'gone@test.invalid', 'operator', false);
  perform t.super();

  perform t.login('gone', 'aal2');
  perform t.raises('revoked: me', 'select public.avb_me()', 'avb:not_member');
  perform t.raises('revoked: pull', $s$select public.avb_sync_pull('{"protocol_version":1}')$s$, 'avb:not_member');
  perform t.raises('revoked: conflicts', $s$select public.avb_conflicts('{"protocol_version":1}')$s$, 'avb:not_member');
  perform t.raises('revoked: history', format('select public.avb_target_history(%L::jsonb)', jsonb_build_object('protocol_version', 1, 'type', 'session', 'key', r1)), 'avb:not_member');
  perform t.raises('revoked: team list', 'select public.avb_team_members()', 'avb:not_member');
  perform t.raises('revoked: upload', t.q(t.u('session', r1::text, v_base, t.row('a', 'late'))), 'avb:not_member');
  -- Same for a demotion: the live role decides, whatever the token was issued with.
  perform t.login('op1');
  perform t.eq('revoked upload wrote nothing', t.head('session', r1::text) #>> '{payload,topic}', 'x');

  perform t.super();
  set local role neondb_owner;
  perform avb_private.set_member(t.uid('admin1'), 'admin1@test.invalid', 'operator', true);
  perform t.login('admin1', 'aal2');
  perform t.raises('demoted admin: delete refused at once', t.q(t.del_a(a, 0)), 'avb:admin_required');
  perform t.super();
  set local role neondb_owner;
  perform avb_private.set_member(t.uid('admin1'), 'admin1@test.invalid', 'admin', true);

  -- Reactivate; the audit trail recorded each change, naming the database role.
  perform avb_private.set_member(t.uid('gone'), 'gone@test.invalid', 'operator', true);
  select count(*) into n from avb_private.member_audit where user_id = t.uid('gone');
  perform t.eq('role changes are audited', n, 3);
  perform t.eq('audit names the maintainer role', (select db_user from avb_private.member_audit where user_id = t.uid('gone') order by audit_id desc limit 1), 'neondb_owner');
  perform t.raises('audit is append-only even for the owner', 'delete from avb_private.member_audit', 'avb:append_only');
  perform t.raises('versions are append-only even for the owner', 'update avb_private.target_versions set payload = null', 'avb:append_only');
  perform t.super();

end $$;

do $$
declare n int; v_id text := t.uid('deleted');
begin
  set local role neondb_owner;
  perform t.raises('history cannot be truncated by the owner', 'truncate avb_private.mutations cascade', 'avb:append_only');

  -- Sign-up is open on Neon: someone may register a future member's e-mail first. The
  -- maintainer names the account by id as well, so that account is not the one let in.
  perform t.raises('set_member refuses an e-mail that belongs to another id',
    format('select avb_private.set_member(%L, %L, ''operator'', true)', t.uid('stranger'), 'op1@test.invalid'), 'avb:no_such_auth_user');
  perform t.raises('set_member refuses an unknown id', $s$select avb_private.set_member('nobody', 'op1@test.invalid', 'operator', true)$s$, 'avb:no_such_auth_user');

  -- A deleted Better Auth account can still be switched off (its last token lives ~15 min).
  perform t.super();
  delete from neon_auth."user" where id = v_id;
  set local role neondb_owner;
  perform avb_private.set_member(v_id, '', 'operator', false);
  perform t.eq('switching off is audited', (select count(*)::int from avb_private.member_audit where user_id = v_id and action = 'UPDATE'), 1);
  perform t.raises('and cannot switch back on without the account', format('select avb_private.set_member(%L, ''deleted@test.invalid'', ''operator'', true)', v_id), 'avb:no_such_auth_user');
  perform t.super();
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_id, 'role', 'authenticated')::text, false);
  perform set_config('role', 'authenticated', false);
  perform t.raises('switched-off user with a live token: denied', 'select public.avb_me()', 'avb:not_member');
  perform t.super();

  -- RLS is the second lock: if a grant slips in one day, there is still no policy.
  grant select on avb_private.members to authenticated;
  perform t.login('op1');
  perform t.eq('RLS with no policy shows nothing even when granted', (select count(*)::int from avb_private.members), 0);
  perform t.super();
  revoke select on avb_private.members from authenticated;
end $$;

-- ---------------------------------------------------------------- conflicts on one target, merges on others

do $$
declare
  a uuid := gen_random_uuid(); r1 uuid := gen_random_uuid(); r2 uuid := gen_random_uuid();
  v_b1 text; v_b2 text; r jsonb; rr jsonb; c jsonb; v_head text; v_head2 text; v_cid text; v_rev bigint;
begin
  perform t.login('op1');
  perform t.apply(jsonb_build_array(t.c_assign(a, t.meta('C')), t.c_row(a, r1, t.row('a', 'base')), t.c_row(a, r2, t.row('b', 'base2'))));
  v_b1 := t.head('session', r1::text) ->> 'head_version_id';
  v_b2 := t.head('session', r2::text) ->> 'head_version_id';

  -- Both offline from the same state: different rows merge.
  r := t.one(t.u('session', r1::text, v_b1, t.row('a', 'op1 value')));
  perform t.login('op2');
  rr := t.one(t.u('session', r2::text, v_b2, t.row('b', 'op2 value')));
  perform t.eq('different rows: first applied', r ->> 'status', 'applied');
  perform t.eq('different rows: second applied', rr ->> 'status', 'applied');
  perform t.eq('different rows: both visible', t.head('session', r1::text) #>> '{payload,topic}', 'op1 value');

  -- Same row, other value: both values kept and discoverable, the head does not move.
  r := t.one(t.u('session', r1::text, v_b1, t.row('a', 'op2 stale value')));
  perform t.eq('stale edit: conflict', r ->> 'status', 'conflict');
  perform t.eq('stale edit: kind', r ->> 'conflict_kind', 'stale_edit');
  perform t.eq('stale edit: no timestamp winner', t.head('session', r1::text) #>> '{payload,topic}', 'op1 value');
  perform t.eq('stale edit: count visible in pull', (t.head('session', r1::text) ->> 'open_conflicts')::int, 1);
  v_cid := r ->> 'conflict_id';
  c := t.open_conflicts(a) -> 0;
  perform t.eq('conflict lists incoming', c #>> '{incoming,payload,topic}', 'op2 stale value');
  perform t.eq('conflict lists current', c #>> '{current_head,payload,topic}', 'op1 value');
  perform t.eq('conflict lists base', c #>> '{base,payload,topic}', 'base');
  perform t.eq('conflict names who sent it', (c #>> '{incoming,actor_id}'), t.uid('op2'));

  -- Same stale value again: coalesced. Same as head: no conflict at all.
  perform t.eq('same stale value coalesces', t.one(t.u('session', r1::text, v_b1, t.row('a', 'op2 stale value'))) ->> 'conflict_id', v_cid);
  perform t.eq('stale edit equal to head is a noop', t.one(t.u('session', r1::text, v_b1, t.row('a', 'op1 value'))) ->> 'status', 'noop');
  perform t.eq('no extra conflict from those', jsonb_array_length(t.open_conflicts(a)), 1);

  -- An ordinary edit on the current head leaves the conflict open.
  v_head := t.head('session', r1::text) ->> 'head_version_id';
  r := t.one(t.u('session', r1::text, v_head, t.row('a', 'op2 moved on')));
  perform t.eq('edit on head still applies', r ->> 'status', 'applied');
  perform t.eq('ordinary edit does not resolve a conflict', (t.head('session', r1::text) ->> 'open_conflicts')::int, 1);
  perform t.eq('value at detection is still reported', t.open_conflicts(a) #>> '{0,detected_head,payload,topic}', 'op1 value');

  -- Resolving requires the head the resolver saw.
  perform t.raises('resolve against old head refused', t.q(t.resolve(v_cid, v_head, 'accept_incoming')), 'avb:stale_resolution');
  perform t.raises('resolve without head refused', t.q(t.resolve(v_cid, null, 'keep_current')), 'avb:stale_resolution');
  v_head := t.head('session', r1::text) ->> 'head_version_id';
  perform t.raises('merged needs a payload', t.q(t.resolve(v_cid, v_head, 'merged')), 'avb:payload_only_for_merged');
  perform t.raises('accept takes no payload', t.q(t.resolve(v_cid, v_head, 'accept_incoming', t.row('a'))), 'avb:payload_only_for_merged');
  perform t.raises('merged payload is validated', t.q(t.resolve(v_cid, v_head, 'merged', '{"orderKey":"a"}')), 'avb:missing_field');
  perform t.raises('bad resolution word', t.q(t.resolve(v_cid, v_head, 'latest_wins')), 'avb:invalid_resolution');
  r := t.one(t.resolve(v_cid, v_head, 'merged', t.row('a', 'merged by hand')));
  perform t.eq('resolve: status', r ->> 'status', 'resolved');
  perform t.eq('resolve: value', t.head('session', r1::text) #>> '{payload,topic}', 'merged by hand');
  perform t.eq('resolve: closes', (t.head('session', r1::text) ->> 'open_conflicts')::int, 0);
  perform t.raises('resolve twice refused', t.q(t.resolve(v_cid, r ->> 'version_id', 'keep_current')), 'avb:conflict_not_open');
  perform t.eq('every value stays in history',
    jsonb_array_length(public.avb_target_history(jsonb_build_object('protocol_version', 1, 'type', 'session', 'key', r1)) -> 'items'), 5);
  perform t.eq('resolved conflict listed under resolved',
    public.avb_conflicts(jsonb_build_object('protocol_version', 1, 'status', 'resolved', 'assignment_key', a)) #>> '{items,0,resolution}', 'merged');

  -- keep_current and accept_incoming.
  v_b2 := t.head('session', r2::text) ->> 'head_version_id';
  perform t.one(t.u('session', r2::text, v_b2, t.row('b', 'v2')));
  r := t.one(t.u('session', r2::text, v_b2, t.row('b', 'alt')));
  v_head := t.head('session', r2::text) ->> 'head_version_id';
  perform t.one(t.resolve(r ->> 'conflict_id', v_head, 'keep_current'));
  perform t.eq('keep_current keeps', t.head('session', r2::text) #>> '{payload,topic}', 'v2');
  r := t.one(t.u('session', r2::text, v_b2, t.row('b', 'alt2')));
  perform t.one(t.resolve(r ->> 'conflict_id', v_head, 'accept_incoming'));
  perform t.eq('accept_incoming takes it', t.head('session', r2::text) #>> '{payload,topic}', 'alt2');

  -- Row delete vs edit, each way round.
  v_head := t.head('session', r2::text) ->> 'head_version_id';
  perform t.one(t.u('session', r2::text, v_head, t.row('b', 'edited after you looked')));
  r := t.one(t.d('session', r2::text, v_head));
  perform t.eq('stale row delete does not delete', r ->> 'conflict_kind', 'delete_vs_edit');
  perform t.eq('stale row delete: edit stays', (t.head('session', r2::text) ->> 'deleted')::boolean, false);
  perform t.one(t.resolve(r ->> 'conflict_id', t.head('session', r2::text) ->> 'head_version_id', 'keep_current'));
  v_head := t.head('session', r2::text) ->> 'head_version_id';
  perform t.one(t.d('session', r2::text, v_head));
  r := t.one(t.u('session', r2::text, v_head, t.row('b', 'edit of a row someone deleted')));
  perform t.eq('edit of deleted row: conflict', r ->> 'conflict_kind', 'edit_vs_delete');
  perform t.eq('edit of deleted row: stays deleted', (t.head('session', r2::text) ->> 'deleted')::boolean, true);
  perform t.one(t.resolve(r ->> 'conflict_id', t.head('session', r2::text) ->> 'head_version_id', 'accept_incoming'));
  perform t.eq('resolve brings the edit back', t.head('session', r2::text) #>> '{payload,topic}', 'edit of a row someone deleted');

  -- A deletion chosen in a resolve is still a tombstone that can be restored.
  v_head := t.head('session', r2::text) ->> 'head_version_id';
  perform t.one(t.u('session', r2::text, v_head, t.row('b', 'value before resolved delete')));
  r := t.one(t.d('session', r2::text, v_head));
  perform t.one(t.resolve(r ->> 'conflict_id', t.head('session', r2::text) ->> 'head_version_id', 'accept_incoming'));
  perform t.eq('resolved delete is a tombstone', (t.head('session', r2::text) ->> 'deleted')::boolean, true);
  perform t.one(jsonb_build_object('op', 'restore', 'type', 'session', 'key', r2, 'base_version_id', t.head('session', r2::text) ->> 'head_version_id'));
  perform t.eq('and restore finds the last value', t.head('session', r2::text) #>> '{payload,topic}', 'value before resolved delete');
  perform t.raises('restore needs a tombstone as base', t.q(jsonb_build_object('op', 'restore', 'type', 'session', 'key', r2, 'base_version_id', t.head('session', r2::text) ->> 'head_version_id')), 'avb:restore_base_not_tombstone');
  perform t.super();
end $$;

-- ---------------------------------------------------------------- parent deletion vs children

do $$
declare
  a uuid := gen_random_uuid(); r1 uuid := gen_random_uuid(); r2 uuid := gen_random_uuid(); unseen uuid := gen_random_uuid();
  v_b1 text; v_b2 text; r jsonb; h jsonb; v_rev bigint; v_stale jsonb; v_edit text; v_new text; v_meta_c text; v_meta text; n int;
begin
  perform t.login('op1');
  perform t.apply(jsonb_build_array(t.c_assign(a, t.meta('Race')), t.c_row(a, r1, t.row('a', 'one')), t.c_row(a, r2, t.row('b', 'two'))));
  v_b1 := t.head('session', r1::text) ->> 'head_version_id';
  v_b2 := t.head('session', r2::text) ->> 'head_version_id';
  v_meta := t.head('assignment', a::text) ->> 'head_version_id';
  v_rev := (t.head('assignment', a::text) ->> 'aggregate_rev')::bigint;

  -- A child edit bumps the revision: an admin who hasn't seen it can't delete over it.
  perform t.one(t.u('session', r1::text, v_b1, t.row('a', 'edit the admin did not see')));
  perform t.login('admin1', 'aal2');
  r := t.one(t.del_a(a, v_rev));
  perform t.eq('stale delete: conflict', r ->> 'conflict_kind', 'assignment_delete_stale');
  perform t.eq('stale delete: assignment lives', (t.head('assignment', a::text) ->> 'deleted')::boolean, false);
  perform t.eq('stale delete: edit is visible', t.head('session', r1::text) #>> '{payload,topic}', 'edit the admin did not see');

  -- The operator can neither convert that attempt into a deletion nor make it disappear.
  perform t.login('op1', 'aal2');
  perform t.raises('op cannot accept a delete attempt', t.q(t.resolve(r ->> 'conflict_id', t.head('assignment', a::text) ->> 'head_version_id', 'accept_incoming')), 'avb:admin_required');
  perform t.raises('op cannot dismiss a delete attempt', t.q(t.resolve(r ->> 'conflict_id', t.head('assignment', a::text) ->> 'head_version_id', 'keep_current')), 'avb:admin_required');
  perform t.login('admin1', 'aal2');
  perform t.raises('admin cannot accept it either: redo the delete', t.q(t.resolve(r ->> 'conflict_id', t.head('assignment', a::text) ->> 'head_version_id', 'accept_incoming')), 'avb:use_delete_assignment');
  perform t.login('admin1', 'aal2');
  perform t.one(t.resolve(r ->> 'conflict_id', t.head('assignment', a::text) ->> 'head_version_id', 'keep_current'));

  -- Admin reviews, then deletes against the revision now current.
  h := t.head('assignment', a::text);
  perform t.eq('fresh delete: applied', t.one(t.del_a(a, (h ->> 'aggregate_rev')::bigint)) ->> 'status', 'applied');

  -- Devices that have not seen the deletion: every edit is kept, nothing comes back.
  perform t.login('op2');
  r := t.one(t.u('session', r2::text, v_b2, t.row('b', 'offline edit')));
  perform t.eq('edit after parent delete: conflict', r ->> 'conflict_kind', 'parent_deleted');
  v_edit := r ->> 'conflict_id';
  r := t.one(t.c_row(a, unseen, t.row('c', 'new row while deleted')));
  perform t.eq('new row after parent delete: conflict', r ->> 'conflict_kind', 'parent_deleted');
  v_new := r ->> 'conflict_id';
  perform t.eq('new row: no head yet', t.head('session', unseen::text) -> 'head_version_id', 'null'::jsonb);
  perform t.eq('new row: value in the conflict', (t.open_conflicts(a) -> 1) #>> '{incoming,payload,topic}', 'new row while deleted');
  r := t.one(t.u('assignment', a::text, v_meta, t.meta('offline rename')));
  perform t.eq('metadata edit after delete: conflict', r ->> 'conflict_kind', 'parent_deleted');
  v_meta_c := r ->> 'conflict_id';
  perform t.eq('edits did not resurrect the assignment', (t.head('assignment', a::text) ->> 'deleted')::boolean, true);
  perform t.eq('edit did not move the child head', t.head('session', r2::text) #>> '{payload,topic}', 'two');
  perform t.eq('edits are all discoverable', jsonb_array_length(t.open_conflicts(a)), 3);
  perform t.raises('accept while parent deleted refused', t.q(t.resolve(v_edit, v_b2, 'accept_incoming')), 'avb:parent_deleted');

  -- Admin restores; conflicts stay open until someone chooses.
  perform t.login('admin1', 'aal2');
  h := t.head('assignment', a::text);
  perform t.one(t.res_a(a, (h ->> 'aggregate_rev')::bigint));
  perform t.eq('restore does not apply queued edits', t.head('session', r2::text) #>> '{payload,topic}', 'two');
  perform t.eq('conflicts survive restore', jsonb_array_length(t.open_conflicts(a)), 3);
  perform t.login('op1');
  perform t.one(t.resolve(v_edit, v_b2, 'accept_incoming'));
  perform t.eq('edit accepted after restore', t.head('session', r2::text) #>> '{payload,topic}', 'offline edit');
  perform t.one(t.resolve(v_new, null, 'accept_incoming'));
  perform t.eq('new row accepted after restore', t.head('session', unseen::text) #>> '{payload,topic}', 'new row while deleted');
  perform t.one(t.resolve(v_meta_c, t.head('assignment', a::text) ->> 'head_version_id', 'keep_current'));
  perform t.eq('metadata conflict closed', jsonb_array_length(t.open_conflicts(a)), 0);
  perform t.super();
end $$;

-- ---------------------------------------------------------------- idempotency and atomicity

do $$
declare
  a uuid := gen_random_uuid(); r1 uuid := gen_random_uuid(); mid uuid := gen_random_uuid(); ops jsonb; r1st jsonb; r2nd jsonb; n int; v_after bigint;
  b uuid := gen_random_uuid(); bad uuid := gen_random_uuid(); v_seq bigint;
begin
  perform t.login('op1');
  ops := jsonb_build_array(t.c_assign(a, t.meta('Idem')), t.c_row(a, r1, t.row('a', 'once')));
  r1st := t.apply(ops, mid);
  r2nd := t.apply(ops, mid);
  perform t.eq('replay: identical response', r2nd, r1st);
  perform t.eq('replay: one version only',
    jsonb_array_length(public.avb_target_history(jsonb_build_object('protocol_version', 1, 'type', 'session', 'key', r1)) -> 'items'), 1);
  perform t.raises('same id, other content refused', format('select t.apply(%L::jsonb, %L::uuid)',
    jsonb_build_array(t.c_row(a, gen_random_uuid(), t.row('z'))), mid), 'avb:mutation_id_reused');
  perform t.login('op2');
  perform t.raises('same id, other user refused', format('select t.apply(%L::jsonb, %L::uuid)', ops, mid), 'avb:mutation_id_reused');

  -- Atomic: a bad last op leaves nothing, and the id stays free.
  perform t.login('op1');
  mid := gen_random_uuid();
  ops := jsonb_build_array(t.c_assign(b, t.meta('Atomic')), t.c_row(b, bad, t.row('a', 'x')), jsonb_build_object('op', 'update', 'type', 'session', 'key', r1, 'base_version_id', gen_random_uuid(), 'payload', t.row('a', 'never')));
  perform t.raises('atomic: batch fails', format('select t.apply(%L::jsonb, %L::uuid)', ops, mid), 'avb:base_version_mismatch');
  perform t.eq('atomic: first op rolled back', t.head('assignment', b::text), null::jsonb);
  perform t.eq('atomic: second op rolled back', t.head('session', bad::text), null::jsonb);
  ops := jsonb_build_array(t.c_assign(b, t.meta('Atomic')), t.c_row(b, bad, t.row('a', 'x')));
  perform t.eq('atomic: failed id can be retried', t.apply(ops, mid) #>> '{results,1,status}', 'applied');
  perform t.super();
end $$;

-- ---------------------------------------------------------------- validation and bounds

do $$
declare
  a uuid := gen_random_uuid(); r1 uuid := gen_random_uuid(); other uuid := gen_random_uuid(); v_base text; v_other text; big text := repeat('x', 40000);
begin
  perform t.login('op1');
  perform t.apply(jsonb_build_array(t.c_assign(a, t.meta('V')), t.c_row(a, r1, t.row('a'))));
  perform t.apply(jsonb_build_array(t.c_assign(other, t.meta('W'))));
  v_base := t.head('session', r1::text) ->> 'head_version_id';
  v_other := t.head('assignment', other::text) ->> 'head_version_id';

  perform t.raises('protocol: wrong version', format('select public.avb_sync_apply(%L::jsonb)', jsonb_build_object('protocol_version', 2, 'mutation_id', gen_random_uuid(), 'operations', jsonb_build_array(t.c_row(a, gen_random_uuid(), t.row('z'))))), 'avb:protocol_version_unsupported');
  perform t.raises('protocol: missing version', format('select public.avb_sync_apply(%L::jsonb)', jsonb_build_object('mutation_id', gen_random_uuid(), 'operations', '[]'::jsonb)), 'avb:protocol_version_unsupported');
  perform t.raises('pull: wrong version', $s$select public.avb_sync_pull('{"protocol_version":2}')$s$, 'avb:protocol_version_unsupported');
  perform t.raises('bad mutation id', format('select public.avb_sync_apply(%L::jsonb)', jsonb_build_object('protocol_version', 1, 'mutation_id', 'nope', 'operations', '[]'::jsonb)), 'avb:invalid_uuid');
  perform t.raises('empty batch', format('select public.avb_sync_apply(%L::jsonb)', jsonb_build_object('protocol_version', 1, 'mutation_id', gen_random_uuid(), 'operations', '[]'::jsonb)), 'avb:invalid_operations');
  perform t.raises('batch over 500', format('select t.apply(%L::jsonb)', (select jsonb_agg(t.c_row(a, gen_random_uuid(), t.row('z'))) from generate_series(1, 501))), 'avb:invalid_operations');
  perform t.raises('request over 2 MiB', format('select t.apply(%L::jsonb)', (select jsonb_agg(t.c_row(a, gen_random_uuid(), t.row('z', repeat('y', 900)) || jsonb_build_object('source', repeat('y', 3900)))) from generate_series(1, 500))), 'avb:request_too_large');
  perform t.raises('same target twice in a batch', format('select t.apply(%L::jsonb)', jsonb_build_array(t.u('session', r1::text, v_base, t.row('a', '1')), t.u('session', r1::text, v_base, t.row('a', '2')))), 'avb:duplicate_target_in_batch');
  perform t.raises('base belongs to another target', t.q(t.u('session', r1::text, v_other, t.row('a', 'x'))), 'avb:base_version_mismatch');
  perform t.raises('non-existent base', t.q(t.u('session', r1::text, gen_random_uuid()::text, t.row('a', 'x'))), 'avb:base_version_mismatch');
  perform t.raises('update without base', t.q(jsonb_build_object('op', 'update', 'type', 'session', 'key', r1, 'payload', t.row('a'))), 'avb:invalid_uuid');
  perform t.raises('session on missing assignment', t.q(t.c_row(gen_random_uuid(), gen_random_uuid(), t.row('z'))), 'avb:assignment_not_found');
  perform t.raises('session uid in another assignment', t.q(t.c_row(other, r1, t.row('z'))), 'avb:uid_assignment_mismatch');
  perform t.raises('session uid must be a uuid', t.q(jsonb_build_object('op', 'create', 'type', 'session', 'key', '17', 'assignment_key', a, 'payload', t.row('z'))), 'avb:invalid_key');
  perform t.raises('session needs its assignment', t.q(jsonb_build_object('op', 'create', 'type', 'session', 'key', gen_random_uuid(), 'payload', t.row('z'))), 'avb:assignment_key_only_for_children');
  perform t.raises('unknown op field', t.q(t.c_row(a, gen_random_uuid(), t.row('z')) || '{"actor_id":"00000000-0000-0000-0000-000000000000"}'), 'avb:unknown_field');
  perform t.raises('forged actor in payload', t.q(t.c_row(a, gen_random_uuid(), t.row('z') || '{"actor_id":"00000000-0000-0000-0000-000000000000"}')), 'avb:unknown_field');

  -- Local-only data has no field to travel in.
  perform t.raises('local path field', t.q(t.c_assign(gen_random_uuid(), t.meta('x') || '{"file":"C:\\Users\\a\\poster.pdf"}')), 'avb:unknown_field');
  perform t.raises('path as basename (windows)', t.q(t.c_assign(gen_random_uuid(), jsonb_build_object('label', 'x', 'sourceBasename', 'C:\Users\a\p.pdf'))), 'avb:invalid_field');
  perform t.raises('path as basename (mac)', t.q(t.c_assign(gen_random_uuid(), jsonb_build_object('label', 'x', 'sourceBasename', '/Users/a/p.pdf'))), 'avb:invalid_field');
  perform t.raises('scan state refused', t.q(t.c_assign(gen_random_uuid(), t.meta('x') || '{"scan":{"root":"/Volumes/SSD"}}')), 'avb:unknown_field');
  perform t.raises('colWidths refused', t.q(jsonb_build_object('op', 'create', 'type', 'team_defaults', 'key', 'team', 'payload', '{"colWidths":{}}'::jsonb)), 'avb:unknown_field');
  perform t.raises('session runtime key refused', t.q(t.c_row(a, gen_random_uuid(), t.row('z') || '{"busy":true}')), 'avb:unknown_field');
  perform t.raises('numeric row key refused', t.q(t.c_row(a, gen_random_uuid(), t.row('z') || '{"key":17}')), 'avb:unknown_field');

  -- Types, sizes, formats.
  perform t.raises('topic too long', t.q(t.c_row(a, gen_random_uuid(), t.row('z', repeat('x', 1001)))), 'avb:invalid_field');
  perform t.raises('payload over 32 KiB', t.q(t.c_row(a, gen_random_uuid(), t.row('z') || jsonb_build_object('events', (select jsonb_agg(repeat('x', 200)) from generate_series(1, 200))))), 'avb:payload_too_large');
  perform t.raises('too many events', t.q(t.c_row(a, gen_random_uuid(), t.row('z') || jsonb_build_object('events', (select jsonb_agg('x'::text) from generate_series(1, 65))))), 'avb:invalid_field');
  perform t.raises('event not text', t.q(t.c_row(a, gen_random_uuid(), t.row('z') || '{"events":[1]}')), 'avb:invalid_field');
  perform t.raises('impossible date', t.q(t.c_row(a, gen_random_uuid(), t.row('z') || '{"date":"2026-02-31"}')), 'avb:invalid_field');
  perform t.raises('include not boolean', t.q(t.c_row(a, gen_random_uuid(), t.row('z') || '{"include":"yes"}')), 'avb:invalid_field');
  perform t.raises('order key with spaces', t.q(t.c_row(a, gen_random_uuid(), t.row('a b'))), 'avb:invalid_field');
  perform t.raises('order key required', t.q(t.c_row(a, gen_random_uuid(), t.row('z') - 'orderKey')), 'avb:missing_field');
  perform t.raises('array payload', t.q(t.c_row(a, gen_random_uuid(), '[]'::jsonb)), 'avb:payload_required');
  perform t.raises('nested defaults are checked', t.q(t.c_assign(gen_random_uuid(), t.meta('x') || '{"defaults":{"theme":"dark"}}')), 'avb:unknown_field');
  perform t.raises('singleton key fixed', t.q(jsonb_build_object('op', 'create', 'type', 'team_starts', 'key', 'other', 'payload', '{"formal":1}'::jsonb)), 'avb:invalid_key');
  perform t.raises('natural key must match record', t.q(jsonb_build_object('op', 'create', 'type', 'city', 'key', 'anand', 'payload', '{"name":"Baroda","city":"Baroda"}'::jsonb)), 'avb:invalid_key');
  perform t.raises('natural key must be normal form', t.q(jsonb_build_object('op', 'create', 'type', 'city', 'key', 'Anand', 'payload', '{"name":"Anand","city":"Anand"}'::jsonb)), 'avb:invalid_key');

  -- Reads are bounded as well.
  perform t.raises('pull limit over max', $s$select public.avb_sync_pull('{"protocol_version":1,"limit":501}')$s$, 'avb:out_of_range');
  perform t.raises('pull limit zero', $s$select public.avb_sync_pull('{"protocol_version":1,"limit":0}')$s$, 'avb:out_of_range');
  perform t.raises('pull negative cursor', $s$select public.avb_sync_pull('{"protocol_version":1,"after":-1}')$s$, 'avb:out_of_range');
  perform t.raises('pull non-integer cursor', $s$select public.avb_sync_pull('{"protocol_version":1,"after":1.5}')$s$, 'avb:out_of_range');
  perform t.raises('pull unknown field', $s$select public.avb_sync_pull('{"protocol_version":1,"table":"members"}')$s$, 'avb:unknown_field');
  perform t.raises('conflicts limit over max', $s$select public.avb_conflicts('{"protocol_version":1,"limit":101}')$s$, 'avb:out_of_range');
  perform t.raises('history limit over max', format('select public.avb_target_history(%L::jsonb)', jsonb_build_object('protocol_version', 1, 'type', 'session', 'key', r1, 'limit', 101)), 'avb:out_of_range');
  perform t.raises('history bad target', $s$select public.avb_target_history('{"protocol_version":1,"type":"members","key":"x"}')$s$, 'avb:target_not_found');
  perform t.super();
end $$;

-- ---------------------------------------------------------------- every shared dataset type

do $$
declare r jsonb; v text;
begin
  perform t.login('op1');
  r := t.apply(jsonb_build_array(
    jsonb_build_object('op', 'create', 'type', 'city', 'key', 'anand (gj)', 'payload', '{"name":"Anand (GJ)","city":"Anand","state":"Gujarat","country":"India"}'::jsonb),
    jsonb_build_object('op', 'create', 'type', 'report_record', 'key', 'DD-I-DV-1498-1', 'payload', '{"id":"DD-I-DV-1498-1","folder":1498,"session":"1","date":"2020-01-02","events":["Satsang"],"clips":3}'::jsonb),
    jsonb_build_object('op', 'create', 'type', 'team_defaults', 'key', 'team', 'payload', '{"author":"DD","format":"HD","camsFormal":3,"camsInformal":1}'::jsonb),
    jsonb_build_object('op', 'create', 'type', 'team_starts', 'key', 'team', 'payload', '{"formal":10,"informal":20}'::jsonb),
    jsonb_build_object('op', 'create', 'type', 'learned_title', 'key', 'new year', 'payload', '{"key":"New Year","topic":"Darshan","events":["New Year"]}'::jsonb),
    jsonb_build_object('op', 'create', 'type', 'learned_place', 'key', 'hall a', 'payload', '{"key":"Hall A","place":"Main Hall","city":"Anand"}'::jsonb)));
  perform t.eq('all dataset types apply', (select count(*) from jsonb_array_elements(r -> 'results') e where e ->> 'status' = 'applied')::int, 6);
  perform t.eq('report record round-trips', t.head('report_record', 'DD-I-DV-1498-1') #>> '{payload,folder}', '1498');
  -- Two devices importing one sheet: same record coalesces, other value conflicts.
  perform t.login('op2');
  r := t.one(jsonb_build_object('op', 'create', 'type', 'city', 'key', 'anand (gj)', 'payload', '{"name":"Anand (GJ)","city":"Anand","state":"Gujarat","country":"India"}'::jsonb));
  perform t.eq('same import: noop', r ->> 'status', 'noop');
  r := t.one(jsonb_build_object('op', 'create', 'type', 'city', 'key', 'anand (gj)', 'payload', '{"name":"Anand (GJ)","city":"Anand","state":"Other"}'::jsonb));
  perform t.eq('different import: conflict', r ->> 'conflict_kind', 'create_collision');
  v := t.head('team_starts', 'team') ->> 'head_version_id';
  perform t.raises('shared starts cannot be deleted', t.q(t.d('team_starts', 'team', v)), 'avb:not_deletable');
  perform t.super();
end $$;

-- ---------------------------------------------------------------- pull pagination, with tombstones

do $$
declare
  a uuid := gen_random_uuid(); ids uuid[]; i int; v_cursor bigint; v_start bigint; r jsonb; seen text[] := '{}'; pages int := 0;
  v_tomb text; v_del jsonb; n int; h jsonb; v_cur bigint;
begin
  perform t.login('op1');
  v_start := (public.avb_sync_pull(jsonb_build_object('protocol_version', 1, 'after', 0, 'limit', 500)) ->> 'next_cursor')::bigint;
  loop
    r := public.avb_sync_pull(jsonb_build_object('protocol_version', 1, 'after', v_start, 'limit', 500));
    exit when not (r ->> 'has_more')::boolean;
    v_start := (r ->> 'next_cursor')::bigint;
  end loop;
  v_start := (r ->> 'next_cursor')::bigint;

  select array_agg(gen_random_uuid()) into ids from generate_series(1, 5);
  perform t.apply(jsonb_build_array(t.c_assign(a, t.meta('Page'))) ||
    (select jsonb_agg(t.c_row(a, x, t.row('a'))) from unnest(ids) x));
  perform t.one(t.d('session', ids[1]::text, t.head('session', ids[1]::text) ->> 'head_version_id'));

  v_cursor := v_start;
  loop
    r := public.avb_sync_pull(jsonb_build_object('protocol_version', 1, 'after', v_cursor, 'limit', 2));
    pages := pages + 1;
    perform t.ok('pull page is bounded', jsonb_array_length(r -> 'items') <= 2);
    for h in select value from jsonb_array_elements(r -> 'items') loop
      seen := seen || (h ->> 'target_key');
      if h ->> 'target_key' = ids[1]::text then v_del := h; end if;
    end loop;
    perform t.ok('cursor advances', (r ->> 'next_cursor')::bigint > v_cursor or jsonb_array_length(r -> 'items') = 0);
    v_cursor := (r ->> 'next_cursor')::bigint;
    exit when not (r ->> 'has_more')::boolean or pages > 50;
  end loop;
  perform t.ok('pull took several pages', pages >= 3, pages::text);
  perform t.eq('walk saw each changed target once', cardinality(seen), 6);
  perform t.ok('walk saw all rows', seen @> (select array_agg(x::text) from unnest(ids) x));
  perform t.eq('tombstone comes through the walk', (v_del ->> 'deleted')::boolean, true);
  perform t.eq('tombstone has no value', v_del -> 'payload', 'null'::jsonb);
  r := public.avb_sync_pull(jsonb_build_object('protocol_version', 1, 'after', v_cursor));
  perform t.eq('caught up: empty', jsonb_array_length(r -> 'items'), 0);
  perform t.eq('caught up: cursor stays', (r ->> 'next_cursor')::bigint, v_cursor);

  -- A change after a saved cursor shows up, with the assignment's new revision.
  perform t.one(t.u('session', ids[2]::text, t.head('session', ids[2]::text) ->> 'head_version_id', t.row('a', 'later')));
  r := public.avb_sync_pull(jsonb_build_object('protocol_version', 1, 'after', v_cursor));
  perform t.eq('resume: child and assignment', jsonb_array_length(r -> 'items'), 2);
  perform t.super();

  -- History pages too.
  perform t.login('op2');
  for i in 1 .. 5 loop
    perform t.one(t.u('session', ids[3]::text, t.head('session', ids[3]::text) ->> 'head_version_id', t.row('a', 'h' || i)));
  end loop;
  r := public.avb_target_history(jsonb_build_object('protocol_version', 1, 'type', 'session', 'key', ids[3], 'limit', 4));
  perform t.eq('history: newest first', r #>> '{items,0,payload,topic}', 'h5');
  perform t.eq('history: has more', (r ->> 'has_more')::boolean, true);
  r := public.avb_target_history(jsonb_build_object('protocol_version', 1, 'type', 'session', 'key', ids[3], 'limit', 4, 'before', (r ->> 'next_before')::bigint));
  perform t.eq('history: second page ends', jsonb_array_length(r -> 'items'), 2);
  perform t.eq('history: oldest last', r #>> '{items,1,action}', 'create');
  perform t.eq('history: no more', (r ->> 'has_more')::boolean, false);
  perform t.eq('team list has names', (select count(*) from jsonb_array_elements(public.avb_team_members()) e where e ->> 'display_name' = 'Op One')::int, 1);
  perform t.super();
end $$;

-- ---------------------------------------------------------------- session geo/startedAt and source content

create function t.line(p_a uuid, p_line int, p_part int, p_cells jsonb, p_cont boolean default false) returns jsonb language sql as $$
  select jsonb_build_object('op', 'create', 'type', 'source_line', 'key', format('%s:%s:%s', p_a, p_line, p_part), 'assignment_key', p_a,
    'payload', jsonb_build_object('line', p_line, 'part', p_part, 'cells', p_cells, 'continuesCell', p_cont)) $$;
create function t.skip(p_a uuid, p_i int, p_days jsonb) returns jsonb language sql as $$
  select jsonb_build_object('op', 'create', 'type', 'source_skip', 'key', format('%s:%s', p_a, p_i), 'assignment_key', p_a,
    'payload', jsonb_build_object('index', p_i, 'days', p_days, 'reason', 'break', 'rowText', '20" Oct, Tue | us')) $$;
grant execute on all functions in schema t to anonymous, authenticated, neondb_owner;

do $$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); r1 uuid := gen_random_uuid(); r jsonb; h jsonb; v_rev bigint; v_base text;
begin
  perform t.login('op1');
  perform t.apply(jsonb_build_array(t.c_assign(a, t.meta('Src')), t.c_assign(b, t.meta('Other')),
    t.c_row(a, r1, t.row('a') || '{"city":"Anand","geo":"Anand (MH)","startedAt":"2026-11-07T10:15:00.000Z"}')));
  h := t.head('session', r1::text);
  perform t.eq('geo survives', h #>> '{payload,geo}', 'Anand (MH)');
  perform t.eq('startedAt survives', h #>> '{payload,startedAt}', '2026-11-07T10:15:00.000Z');
  perform t.raises('geo too long', t.q(t.c_row(a, gen_random_uuid(), t.row('z') || jsonb_build_object('geo', repeat('x', 301)))), 'avb:invalid_field');
  perform t.raises('geo not text', t.q(t.c_row(a, gen_random_uuid(), t.row('z') || '{"geo":5}')), 'avb:invalid_field');
  perform t.raises('startedAt not a time', t.q(t.c_row(a, gen_random_uuid(), t.row('z') || '{"startedAt":"running"}')), 'avb:invalid_field');
  perform t.eq('null geo and startedAt allowed', t.one(t.c_row(a, gen_random_uuid(), t.row('z') || '{"geo":null,"startedAt":null}')) ->> 'status', 'applied');

  r := t.apply(jsonb_build_array(t.line(a, 0, 0, '["14 Oct, Wed","us"]'), t.line(a, 1, 0, '["a","b"]'), t.line(a, 1, 1, '["c"]', true),
                                 t.skip(a, 0, '["2026-10-20","2026-10-21"]')));
  perform t.eq('source lines and skips apply', (select count(*)::int from jsonb_array_elements(r -> 'results') e where e ->> 'status' = 'applied'), 4);
  perform t.eq('source line belongs to its assignment', t.head('source_line', a || ':1:1') ->> 'assignment_key', a::text);
  perform t.eq('raw cell kept exactly', t.head('source_line', a || ':0:0') #>> '{payload,cells,0}', '14 Oct, Wed');
  perform t.raises('line key must match payload', t.q(jsonb_set(t.line(a, 2, 0, '["x"]'), '{payload,line}', '3')), 'avb:invalid_key');
  perform t.raises('line key must name its assignment', t.q(jsonb_set(t.line(a, 2, 0, '["x"]'), '{assignment_key}', to_jsonb(b))), 'avb:invalid_key');
  perform t.raises('line key format', t.q(jsonb_set(t.line(a, 2, 0, '["x"]'), '{key}', to_jsonb(a || ':2'))), 'avb:invalid_key');
  perform t.raises('line needs a cells array', t.q(t.line(a, 2, 0, '{}')), 'avb:invalid_field');
  perform t.raises('cells are strings', t.q(t.line(a, 2, 0, '[1]')), 'avb:invalid_field');
  perform t.raises('cells are bounded', t.q(t.line(a, 2, 0, (select jsonb_agg('x'::text) from generate_series(1, 257)))), 'avb:invalid_field');
  perform t.raises('line part is a payload, not a blob', t.q(t.line(a, 2, 0, jsonb_build_array(repeat('y', 33000)))), 'avb:payload_too_large');
  perform t.raises('line number is an integer', t.q(jsonb_set(t.line(a, 2, 0, '["x"]'), '{payload,line}', '"2"')), 'avb:invalid_field');
  perform t.raises('part is bounded', t.q(t.line(a, 2, 10000, '["x"]')), 'avb:invalid_key');
  perform t.raises('source line takes no extra fields', t.q(jsonb_set(t.line(a, 2, 0, '["x"]'), '{payload,path}', '"/Users/a/p.pdf"')), 'avb:unknown_field');
  perform t.raises('skip days are dates', t.q(t.skip(a, 1, '["20 Oct"]')), 'avb:invalid_field');
  perform t.raises('skip needs a day', t.q(t.skip(a, 1, '[]')), 'avb:invalid_field');
  perform t.raises('skip key must match payload', t.q(jsonb_set(t.skip(a, 1, '["2026-10-20"]'), '{payload,index}', '2')), 'avb:invalid_key');

  -- Source content is the assignment's: it raises the revision and waits behind a deletion.
  v_rev := (t.head('assignment', a::text) ->> 'aggregate_rev')::bigint;
  perform t.one(t.line(a, 2, 0, '["new line"]'));
  perform t.login('admin1', 'aal2');
  perform t.eq('unseen source line blocks a stale delete', t.one(t.del_a(a, v_rev)) ->> 'conflict_kind', 'assignment_delete_stale');
  perform t.one(t.del_a(a, (t.head('assignment', a::text) ->> 'aggregate_rev')::bigint));
  perform t.login('op2');
  v_base := t.head('source_line', a || ':0:0') ->> 'head_version_id';
  perform t.eq('source edit after delete is kept', t.one(t.u('source_line', a || ':0:0', v_base,
    '{"line":0,"part":0,"cells":["14 Oct, Wed","corrected"],"continuesCell":false}')) ->> 'conflict_kind', 'parent_deleted');
  perform t.eq('new source line after delete is kept', t.one(t.line(a, 3, 0, '["late"]')) ->> 'conflict_kind', 'parent_deleted');
  perform t.eq('source line head untouched', t.head('source_line', a || ':0:0') #>> '{payload,cells,1}', 'us');
  perform t.super();
end $$;

-- ---------------------------------------------------------------- one op per actual target

do $$
declare a uuid := gen_random_uuid(); r1 uuid := gen_random_uuid(); r2 uuid := gen_random_uuid(); v_b text; c1 text; c2 text; m text; h text; v_b2 text;
begin
  perform t.login('op1');
  perform t.apply(jsonb_build_array(t.c_assign(a, t.meta('Once')), t.c_row(a, r1, t.row('a', 'base')), t.c_row(a, r2, t.row('b', 'base'))));
  v_b := t.head('session', r1::text) ->> 'head_version_id';
  perform t.one(t.u('session', r1::text, v_b, t.row('a', 'now')));
  c1 := t.one(t.u('session', r1::text, v_b, t.row('a', 'alt one'))) ->> 'conflict_id';
  c2 := t.one(t.u('session', r1::text, v_b, t.row('a', 'alt two'))) ->> 'conflict_id';
  h := t.head('session', r1::text) ->> 'head_version_id';
  m := t.head('assignment', a::text) ->> 'head_version_id';
  perform t.raises('resolve + update of the same target refused', format('select t.apply(%L::jsonb)',
    jsonb_build_array(t.resolve(c1, h, 'keep_current'), t.u('session', r1::text, h, t.row('a', 'x')))), 'avb:duplicate_target_in_batch');
  perform t.raises('two resolutions on one target refused', format('select t.apply(%L::jsonb)',
    jsonb_build_array(t.resolve(c1, h, 'keep_current'), t.resolve(c2, h, 'keep_current'))), 'avb:duplicate_target_in_batch');
  perform t.raises('metadata update + delete_assignment refused', format('select t.apply(%L::jsonb)',
    jsonb_build_array(t.u('assignment', a::text, m, t.meta('renamed')), t.del_a(a, 0))), 'avb:duplicate_target_in_batch');
  perform t.eq('refused batches changed nothing', (t.head('session', r1::text) ->> 'open_conflicts')::int, 2);
  v_b2 := t.head('session', r2::text) ->> 'head_version_id';
  perform t.eq('resolve + update of another target is fine', jsonb_array_length(t.apply(jsonb_build_array(
    t.resolve(c1, h, 'keep_current'), t.u('session', r2::text, v_b2, t.row('b', 'y')))) -> 'results'), 2);
  perform t.super();
end $$;

-- ---------------------------------------------------------------- report

select case when passed then 'PASS' else 'FAIL' end || '  ' || name ||
       case when passed then '' else '  -- ' || coalesce(detail, '') end
  from t.results order by id;
