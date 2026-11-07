#!/bin/bash
# Behavioural tests of the sync migration on a throwaway local PostgreSQL: Unix socket
# only, deleted on exit. Tests the database rules, not a real Neon project, its Data API or Better Auth.
#   tests/db/run.sh     (PG_BIN=/path/to/postgres/bin to pick the binaries)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
migration="${MIGRATION:-$here/../../db/migrations/20261107000000_av_backup_sync_v1.sql}"
PG_BIN="${PG_BIN:-$(pg_config --bindir 2>/dev/null || echo /opt/homebrew/Cellar/postgresql@16/16.14/bin)}"
dir="$(mktemp -d /private/tmp/avb-pg.XXXXXX 2>/dev/null || mktemp -d)"
trap '"$PG_BIN/pg_ctl" -D "$dir/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$dir"' EXIT

"$PG_BIN/initdb" -D "$dir/data" -U test_super -A trust -E UTF8 --locale=C >/dev/null
"$PG_BIN/pg_ctl" -D "$dir/data" -w -l "$dir/log" -o "-c listen_addresses='' -c unix_socket_directories='$dir' -c fsync=off" start >/dev/null
q() { "$PG_BIN/psql" -h "$dir" -v ON_ERROR_STOP=1 -X -q "$@"; }
"$PG_BIN/psql" -h "$dir" -U test_super -d postgres -X -q -c 'create database avb_test'
echo "PostgreSQL: $(q -U test_super -d avb_test -Atc 'show server_version') (socket only, disposable)"

q -U test_super -d avb_test -f "$here/shim.sql"
q -U neondb_owner -d avb_test -f "$migration"
q -U test_super -d avb_test -At -f "$here/behavior.sql" > "$dir/behavior.out" 2>&1 || { cat "$dir/behavior.out"; echo "behavior.sql aborted"; exit 1; }
# Two real connections racing each other, then real schedule content round-tripped (needs node).
"$here/concurrency.sh" "$PG_BIN" "$dir" > "$dir/concurrency.out" 2>&1 || { cat "$dir/concurrency.out"; echo "concurrency.sh aborted"; exit 1; }
node "$here/roundtrip.js" "$PG_BIN" "$dir" >> "$dir/concurrency.out" 2>&1 || { cat "$dir/concurrency.out"; echo "roundtrip.js aborted"; exit 1; }

cat "$dir/behavior.out" "$dir/concurrency.out"
total=$(cat "$dir/behavior.out" "$dir/concurrency.out" | grep -c '^\(PASS\|FAIL\)' || true)
fails=$(cat "$dir/behavior.out" "$dir/concurrency.out" | grep -c '^FAIL' || true)
echo "----"
echo "$((total - fails)) passed, $fails failed, $total total"
[ "$total" -gt 0 ] && [ "$fails" -eq 0 ]
