-- TEST ONLY, for a disposable database. A minimal stand-in for the parts of a Neon
-- database the migration relies on: the Data API roles, pg_session_jwt's auth.*
-- functions, Better Auth's neon_auth."user" table and the optional default grants. It
-- proves nothing about a real Neon project, its Data API or Managed Better Auth. Never run
-- this against a real database.
\set ON_ERROR_STOP on

-- The Data API connects as authenticator and SET ROLEs to the JWT's role claim.
create role authenticator login noinherit;
create role authenticated nologin;
create role anonymous nologin;
grant authenticated, anonymous to authenticator;
create role neondb_owner login nosuperuser createrole;

grant create on database avb_test to neondb_owner;
grant create on schema public to neondb_owner;

-- Better Auth's own table (only the columns the migration reads).
create schema neon_auth;
create table neon_auth."user" (id text primary key default gen_random_uuid()::text, email text unique not null,
  "emailVerified" boolean not null default false, "createdAt" timestamptz not null default now());
grant usage on schema neon_auth to neondb_owner;
grant select on neon_auth."user" to neondb_owner;

-- pg_session_jwt. On Neon the claims come from the verified JWT (JWK mode); here they
-- come from the request.jwt.claims setting, which is its documented fallback mode.
create schema auth;
create function auth.session() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.jwt() returns jsonb language sql stable as $$ select auth.session() $$;
create function auth.user_id() returns text language sql stable as $$ select auth.session() ->> 'sub' $$;
grant usage on schema auth to anonymous, authenticated, neondb_owner;
grant execute on function auth.session(), auth.jwt(), auth.user_id() to anonymous, authenticated, neondb_owner;

-- Neon's optional "Grant public schema access", which hands new public tables to authenticated.
grant usage on schema public to authenticated;
alter default privileges for role neondb_owner in schema public grant select, update, insert, delete on tables to authenticated;
