-- TEST ONLY, for a disposable database. A minimal stand-in for the parts of a Supabase
-- database the migration relies on, including its permissive defaults. It proves nothing
-- about a deployed Supabase, PostgREST or GoTrue. Never run this against a real server.
\set ON_ERROR_STOP on

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role postgres login nosuperuser createrole;

grant create on database avb_test to postgres;
grant create on schema public to postgres;

create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text unique);

-- As defined by Supabase Auth: identity comes from the verified JWT's claims.
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;

grant usage on schema auth to anon, authenticated, service_role, postgres;
grant select, references on auth.users to postgres;
grant execute on function auth.jwt(), auth.uid() to anon, authenticated, service_role, postgres;

-- Supabase's default exposure of new objects in public to all three API roles.
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
