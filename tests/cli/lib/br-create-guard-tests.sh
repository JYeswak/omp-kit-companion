# shellcheck shell=sh
# 14. duplicate candidates require an explicit disposition before create
export AM_FAKE_MODE=clear
: > "$TMP/argv"
br create --help > "$TMP/out" 2>&1
got_rc=$?
if [ "$got_rc" = "0" ] && grep -Fq "Usage: br create" "$TMP/out" && [ ! -s "$TMP/argv" ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL create-help-passthrough: rc=%s out<<<%s>>>\n' "$got_rc" "$(cat "$TMP/out")"
fi
cat > "$BR_CREATE_FIXTURE" <<'EOF'
{"issues":[
  {"id":"ompkit-fp72.25","title":"Release train never publishes: candidate dispatched by the train does not fire the train's publish job","status":"open","priority":2,"created_at":"2026-10-16T10:00:00Z","created_by":"Other"},
  {"id":"ompkit-dj7d","title":"RELTRAIN2: candidate-completion never triggers the train publish job, so green candidates never publish","status":"open","priority":2,"created_at":"2026-10-16T10:01:00Z","created_by":"Other"}
],"total":2,"offset":0,"has_more":false}
EOF
: > "$TMP/argv"
br_create_valid --title "RELTRAIN2: candidate-completion never triggers the train publish job so green candidates never publish" > "$TMP/out" 2>&1
got_rc=$?
if [ "$got_rc" = "4" ] && [ ! -s "$TMP/argv" ] \
	&& grep -Fq "ompkit-fp72.25" "$TMP/out" && grep -Fq -- "--not-duplicate" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL duplicate-refused: rc=%s argv<<<%s>>> out<<<%s>>>\n' "$got_rc" "$(cat "$TMP/argv")" "$(cat "$TMP/out")"
fi
: > "$TMP/argv"
br_create_valid --title "RELTRAIN2: candidate-completion never triggers the train publish job so green candidates never publish" --not-duplicate ompkit-dj7d > "$TMP/out" 2>&1
got_rc=$?
if [ "$got_rc" = "0" ] && [ "$(sed -n '1p' "$TMP/argv")" = "create" ] \
	&& ! grep -Fq -- "--not-duplicate" "$TMP/argv"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL duplicate-confirmed: rc=%s argv<<<%s>>> out<<<%s>>>\n' "$got_rc" "$(cat "$TMP/argv")" "$(cat "$TMP/out")"
fi
: > "$TMP/argv"
br create --title "RELTRAIN2: candidate-completion never triggers the train publish job so green candidates never publish" \
	--comment-target ompkit-fp72.25 --description "Follow-up evidence" > "$TMP/out" 2>&1
got_rc=$?
if [ "$got_rc" = "0" ] && [ "$(sed -n '1p' "$TMP/argv")" = "comments" ] \
	&& grep -Fq "ompkit-fp72.25" "$TMP/argv" && ! grep -Fq "create" "$TMP/argv"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL duplicate-comment-target: rc=%s argv<<<%s>>> out<<<%s>>>\n' "$got_rc" "$(cat "$TMP/argv")" "$(cat "$TMP/out")"
fi

printf '## Bulk import fixture\n' > "$TMP/bulk.md"
: > "$TMP/argv"
br create --file "$TMP/bulk.md" > "$TMP/out" 2>&1
got_rc=$?
if [ "$got_rc" = "4" ] && [ ! -s "$TMP/argv" ] && grep -Fq "bulk" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL bulk-create-refused: rc=%s argv<<<%s>>> out<<<%s>>>\n' "$got_rc" "$(cat "$TMP/argv")" "$(cat "$TMP/out")"
fi

# 15. P0 admission respects cap, allows under-cap creates, and records displacement both ways
python3 - "$BR_CREATE_FIXTURE" <<'PY'
import json, sys
json.dump({"issues":[{"id":"old-p0","title":"Existing P0 item","status":"open","priority":0,
                      "created_at":"2026-10-16T10:00:00Z","created_by":"Other"}],
           "total":1,"offset":0,"has_more":False}, open(sys.argv[1], "w"))
PY
: > "$TMP/argv"
: > "$BR_CREATE_LOG"
br_create_valid --title "Urgent new work" --priority P0 > "$TMP/out" 2>&1
got_rc=$?
if [ "$got_rc" = "4" ] && [ ! -s "$TMP/argv" ] && grep -Fq "P0 cap" "$TMP/out"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL p0-cap-refused: rc=%s argv<<<%s>>> out<<<%s>>>\n' "$got_rc" "$(cat "$TMP/argv")" "$(cat "$TMP/out")"
fi
printf '{"sessions":[{"repo":"%s","coordinatorSession":"fixture-director","coordinatorPane":"%%57","p0Cap":2}]}\n' "$REPO_ROOT" > "$OMP_KIT_FLEET_WATCH_CONFIG"
: > "$TMP/argv"
: > "$BR_CREATE_LOG"
br_create_valid --title "Under cap" --priority 0 > "$TMP/out" 2>&1
got_rc=$?
if [ "$got_rc" = "0" ] && [ "$(sed -n '1p' "$TMP/argv")" = "create" ] \
	&& ! grep -Fq "update" "$BR_CREATE_LOG" && ! grep -Fq "comments" "$BR_CREATE_LOG"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL p0-under-cap: rc=%s argv<<<%s>>> log<<<%s>>>\n' "$got_rc" "$(cat "$TMP/argv")" "$(cat "$BR_CREATE_LOG")"
fi
printf '{"sessions":[{"repo":"%s","coordinatorSession":"fixture-director","coordinatorPane":"%%57","p0Cap":1}]}\n' "$REPO_ROOT" > "$OMP_KIT_FLEET_WATCH_CONFIG"
: > "$TMP/argv"
: > "$BR_CREATE_LOG"
br_create_valid --title "Urgent replacement" --priority P0 --displaces old-p0 > "$TMP/out" 2>&1
got_rc=$?
if [ "$got_rc" = "0" ] && grep -Fq '<update><old-p0><--priority><1>' "$BR_CREATE_LOG" \
	&& grep -Fq '<create>' "$BR_CREATE_LOG" && grep -Fq '<comments><add>' "$BR_CREATE_LOG" \
	&& grep -Fq 'Displaced by new-p0' "$BR_CREATE_LOG" && grep -Fq 'Displaces old-p0' "$BR_CREATE_LOG"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL p0-displacement-recorded: rc=%s out<<<%s>>> log<<<%s>>>\n' "$got_rc" "$(cat "$TMP/out")" "$(cat "$BR_CREATE_LOG")"
fi

# 16. the twenty-first same-agent creation pages the configured project director with the sweep
python3 - "$BR_CREATE_FIXTURE" <<'PY'
import datetime, json, sys
stamp = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
rows = [{"id":f"sweep-{i:02}","title":f"Work item {i}","status":"open","priority":2,
         "created_at":stamp,"created_by":"TestShim"} for i in range(20)]
json.dump({"issues":rows,"total":len(rows),"offset":0,"has_more":False}, open(sys.argv[1], "w"))
PY
printf '{"sessions":[{"repo":"%s","coordinatorSession":"fixture-director","coordinatorPane":"%%57","p0Cap":1}]}\n' "$REPO_ROOT" > "$OMP_KIT_FLEET_WATCH_CONFIG"
: > "$TMP/argv"
: > "$OMP_KIT_SEND_LOG"
BR_CREATE_MUTATE_FIXTURE=1 BR_CREATE_ID=sweep-20 BR_CREATE_TITLE="planned sweep item" \
	BR_CREATE_PRIORITY=2 BR_CREATE_CREATED="$TMP/sweep-created" br_create_valid --title "planned sweep item" > "$TMP/out" 2>&1
got_rc=$?
if [ "$got_rc" = "0" ] && grep -Fq "fixture-director" "$OMP_KIT_SEND_LOG" \
	&& grep -Fq "sweep-19" "$OMP_KIT_SEND_LOG" && grep -Fq "planned sweep item" "$OMP_KIT_SEND_LOG"; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL creation-sweep-page: rc=%s send<<<%s>>> out<<<%s>>>\n' "$got_rc" "$(cat "$OMP_KIT_SEND_LOG")" "$(cat "$TMP/out")"
fi

# 17. controlled P0 race: the vulnerable fixture admits two writes, the shim serializes them
python3 - "$BR_CREATE_FIXTURE" <<'PY'
import json, sys
json.dump({"issues":[],"total":0,"offset":0,"has_more":False}, open(sys.argv[1], "w"))
PY
mkdir -p "$TMP/positive-gate"
: > "$TMP/positive-p0"
: > "$TMP/positive-created"
(
	count=$(python3 - "$BR_CREATE_FIXTURE" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))["issues"]
print(sum(row["status"] == "open" and row["priority"] == 0 for row in rows))
PY
	)
	printf '%s\n' "$count" > "$TMP/positive-checked-a"
	BR_CREATE_ID=control-a BR_CREATE_TITLE="Control P0 A" BR_CREATE_PRIORITY=0 \
		BR_CREATE_GATE_DIR="$TMP/positive-gate" BR_CREATE_CREATED="$TMP/positive-created" \
		BR_CREATE_P0_STATE="$TMP/positive-p0" "$TMP/realbin/br" create --priority P0
) > "$TMP/positive-a.out" 2>&1 & positive_a=$!
(
	count=$(python3 - "$BR_CREATE_FIXTURE" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))["issues"]
print(sum(row["status"] == "open" and row["priority"] == 0 for row in rows))
PY
	)
	printf '%s\n' "$count" > "$TMP/positive-checked-b"
	BR_CREATE_ID=control-b BR_CREATE_TITLE="Control P0 B" BR_CREATE_PRIORITY=0 \
		BR_CREATE_GATE_DIR="$TMP/positive-gate" BR_CREATE_CREATED="$TMP/positive-created" \
		BR_CREATE_P0_STATE="$TMP/positive-p0" "$TMP/realbin/br" create --priority P0
) > "$TMP/positive-b.out" 2>&1 & positive_b=$!
wait_count=0
while [ ! -f "$TMP/positive-checked-a" ] || [ ! -f "$TMP/positive-checked-b" ]; do
	sleep 0.01
	wait_count=$((wait_count + 1))
	if [ "$wait_count" -ge 500 ]; then break; fi
done
positive_seen_a=$(cat "$TMP/positive-checked-a" 2>/dev/null || printf missing)
positive_seen_b=$(cat "$TMP/positive-checked-b" 2>/dev/null || printf missing)
: > "$TMP/positive-gate/release"
wait "$positive_a"; positive_rc_a=$?
wait "$positive_b"; positive_rc_b=$?
positive_p0_count=$(wc -l < "$TMP/positive-p0")
if [ "$positive_seen_a" = "0" ] && [ "$positive_seen_b" = "0" ] \
	&& [ "$positive_rc_a" = "0" ] && [ "$positive_rc_b" = "0" ] && [ "$positive_p0_count" -eq 2 ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL p0-race-positive-control: seen=%s,%s rc=%s,%s committed=%s\n' \
		"$positive_seen_a" "$positive_seen_b" "$positive_rc_a" "$positive_rc_b" "$positive_p0_count"
fi

python3 - "$BR_CREATE_FIXTURE" <<'PY'
import json, sys
json.dump({"issues":[],"total":0,"offset":0,"has_more":False}, open(sys.argv[1], "w"))
PY
mkdir -p "$TMP/atomic-gate" "$TMP/racebin"
: > "$TMP/atomic-p0"
: > "$TMP/atomic-created"
: > "$TMP/atomic-starts"
cat > "$TMP/racebin/br" <<'EOF'
#!/bin/sh
printf 'started\n' >> "$BR_CREATE_START_LOG"
exec "$BR_SHIM_PATH" "$@"
EOF
chmod +x "$TMP/racebin/br"
export BR_SHIM_PATH="$SHIM"
export BR_CREATE_START_LOG="$TMP/atomic-starts"
export PATH="$TMP/racebin:$TMP/sendbin:$TMP/realbin:$PATH"
BR_REAL="$TMP/realbin/br" BR_CREATE_ID=atomic-a BR_CREATE_TITLE="Atomic P0 A" \
	BR_CREATE_PRIORITY=0 BR_CREATE_MUTATE_FIXTURE=1 BR_CREATE_GATE_DIR="$TMP/atomic-gate" \
	BR_CREATE_CREATED="$TMP/atomic-created" BR_CREATE_P0_STATE="$TMP/atomic-p0" \
	br_create_valid --title "Atomic P0 A" --priority P0 > "$TMP/atomic-a.out" 2>&1 & atomic_a=$!
BR_REAL="$TMP/realbin/br" BR_CREATE_ID=atomic-b BR_CREATE_TITLE="Atomic P0 B" \
	BR_CREATE_PRIORITY=0 BR_CREATE_MUTATE_FIXTURE=1 BR_CREATE_GATE_DIR="$TMP/atomic-gate" \
	BR_CREATE_CREATED="$TMP/atomic-created" BR_CREATE_P0_STATE="$TMP/atomic-p0" \
	br_create_valid --title "Atomic P0 B" --priority P0 > "$TMP/atomic-b.out" 2>&1 & atomic_b=$!
wait_count=0
while [ "$(wc -l < "$TMP/atomic-starts")" -lt 2 ] \
	|| { [ ! -f "$TMP/atomic-gate/entered-atomic-a" ] && [ ! -f "$TMP/atomic-gate/entered-atomic-b" ]; }; do
	sleep 0.01
	wait_count=$((wait_count + 1))
	if [ "$wait_count" -ge 500 ]; then break; fi
done
: > "$TMP/atomic-gate/release"
wait "$atomic_a"; atomic_rc_a=$?
wait "$atomic_b"; atomic_rc_b=$?
atomic_p0_count=$(wc -l < "$TMP/atomic-p0")
atomic_create_count=$(wc -l < "$TMP/atomic-created")
atomic_race_pass=0
if [ "$atomic_rc_a" = "0" ] && [ "$atomic_rc_b" = "4" ] && grep -Fq "P0 cap=1" "$TMP/atomic-b.out"; then
	atomic_race_pass=1
elif [ "$atomic_rc_b" = "0" ] && [ "$atomic_rc_a" = "4" ] && grep -Fq "P0 cap=1" "$TMP/atomic-a.out"; then
	atomic_race_pass=1
fi
if [ "$atomic_race_pass" = "1" ] && [ "$atomic_p0_count" -eq 1 ] && [ "$atomic_create_count" -eq 1 ]; then
	pass=$((pass + 1))
else
	fail=$((fail + 1))
	printf 'FAIL p0-race-serialized: rc=%s,%s creates=%s P0=%s outA<<<%s>>> outB<<<%s>>>\n' \
		"$atomic_rc_a" "$atomic_rc_b" "$atomic_create_count" "$atomic_p0_count" \
		"$(cat "$TMP/atomic-a.out")" "$(cat "$TMP/atomic-b.out")"
fi
