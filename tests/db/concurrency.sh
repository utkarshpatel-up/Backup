#!/bin/bash
# Two real connections, one holding its transaction open while the other arrives.
# The order is forced with sleeps, then the end state is read back.
set -uo pipefail
PG_BIN="$1"; dir="$2"
q() { "$PG_BIN/psql" -h "$dir" -U test_super -d avb_test -X -q -At -v ON_ERROR_STOP=1 "$@"; }
check() { if [ "$2" = "$3" ]; then echo "PASS  concurrent: $1"; else echo "FAIL  concurrent: $1  -- got [$2] want [$3]"; fi; }
sql() { q -c "select set_config('client_min_messages','warning',false)" -c "$1" | tail -n 1; }
uuid() { q -c 'select gen_random_uuid()'; }

# As $1 with aal $2, inside a transaction held for $3 seconds, run $4.
hold() { q <<SQL
begin;
select t.login('$1', '$2') \g /dev/null
select $4 \g /dev/null
select pg_sleep($3) \g /dev/null
commit;
SQL
}
as() { q -c "select t.login('$1', '$2')" -c "select $3" | tail -n 1; }

A=$(uuid); R1=$(uuid); R2=$(uuid)
as op1 aal1 "t.apply(jsonb_build_array(t.c_assign('$A', t.meta('Conc')), t.c_row('$A', '$R1', t.row('a', 'base')), t.c_row('$A', '$R2', t.row('b', 'base'))))" >/dev/null
head_of() { as op1 aal1 "t.head('$1', '$2') ->> '$3'"; }
BASE=$(head_of session "$R1" head_version_id)

# 1. Same base, same row, different values, overlapping transactions.
hold op1 aal1 1.5 "t.one(t.u('session', '$R1', '$BASE', t.row('a', 'first')))" & p=$!
sleep 0.5
S=$(as op2 aal1 "t.one(t.u('session', '$R1', '$BASE', t.row('a', 'second'))) ->> 'conflict_kind'")
wait $p
check "second writer waits, then conflicts instead of overwriting" "$S" "stale_edit"
check "first value stays head" "$(as op1 aal1 "t.head('session', '$R1') #>> '{payload,topic}'")" "first"
check "second value is in an open conflict" "$(as op1 aal1 "t.open_conflicts('$A') #>> '{0,incoming,payload,topic}'")" "second"

# 2. One mutation id sent twice at once (a retry racing its original).
MID=$(uuid); R3=$(uuid)
OPS="jsonb_build_array(t.c_row('$A', '$R3', t.row('c', 'once')))"
hold op1 aal1 1.5 "t.apply($OPS, '$MID')" & p=$!
sleep 0.5
S=$(as op1 aal1 "t.apply($OPS, '$MID') #>> '{results,0,status}'")
wait $p
check "retry racing its original gets the stored result" "$S" "applied"
check "and only one version exists" "$(as op1 aal1 "jsonb_array_length(public.avb_target_history(jsonb_build_object('protocol_version', 1, 'type', 'session', 'key', '$R3')) -> 'items')")" "1"

# 3. A new row commits while an admin's delete, based on the old revision, is waiting.
REV=$(head_of assignment "$A" aggregate_rev); R4=$(uuid)
hold op2 aal1 1.5 "t.one(t.c_row('$A', '$R4', t.row('d', 'new row')))" & p=$!
sleep 0.5
S=$(as admin1 aal2 "t.one(t.del_a('$A', $REV)) ->> 'conflict_kind'")
wait $p
check "delete losing the race to a new row conflicts" "$S" "assignment_delete_stale"
check "assignment is still alive" "$(head_of assignment "$A" deleted)" "false"
check "new row is visible" "$(head_of session "$R4" deleted)" "false"

# 4. The delete wins; a stale edit and a new row arrive while it is still open.
CID=$(as admin1 aal2 "t.open_conflicts('$A') -> -1 ->> 'conflict_id'")
HEAD=$(head_of assignment "$A" head_version_id)
as admin1 aal2 "t.one(t.resolve('$CID', '$HEAD', 'keep_current'))" >/dev/null
REV=$(head_of assignment "$A" aggregate_rev); R5=$(uuid); BASE2=$(head_of session "$R2" head_version_id)
hold admin1 aal2 1.5 "t.one(t.del_a('$A', $REV))" & p=$!
sleep 0.5
as op2 aal1 "t.one(t.c_row('$A', '$R5', t.row('e', 'row racing delete')))" >/dev/null & sp1=$!
wait $p $sp1
check "assignment deleted after its race" "$(head_of assignment "$A" deleted)" "true"
S2=$(as op1 aal1 "t.one(t.u('session', '$R2', '$BASE2', t.row('b', 'edit after delete'))) ->> 'conflict_kind'")
check "edit behind a delete is kept as a conflict" "$S2" "parent_deleted"
check "row racing the delete is not lost" "$(as op1 aal1 "(select count(*)::int from jsonb_array_elements(t.open_conflicts('$A')) e where e #>> '{incoming,payload,topic}' in ('row racing delete', 'edit after delete'))")" "2"

# 5. A writer stuck behind a long hold fails cleanly and can retry.
A2=$(uuid); MID2=$(uuid); R6=$(uuid)
hold op1 aal1 6 "t.one(t.c_assign('$A2', t.meta('Hold')))" & p=$!
sleep 0.5
OUT=$(q -c "select t.login('op2', 'aal1')" -c "select t.apply(jsonb_build_array(t.c_assign('$R6', t.meta('Timed'))), '$MID2')" 2>&1)
wait $p
case "$OUT" in *"lock timeout"*) check "lock wait over 5s fails cleanly" "yes" "yes";; *) check "lock wait over 5s fails cleanly" "$OUT" "lock timeout";; esac
check "timed-out batch left nothing" "$(as op2 aal1 "coalesce(t.head('assignment', '$R6')::text, 'none')")" "none"
check "same id retries fine" "$(as op2 aal1 "t.apply(jsonb_build_array(t.c_assign('$R6', t.meta('Timed'))), '$MID2') #>> '{results,0,status}'")" "applied"
