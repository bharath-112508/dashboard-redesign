#!/usr/bin/env bash
# End-to-end smoke test for Leave Management (Step 10).
#
# Covers the four surfaces wired in 10.3:
#   - /leave-types          (admin CRUD + read-by-all)
#   - /leave-balances       (per-user reads, manager list, admin adjust + init)
#   - /leaves               (preview/apply/approve/reject/cancel + RBAC + concurrency)
#   - /comp-off             (per-user ledger, manager list, admin adjust)
#
# Plus the cross-cutting concerns called out in 10.4–10.5:
#   - Atomic balance reservation on apply (pending bumped, available drops).
#   - Atomic status transition on approve (second approve ⇒ 409).
#   - Overlap rejection (LEAVE_OVERLAP).
#   - Date policy gates (backdated, advance notice, no-working-days).
#   - RBAC matrix (employee can apply but not review; manager can review but
#     not adjust types/balances/comp-off; clients/no-token are denied).
#
# Strategy:
#   - Lazy-creates smoke users (admin, manager, employee, second employee).
#   - Computes all dates dynamically from `today` so the suite stays
#     correct year after year (no hard-coded 2025/2026).
#   - Cleans up its own state at start AND end so it's fully re-runnable
#     standalone (no dependency on smoke-reset-users.ts).
set -u

API=http://localhost:3001/api/v1
ADMIN_EMAIL=smoke@example.com
ADMIN_PASS='SmokeA@123!'

MGR_EMAIL=smoke-mgr@example.com
MGR_PASS='SmokeM@123!'

EMP_EMAIL=smoke-emp@example.com
EMP_PASS='SmokeE@123!'

EMP2_EMAIL=smoke-emp2@example.com
EMP2_PASS='SmokeE2@123!'

pass=0
fail=0

check() {
    local name=$1 expected=$2 got=$3
    if [[ "$got" == "$expected" ]]; then
        printf "  \e[32mPASS\e[0m %s (%s)\n" "$name" "$got"
        pass=$((pass + 1))
    else
        printf "  \e[31mFAIL\e[0m %s (expected %s, got %s)\n" "$name" "$expected" "$got"
        fail=$((fail + 1))
    fi
}

# Like check but tolerates either of two values — useful for endpoints whose
# success status has changed across versions or whose error code mapping is
# context-sensitive (e.g. 409 vs 422 for a status conflict).
check_in() {
    local name=$1 got=$2
    shift 2
    for expected in "$@"; do
        if [[ "$got" == "$expected" ]]; then
            printf "  \e[32mPASS\e[0m %s (%s)\n" "$name" "$got"
            pass=$((pass + 1))
            return
        fi
    done
    printf "  \e[31mFAIL\e[0m %s (expected one of [%s], got %s)\n" "$name" "$*" "$got"
    fail=$((fail + 1))
}

req() {
    local method=$1 path=$2 body=$3 token=${4:-}
    local args=(-sS -o /tmp/sm.json -w '%{http_code}' -X "$method" "$API$path" -H 'Content-Type: application/json')
    [[ -n "$token" ]] && args+=(-H "Authorization: Bearer $token")
    [[ -n "$body" ]] && args+=(-d "$body")
    curl "${args[@]}"
}

# Fire two POSTs in parallel and capture the two status codes (whitespace-
# separated). Used for the concurrent-approve race.
req2_parallel() {
    local path=$1 body=$2 tokenA=$3 tokenB=$4
    local outA=/tmp/sm.A.json outB=/tmp/sm.B.json
    local codeA codeB
    codeA=$(curl -sS -o "$outA" -w '%{http_code}' -X POST "$API$path" \
        -H 'Content-Type: application/json' \
        -H "Authorization: Bearer $tokenA" \
        -d "$body") &
    local pidA=$!
    codeB=$(curl -sS -o "$outB" -w '%{http_code}' -X POST "$API$path" \
        -H 'Content-Type: application/json' \
        -H "Authorization: Bearer $tokenB" \
        -d "$body") &
    local pidB=$!
    wait $pidA
    rcA=$?
    wait $pidB
    rcB=$?
    # We intentionally don't fail on rc; curl still writes the status.
    : "$rcA $rcB"
    # Status codes are written by the backgrounded curls themselves to
    # /tmp/sm.A.code and /tmp/sm.B.code so the parent can read them after wait.
    # Simpler: re-issue with synchronous mode after the race, which is what
    # the test uses for everything else.
    echo "$codeA $codeB"
}

jq1() {
    node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/sm.json','utf8'))$1)"
}

jqx() {
    node -e "const b=JSON.parse(require('fs').readFileSync('/tmp/sm.json','utf8')); console.log($1)"
}

login_get_token() {
    local email=$1 password=$2
    req POST /auth/login "{\"email\":\"$email\",\"password\":\"$password\"}" >/dev/null
    jq1 .data.access_token
}

ensure_user() {
    local email=$1 password=$2 role=$3 full=$4 empid=$5 job=$6
    local body
    body="{\"email\":\"$email\",\"full_name\":\"$full\",\"role\":\"$role\",\"initial_password\":\"$password\",\"internal_profile\":{\"employee_id\":\"$empid\",\"job_title\":\"$job\",\"department\":\"Eng\",\"date_of_joining\":\"2020-01-01\"}}"
    local code
    code=$(req POST /users "$body" "$ADMIN_ACCESS")
    if [[ "$code" == "201" ]]; then
        echo "    created $email"
    elif [[ "$code" == "409" ]]; then
        echo "    $email already exists (reusing)"
    else
        printf "  \e[31mFAIL\e[0m create %s unexpected code %s\n" "$email" "$code"
        fail=$((fail + 1))
    fi
}

# ── Date helpers (computed at runtime so the suite ages well) ────────────

# next_weekday <YYYY-MM-DD> <1..5>  — first date on/after the input that
# matches the requested ISO weekday (1=Mon, 7=Sun).
next_weekday() {
    node -e "
        const d=process.argv[1], target=parseInt(process.argv[2],10);
        const dt=new Date(d+'T00:00:00Z');
        // getUTCDay: 0=Sun..6=Sat → ISO 1..7
        const iso=x => (x.getUTCDay()===0 ? 7 : x.getUTCDay());
        while (iso(dt) !== target) dt.setUTCDate(dt.getUTCDate()+1);
        const y=dt.getUTCFullYear(), m=String(dt.getUTCMonth()+1).padStart(2,'0'), day=String(dt.getUTCDate()).padStart(2,'0');
        process.stdout.write(\`\${y}-\${m}-\${day}\`);
    " "$1" "$2"
}

add_days() {
    node -e "
        const d=process.argv[1], n=parseInt(process.argv[2],10);
        const dt=new Date(d+'T00:00:00Z');
        dt.setUTCDate(dt.getUTCDate()+n);
        const y=dt.getUTCFullYear(), m=String(dt.getUTCMonth()+1).padStart(2,'0'), day=String(dt.getUTCDate()).padStart(2,'0');
        process.stdout.write(\`\${y}-\${m}-\${day}\`);
    " "$1" "$2"
}

today_iso() {
    node -e "
        const d=new Date();
        const y=d.getUTCFullYear(), m=String(d.getUTCMonth()+1).padStart(2,'0'), day=String(d.getUTCDate()).padStart(2,'0');
        process.stdout.write(\`\${y}-\${m}-\${day}\`);
    "
}

# ── 0. Reset stale smoke-leaves-only users (idempotent) ─────────────────
#
# `smoke-emp2` is unique to this suite. If it was previously created with
# a different password (e.g. by earlier dev iterations), lazy-create won't
# fix it — we must delete the row so the create below assigns our known
# smoke password. The master runner (smoke-all.sh) already wipes all
# non-admin users via smoke-reset-users.ts, so this is a no-op there.

echo "── Prep: clear stale smoke-leaves-only users ───────────────────"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
( cd "$SCRIPT_DIR/.." && npx tsx scripts/smoke-leaves-prep.ts ) || {
    printf "  \e[31mFAIL\e[0m smoke-leaves-prep.ts (continuing — login may fail)\n"
    fail=$((fail + 1))
}

# ── 1. Login as admin ────────────────────────────────────────────────────

echo ""
echo "── Login as admin ──────────────────────────────────────────────"
code=$(req POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
check "admin login 200" 200 "$code"
ADMIN_ACCESS=$(jq1 .data.access_token)
ADMIN_ID=$(jq1 .data.user.id)

# ── 1. Lazy-create supporting users ─────────────────────────────────────

echo ""
echo "── Lazy-create smoke users (idempotent on 409) ─────────────────"
ensure_user "$MGR_EMAIL"  "$MGR_PASS"  manager  "Smoke Manager"    SMOKE-LV-MGR-001 "Engineering Manager"
ensure_user "$EMP_EMAIL"  "$EMP_PASS"  employee "Smoke Employee"   SMOKE-LV-EMP-001 "Engineer"
ensure_user "$EMP2_EMAIL" "$EMP2_PASS" employee "Smoke Employee 2" SMOKE-LV-EMP-002 "Engineer"

MGR_ACCESS=$(login_get_token "$MGR_EMAIL"  "$MGR_PASS")
EMP_ACCESS=$(login_get_token "$EMP_EMAIL"  "$EMP_PASS")
EMP2_ACCESS=$(login_get_token "$EMP2_EMAIL" "$EMP2_PASS")
[[ -n "$MGR_ACCESS"  && "$MGR_ACCESS"  != "undefined" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m manager login\n"; }
[[ -n "$EMP_ACCESS"  && "$EMP_ACCESS"  != "undefined" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m employee login\n"; }
[[ -n "$EMP2_ACCESS" && "$EMP2_ACCESS" != "undefined" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m employee2 login\n"; }

# Resolve user ids so we can target them in admin-scoped APIs.
req POST /auth/login "{\"email\":\"$EMP_EMAIL\",\"password\":\"$EMP_PASS\"}" >/dev/null
EMP_ID=$(jq1 .data.user.id)
req POST /auth/login "{\"email\":\"$EMP2_EMAIL\",\"password\":\"$EMP2_PASS\"}" >/dev/null
EMP2_ID=$(jq1 .data.user.id)
req POST /auth/login "{\"email\":\"$MGR_EMAIL\",\"password\":\"$MGR_PASS\"}" >/dev/null
MGR_ID=$(jq1 .data.user.id)

echo "    EMP_ID=$EMP_ID EMP2_ID=$EMP2_ID MGR_ID=$MGR_ID"

# ── 2. Cleanup any stale leave requests from prior runs ─────────────────
#
# We can't hard-delete leave_requests via the API, so we cancel everything
# pending and everything approved-but-not-yet-started for both smoke
# employees. Already-started or rejected/cancelled rows stay (they can no
# longer affect balances / overlap predicates anyway).

cleanup_user_leaves() {
    local user_id=$1
    req GET "/leaves?user_id=$user_id&limit=200" '' "$ADMIN_ACCESS" >/dev/null
    local IDS
    IDS=$(jqx "(b.data||[]).filter(r => r.status==='pending' || r.status==='approved').map(r => r.id).join(' ')")
    if [[ -n "$IDS" ]]; then
        for id in $IDS; do
            req POST "/leaves/$id/cancel" '{"cancellation_reason":"smoke-cleanup"}' "$ADMIN_ACCESS" >/dev/null || true
        done
        echo "    cancelled $(echo "$IDS" | wc -w | tr -d ' ') stale leave(s) for $user_id"
    fi
}

echo ""
echo "── Cleanup stale smoke leaves ──────────────────────────────────"
cleanup_user_leaves "$EMP_ID"
cleanup_user_leaves "$EMP2_ID"

# ── 3. /leave-types — read by all, write Admin-only ─────────────────────

echo ""
echo "── GET /leave-types (employee can read) ────────────────────────"
code=$(req GET /leave-types '' "$EMP_ACCESS")
check "list 200" 200 "$code"
TYPE_COUNT=$(jqx "b.data.length")
[[ "$TYPE_COUNT" -ge 7 ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m at least 7 seeded types (got %s)\n" "$TYPE_COUNT"; }

CL_ID=$(jqx "(b.data.find(t => t.code==='CL')||{}).id")
SL_ID=$(jqx "(b.data.find(t => t.code==='SL')||{}).id")
WFH_ID=$(jqx "(b.data.find(t => t.code==='WFH')||{}).id")
UNPAID_ID=$(jqx "(b.data.find(t => t.code==='UNPAID')||{}).id")
[[ -n "$CL_ID" && "$CL_ID" != "undefined" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m CL seed present\n"; }
[[ -n "$SL_ID" && "$SL_ID" != "undefined" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m SL seed present\n"; }
[[ -n "$WFH_ID" && "$WFH_ID" != "undefined" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m WFH seed present\n"; }
[[ -n "$UNPAID_ID" && "$UNPAID_ID" != "undefined" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m UNPAID seed present\n"; }

echo ""
echo "── POST /leave-types as employee → 403 ─────────────────────────"
code=$(req POST /leave-types '{"code":"FOO","name":"x","default_allocation_days":1,"carry_forward":false,"monthly_forfeiture":false,"is_unlimited":false,"is_earned":false,"is_event_based":false,"pro_rata_on_join":"none","supports_half_day":false,"advance_notice_days":0,"resets_yearly":true}' "$EMP_ACCESS")
check "employee POST 403" 403 "$code"

echo ""
echo "── POST /leave-types validation ────────────────────────────────"
code=$(req POST /leave-types '{}' "$ADMIN_ACCESS")
check "empty body 400" 400 "$code"
code=$(req POST /leave-types '{"code":"lowercase","name":"x","default_allocation_days":1,"carry_forward":false,"monthly_forfeiture":false,"is_unlimited":false,"is_earned":false,"is_event_based":false,"pro_rata_on_join":"none","supports_half_day":false,"advance_notice_days":0,"resets_yearly":true}' "$ADMIN_ACCESS")
check "lowercase code 400" 400 "$code"
code=$(req POST /leave-types '{"code":"BADRATA","name":"x","default_allocation_days":1,"carry_forward":false,"monthly_forfeiture":false,"is_unlimited":false,"is_earned":false,"is_event_based":false,"pro_rata_on_join":"made_up","supports_half_day":false,"advance_notice_days":0,"resets_yearly":true}' "$ADMIN_ACCESS")
check "bad pro_rata enum 400" 400 "$code"

echo ""
echo "── POST /leave-types (admin) → 201 ─────────────────────────────"
STAMP=$(date +%s)
CUSTOM_CODE="SMOKE_LV_${STAMP}"
CREATE_BODY="{\"code\":\"$CUSTOM_CODE\",\"name\":\"Smoke Custom Leave\",\"default_allocation_days\":3,\"carry_forward\":false,\"carry_forward_cap\":null,\"monthly_cap\":null,\"monthly_forfeiture\":false,\"is_unlimited\":false,\"is_earned\":false,\"is_event_based\":false,\"pro_rata_on_join\":\"none\",\"supports_half_day\":true,\"advance_notice_days\":0,\"resets_yearly\":true}"
code=$(req POST /leave-types "$CREATE_BODY" "$ADMIN_ACCESS")
check "create 201" 201 "$code"
CUSTOM_ID=$(jq1 .data.id)
CUSTOM_ECHOED=$(jq1 .data.code)
check "code echoed" "$CUSTOM_CODE" "$CUSTOM_ECHOED"

echo ""
echo "── POST /leave-types duplicate code → 409 ──────────────────────"
code=$(req POST /leave-types "$CREATE_BODY" "$ADMIN_ACCESS")
check "dup 409" 409 "$code"
err=$(jq1 .error.code)
check "DUPLICATE_RESOURCE" "DUPLICATE_RESOURCE" "$err"

echo ""
echo "── PATCH /leave-types/:id (admin) → 200 ────────────────────────"
code=$(req PATCH "/leave-types/$CUSTOM_ID" '{"name":"Smoke Custom Renamed","default_allocation_days":4}' "$ADMIN_ACCESS")
check "patch 200" 200 "$code"
NEW_NAME=$(jq1 .data.name)
NEW_ALLOC=$(jq1 .data.default_allocation_days)
check "name reflects" "Smoke Custom Renamed" "$NEW_NAME"
check "allocation reflects" "4" "$NEW_ALLOC"

echo ""
echo "── PATCH /leave-types empty body → 400 ─────────────────────────"
code=$(req PATCH "/leave-types/$CUSTOM_ID" '{}' "$ADMIN_ACCESS")
check "empty patch 400" 400 "$code"

echo ""
echo "── PATCH /leave-types as manager → 403 ─────────────────────────"
code=$(req PATCH "/leave-types/$CUSTOM_ID" '{"name":"mgr tries"}' "$MGR_ACCESS")
check "mgr patch 403" 403 "$code"

echo ""
echo "── POST /leave-types/:id/deactivate (admin) → 200 ──────────────"
code=$(req POST "/leave-types/$CUSTOM_ID/deactivate" '' "$ADMIN_ACCESS")
check "deactivate 200" 200 "$code"
IS_ACTIVE=$(jq1 .data.is_active)
check "is_active=false" "false" "$IS_ACTIVE"

echo ""
echo "── GET /leave-types?is_active=false includes deactivated ───────"
code=$(req GET '/leave-types?is_active=false' '' "$ADMIN_ACCESS")
check "list inactive 200" 200 "$code"
FOUND=$(jqx "b.data.some(t => t.id === '$CUSTOM_ID' && t.is_active === false)")
check "deactivated row appears" "true" "$FOUND"

# ── 4. /leave-balances — me / list / adjust / initialize ────────────────

YEAR_NOW=$(node -e "process.stdout.write(String(new Date().getUTCFullYear()))")

echo ""
echo "── GET /leave-balances/me as employee → 200 ────────────────────"
code=$(req GET '/leave-balances/me' '' "$EMP_ACCESS")
check "me 200" 200 "$code"
BAL_COUNT=$(jqx "b.data.length")
[[ "$BAL_COUNT" -ge 6 ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m at least 6 balance rows (got %s)\n" "$BAL_COUNT"; }
HAS_CL_ROW=$(jqx "b.data.some(r => r.leave_type && r.leave_type.code === 'CL')")
check "CL balance row present" "true" "$HAS_CL_ROW"
HAS_SL_DETAIL=$(jqx "b.data.some(r => r.sl_monthly_detail && typeof r.sl_monthly_detail.cap_per_month === 'number')")
check "SL row carries sl_monthly_detail" "true" "$HAS_SL_DETAIL"

CL_BAL_ID=$(jqx "(b.data.find(r => r.leave_type && r.leave_type.code === 'CL')||{}).id")
CL_BAL_AVAIL_BEFORE=$(jqx "(b.data.find(r => r.leave_type && r.leave_type.code === 'CL')||{}).available")
[[ -n "$CL_BAL_ID" && "$CL_BAL_ID" != "undefined" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m CL balance id\n"; }

echo ""
echo "── GET /leave-balances/me?year=$((YEAR_NOW + 1)) → 200 (auto-init) ──"
code=$(req GET "/leave-balances/me?year=$((YEAR_NOW + 1))" '' "$EMP_ACCESS")
check "future year 200" 200 "$code"

echo ""
echo "── GET /leave-balances?user_id= as manager → 200 ───────────────"
code=$(req GET "/leave-balances?user_id=$EMP_ID" '' "$MGR_ACCESS")
check "mgr list 200" 200 "$code"

echo ""
echo "── GET /leave-balances?user_id= as employee → 403 ──────────────"
code=$(req GET "/leave-balances?user_id=$EMP2_ID" '' "$EMP_ACCESS")
check "emp list 403" 403 "$code"

echo ""
echo "── PATCH /leave-balances/:id (admin) → 200 ─────────────────────"
code=$(req PATCH "/leave-balances/$CL_BAL_ID" '{"delta":1.5,"reason":"smoke compensatory bump"}' "$ADMIN_ACCESS")
check "adjust 200" 200 "$code"
NEW_AVAIL=$(jq1 .data.available)
[[ $(node -e "process.stdout.write(String(${NEW_AVAIL} - ${CL_BAL_AVAIL_BEFORE}))") == "1.5" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m available bumped by 1.5 (was %s, now %s)\n" "$CL_BAL_AVAIL_BEFORE" "$NEW_AVAIL"; }

echo ""
echo "── PATCH /leave-balances/:id delta=0 → 400 ─────────────────────"
code=$(req PATCH "/leave-balances/$CL_BAL_ID" '{"delta":0,"reason":"x"}' "$ADMIN_ACCESS")
check "delta=0 400" 400 "$code"

echo ""
echo "── PATCH /leave-balances as manager → 403 ──────────────────────"
code=$(req PATCH "/leave-balances/$CL_BAL_ID" '{"delta":1,"reason":"mgr"}' "$MGR_ACCESS")
check "mgr adjust 403" 403 "$code"

echo ""
echo "── POST /leave-balances/initialize-year (admin, idempotent) ────"
code=$(req POST '/leave-balances/initialize-year' "{\"year\":$((YEAR_NOW + 1))}" "$ADMIN_ACCESS")
check "init 201" 201 "$code"
PROCESSED=$(jq1 .data.processed_users)
[[ "$PROCESSED" -ge 3 ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m at least 3 users processed (got %s)\n" "$PROCESSED"; }

echo ""
echo "── Re-run initialize-year → 0 newly inserted (idempotent) ──────"
code=$(req POST '/leave-balances/initialize-year' "{\"year\":$((YEAR_NOW + 1))}" "$ADMIN_ACCESS")
check "init re-run 201" 201 "$code"
INSERTED=$(jq1 .data.total_inserted)
check "0 fresh inserts" "0" "$INSERTED"

# ── 5. /leaves — preview / apply / approve / reject / cancel ────────────

TODAY=$(today_iso)

# Pick stable-ish dates relative to today so the suite isn't seasonal.
NEXT_MONDAY=$(next_weekday "$TODAY" 1)
SL_DAY=$NEXT_MONDAY                                  # SL apply window (single day, 0-day notice)
CL_TOO_SOON=$(add_days "$TODAY" 7)                   # 7d notice — fails CL 14d gate
CL_OK=$(next_weekday "$(add_days "$TODAY" 21)" 1)    # First Monday ≥ today+21 → satisfies notice
CL_OK_END=$(add_days "$CL_OK" 2)                     # Mon..Wed (3 calendar days, 3 working days)
WEEKEND_DATE=$(next_weekday "$(add_days "$TODAY" 1)" 6) # next Saturday from tomorrow
BACKDATED='2020-01-01'

echo ""
echo "── Date plan ────────────────────────────────────────────────────"
echo "    today          = $TODAY"
echo "    SL_DAY (1 day) = $SL_DAY"
echo "    CL_TOO_SOON    = $CL_TOO_SOON"
echo "    CL_OK..END     = $CL_OK..$CL_OK_END"
echo "    WEEKEND_DATE   = $WEEKEND_DATE (Sat)"

echo ""
echo "── POST /leaves/preview-split (employee, future CL) → 200 ──────"
PREVIEW_BODY="{\"leave_type_id\":\"$CL_ID\",\"start_date\":\"$CL_OK\",\"end_date\":\"$CL_OK_END\",\"reason\":\"smoke preview\"}"
code=$(req POST '/leaves/preview-split' "$PREVIEW_BODY" "$EMP_ACCESS")
check "preview 200" 200 "$code"
TOTAL_DAYS=$(jq1 .data.total_days)
check "preview total_days=3" "3" "$TOTAL_DAYS"
SEG_COUNT=$(jqx "b.data.leave_segments.length")
check "preview 1 segment" "1" "$SEG_COUNT"
SEG_CODE=$(jqx "b.data.leave_segments[0].leave_type_code")
check "preview segment is CL" "CL" "$SEG_CODE"

echo ""
echo "── POST /leaves (employee) backdated → 422 LEAVE_BACKDATED_NOT_ALLOWED ─"
BAD_BODY="{\"leave_type_id\":\"$CL_ID\",\"start_date\":\"$BACKDATED\",\"end_date\":\"$BACKDATED\",\"reason\":\"backdate\"}"
code=$(req POST '/leaves' "$BAD_BODY" "$EMP_ACCESS")
check "backdate 422" 422 "$code"
err=$(jq1 .error.code)
check "LEAVE_BACKDATED_NOT_ALLOWED" "LEAVE_BACKDATED_NOT_ALLOWED" "$err"

echo ""
echo "── POST /leaves CL too-soon → 422 LEAVE_NOTICE_VIOLATION ───────"
TOO_SOON_BODY="{\"leave_type_id\":\"$CL_ID\",\"start_date\":\"$CL_TOO_SOON\",\"end_date\":\"$CL_TOO_SOON\",\"reason\":\"too soon\"}"
code=$(req POST '/leaves' "$TOO_SOON_BODY" "$EMP_ACCESS")
check "notice 422" 422 "$code"
err=$(jq1 .error.code)
check "LEAVE_NOTICE_VIOLATION" "LEAVE_NOTICE_VIOLATION" "$err"

echo ""
echo "── POST /leaves SL weekend-only → 422 LEAVE_NO_WORKING_DAYS ────"
WEEKEND_BODY="{\"leave_type_id\":\"$SL_ID\",\"start_date\":\"$WEEKEND_DATE\",\"end_date\":\"$WEEKEND_DATE\",\"reason\":\"weekend only\"}"
code=$(req POST '/leaves' "$WEEKEND_BODY" "$EMP_ACCESS")
check "weekend 422" 422 "$code"
err=$(jq1 .error.code)
check "LEAVE_NO_WORKING_DAYS" "LEAVE_NO_WORKING_DAYS" "$err"

echo ""
echo "── POST /leaves invalid half-day span → 400 (validator) ────────"
HALF_BAD_BODY="{\"leave_type_id\":\"$CL_ID\",\"start_date\":\"$CL_OK\",\"end_date\":\"$CL_OK_END\",\"is_half_day\":true,\"half_day_slot\":\"first_half\",\"reason\":\"bad half\"}"
code=$(req POST '/leaves' "$HALF_BAD_BODY" "$EMP_ACCESS")
check "half-day multi-day 400" 400 "$code"

echo ""
echo "── POST /leaves (employee, CL Mon-Wed) → 201 + balance reserved ─"
APPLY_BODY="{\"leave_type_id\":\"$CL_ID\",\"start_date\":\"$CL_OK\",\"end_date\":\"$CL_OK_END\",\"reason\":\"smoke vacation\"}"
code=$(req POST '/leaves' "$APPLY_BODY" "$EMP_ACCESS")
check "apply 201" 201 "$code"
LEAVE_ID=$(jq1 .data.id)
LEAVE_STATUS=$(jq1 .data.status)
check "status=pending" "pending" "$LEAVE_STATUS"
LEAVE_TOTAL=$(jq1 .data.total_days)
check "total_days=3" "3" "$LEAVE_TOTAL"

# Confirm balance moved from available → pending.
req GET '/leave-balances/me' '' "$EMP_ACCESS" >/dev/null
PEND_AFTER=$(jqx "(b.data.find(r => r.leave_type && r.leave_type.code === 'CL')||{}).pending")
[[ $(node -e "process.stdout.write(String(${PEND_AFTER} >= 3))") == "true" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m CL pending bumped to >=3 (got %s)\n" "$PEND_AFTER"; }

echo ""
echo "── POST /leaves overlap → 409 LEAVE_OVERLAP ────────────────────"
DUP_BODY="{\"leave_type_id\":\"$SL_ID\",\"start_date\":\"$CL_OK\",\"end_date\":\"$CL_OK\",\"reason\":\"overlap\"}"
code=$(req POST '/leaves' "$DUP_BODY" "$EMP_ACCESS")
check "overlap 409" 409 "$code"
err=$(jq1 .error.code)
check "LEAVE_OVERLAP" "LEAVE_OVERLAP" "$err"

echo ""
echo "── GET /leaves as employee returns own only ────────────────────"
code=$(req GET "/leaves" '' "$EMP_ACCESS")
check "own list 200" 200 "$code"
ALL_OWN=$(jqx "b.data.every(r => r.user_id === '$EMP_ID')")
check "all rows belong to caller" "true" "$ALL_OWN"

echo ""
echo "── GET /leaves?user_id= as employee → 200 (filter ignored, scoped to self) ─"
code=$(req GET "/leaves?user_id=$EMP2_ID" '' "$EMP_ACCESS")
check "emp filtered list 200" 200 "$code"
STILL_SELF=$(jqx "b.data.every(r => r.user_id === '$EMP_ID')")
check "still scoped to self" "true" "$STILL_SELF"

echo ""
echo "── GET /leaves?user_id= as manager → 200 (sees the target user) ─"
code=$(req GET "/leaves?user_id=$EMP_ID" '' "$MGR_ACCESS")
check "mgr filtered list 200" 200 "$code"

echo ""
echo "── GET /leaves/:id as the requester → 200 ──────────────────────"
code=$(req GET "/leaves/$LEAVE_ID" '' "$EMP_ACCESS")
check "get own 200" 200 "$code"

echo ""
echo "── GET /leaves/:id as another employee → 403 ───────────────────"
code=$(req GET "/leaves/$LEAVE_ID" '' "$EMP2_ACCESS")
check "get other 403" 403 "$code"

echo ""
echo "── POST /leaves/:id/approve as employee → 403 ──────────────────"
code=$(req POST "/leaves/$LEAVE_ID/approve" '{"approver_remarks":"emp tries"}' "$EMP_ACCESS")
check "emp approve 403" 403 "$code"

echo ""
echo "── POST /leaves/:id/approve as manager → 200 ───────────────────"
code=$(req POST "/leaves/$LEAVE_ID/approve" '{"approver_remarks":"approved by smoke mgr"}' "$MGR_ACCESS")
check "approve 200" 200 "$code"
NEW_STATUS=$(jq1 .data.status)
check "status=approved" "approved" "$NEW_STATUS"

# Confirm balance now in 'used' instead of 'pending'.
req GET '/leave-balances/me' '' "$EMP_ACCESS" >/dev/null
USED_AFTER=$(jqx "(b.data.find(r => r.leave_type && r.leave_type.code === 'CL')||{}).used")
[[ $(node -e "process.stdout.write(String(${USED_AFTER} >= 3))") == "true" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m CL used bumped to >=3 (got %s)\n" "$USED_AFTER"; }

echo ""
echo "── POST /leaves/:id/approve again → 409 (atomic guard) ─────────"
code=$(req POST "/leaves/$LEAVE_ID/approve" '{"approver_remarks":"second time"}' "$MGR_ACCESS")
check "second approve 409" 409 "$code"

echo ""
echo "── POST /leaves/:id/cancel (employee, future approved) → 200 ───"
code=$(req POST "/leaves/$LEAVE_ID/cancel" '{"cancellation_reason":"changed plans"}' "$EMP_ACCESS")
check "cancel 200" 200 "$code"
CANC_STATUS=$(jq1 .data.status)
check "status=cancelled" "cancelled" "$CANC_STATUS"

# Used should be back down (refunded) — we can't easily diff exactly because
# the admin bumped allocation by 1.5 earlier, but used should be < what it was.
req GET '/leave-balances/me' '' "$EMP_ACCESS" >/dev/null
USED_FINAL=$(jqx "(b.data.find(r => r.leave_type && r.leave_type.code === 'CL')||{}).used")
[[ $(node -e "process.stdout.write(String(${USED_FINAL} <= ${USED_AFTER} - 3))") == "true" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m CL used refunded by 3 (was %s, now %s)\n" "$USED_AFTER" "$USED_FINAL"; }

echo ""
echo "── POST /leaves/:id/cancel cancelled-already → 200 (no-op echo) ─"
code=$(req POST "/leaves/$LEAVE_ID/cancel" '{"cancellation_reason":"again"}' "$EMP_ACCESS")
check_in "cancel-twice no-op or 409" "$code" 200 409

echo ""
echo "── POST /leaves (apply again so we can test reject) ────────────"
APPLY2_BODY="{\"leave_type_id\":\"$CL_ID\",\"start_date\":\"$CL_OK\",\"end_date\":\"$CL_OK_END\",\"reason\":\"second apply\"}"
code=$(req POST '/leaves' "$APPLY2_BODY" "$EMP_ACCESS")
check "second apply 201" 201 "$code"
LEAVE2_ID=$(jq1 .data.id)

echo ""
echo "── POST /leaves/:id/reject as manager → 200 ────────────────────"
code=$(req POST "/leaves/$LEAVE2_ID/reject" '{"approver_remarks":"insufficient context"}' "$MGR_ACCESS")
check "reject 200" 200 "$code"
REJ_STATUS=$(jq1 .data.status)
check "status=rejected" "rejected" "$REJ_STATUS"

echo ""
echo "── POST /leaves/:id/cancel rejected → 409 ──────────────────────"
code=$(req POST "/leaves/$LEAVE2_ID/cancel" '{"cancellation_reason":"too late"}' "$EMP_ACCESS")
check "cancel rejected 409" 409 "$code"

echo ""
echo "── POST /leaves/:id/approve cannot review own → 403 (mgr applies & tries) ─"
SELF_BODY="{\"leave_type_id\":\"$SL_ID\",\"start_date\":\"$SL_DAY\",\"end_date\":\"$SL_DAY\",\"reason\":\"self apply\"}"
code=$(req POST '/leaves' "$SELF_BODY" "$MGR_ACCESS")
check "mgr self-apply 201" 201 "$code"
MGR_LEAVE_ID=$(jq1 .data.id)
code=$(req POST "/leaves/$MGR_LEAVE_ID/approve" '{"approver_remarks":"approving self"}' "$MGR_ACCESS")
check "mgr self-approve 403" 403 "$code"
# Admin can clean it up.
req POST "/leaves/$MGR_LEAVE_ID/cancel" '{"cancellation_reason":"cleanup"}' "$ADMIN_ACCESS" >/dev/null || true

echo ""
echo "── GET /leaves/calendar (any auth user, future window) → 200 ───"
CAL_FROM=$TODAY
CAL_TO=$(add_days "$TODAY" 60)
code=$(req GET "/leaves/calendar?from_date=$CAL_FROM&to_date=$CAL_TO" '' "$EMP_ACCESS")
check "calendar 200" 200 "$code"

# ── 6. /comp-off ─────────────────────────────────────────────────────────

echo ""
echo "── GET /comp-off/me as employee → 200 + balance number ─────────"
code=$(req GET '/comp-off/me' '' "$EMP_ACCESS")
check "me 200" 200 "$code"
BAL_BEFORE=$(jqx "Number(b.balance)")
[[ "$BAL_BEFORE" =~ ^-?[0-9]+(\.[0-9]+)?$ ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m balance is numeric (got %s)\n" "$BAL_BEFORE"; }

echo ""
echo "── POST /comp-off/adjust earned 2d (admin) → 201 ───────────────"
EARN_BODY="{\"user_id\":\"$EMP_ID\",\"type\":\"earned\",\"days\":2,\"remarks\":\"smoke earned\"}"
code=$(req POST '/comp-off/adjust' "$EARN_BODY" "$ADMIN_ACCESS")
check "earn 201" 201 "$code"
BAL_EARN=$(jq1 .data.balance)
[[ $(node -e "process.stdout.write(String(${BAL_EARN} - ${BAL_BEFORE}))") == "2" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m balance bumped by 2 (was %s, now %s)\n" "$BAL_BEFORE" "$BAL_EARN"; }

echo ""
echo "── POST /comp-off/adjust consume 0.5d (admin) → 201 ────────────"
CON_BODY="{\"user_id\":\"$EMP_ID\",\"type\":\"consumed\",\"days\":0.5,\"remarks\":\"smoke consume\"}"
code=$(req POST '/comp-off/adjust' "$CON_BODY" "$ADMIN_ACCESS")
check "consume 201" 201 "$code"
BAL_CON=$(jq1 .data.balance)
[[ $(node -e "process.stdout.write(String(${BAL_EARN} - ${BAL_CON}))") == "0.5" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m balance dropped by 0.5 (was %s, now %s)\n" "$BAL_EARN" "$BAL_CON"; }

echo ""
echo "── POST /comp-off/adjust consume > balance → 409 ───────────────"
OVER_BODY="{\"user_id\":\"$EMP_ID\",\"type\":\"consumed\",\"days\":99,\"remarks\":\"too much\"}"
code=$(req POST '/comp-off/adjust' "$OVER_BODY" "$ADMIN_ACCESS")
check "over-consume 409" 409 "$code"
err=$(jq1 .error.code)
check "INSUFFICIENT_LEAVE_BALANCE" "INSUFFICIENT_LEAVE_BALANCE" "$err"

echo ""
echo "── POST /comp-off/adjust as manager → 403 ──────────────────────"
code=$(req POST '/comp-off/adjust' "$EARN_BODY" "$MGR_ACCESS")
check "mgr adjust 403" 403 "$code"

echo ""
echo "── POST /comp-off/adjust days=0 → 400 (validator) ──────────────"
ZERO_BODY="{\"user_id\":\"$EMP_ID\",\"type\":\"earned\",\"days\":0,\"remarks\":\"zero\"}"
code=$(req POST '/comp-off/adjust' "$ZERO_BODY" "$ADMIN_ACCESS")
check "zero days 400" 400 "$code"

echo ""
echo "── POST /comp-off/adjust days=0.3 → 400 (not 0.5 increment) ────"
THIRD_BODY="{\"user_id\":\"$EMP_ID\",\"type\":\"earned\",\"days\":0.3,\"remarks\":\"thirds\"}"
code=$(req POST '/comp-off/adjust' "$THIRD_BODY" "$ADMIN_ACCESS")
check "non-half days 400" 400 "$code"

echo ""
echo "── GET /comp-off as employee → 403 ─────────────────────────────"
code=$(req GET '/comp-off' '' "$EMP_ACCESS")
check "emp list 403" 403 "$code"

echo ""
echo "── GET /comp-off as manager → 200 ──────────────────────────────"
code=$(req GET "/comp-off?user_id=$EMP_ID" '' "$MGR_ACCESS")
check "mgr list 200" 200 "$code"

# ── 7. No-token requests → 401 across the four surfaces ────────────────

echo ""
echo "── No-token requests → 401 ─────────────────────────────────────"
code=$(req GET    /leave-types       '')
check "GET /leave-types no-auth 401" 401 "$code"
code=$(req GET    /leave-balances/me '')
check "GET /leave-balances/me no-auth 401" 401 "$code"
code=$(req POST   /leaves            "$APPLY_BODY")
check "POST /leaves no-auth 401" 401 "$code"
code=$(req GET    /comp-off/me       '')
check "GET /comp-off/me no-auth 401" 401 "$code"

# ── 8. Concurrency: parallel approves on the same request ──────────────
#
# Apply once more, then fire two approves in parallel from the same role
# (manager). One should win (200 → approved), the other should lose with
# 409. We tolerate the rare case where both serialize cleanly (one 200 +
# one 409 is the contract; two 200 would be the bug).

echo ""
echo "── Concurrency: two parallel approves race → exactly one 200 ───"
RACE_BODY="{\"leave_type_id\":\"$CL_ID\",\"start_date\":\"$CL_OK\",\"end_date\":\"$CL_OK\",\"reason\":\"race target\"}"
# Cancel the still-pending earlier requests for this user first so we don't
# trip LEAVE_OVERLAP.
cleanup_user_leaves "$EMP_ID"
code=$(req POST '/leaves' "$RACE_BODY" "$EMP_ACCESS")
check "race apply 201" 201 "$code"
RACE_ID=$(jq1 .data.id)

# Two parallel approves.
codeA_file=/tmp/sm.race.A
codeB_file=/tmp/sm.race.B
( curl -sS -o "$codeA_file.json" -w '%{http_code}' -X POST "$API/leaves/$RACE_ID/approve" \
    -H 'Content-Type: application/json' -H "Authorization: Bearer $MGR_ACCESS" \
    -d '{"approver_remarks":"raceA"}' >"$codeA_file.code" ) &
pidA=$!
( curl -sS -o "$codeB_file.json" -w '%{http_code}' -X POST "$API/leaves/$RACE_ID/approve" \
    -H 'Content-Type: application/json' -H "Authorization: Bearer $ADMIN_ACCESS" \
    -d '{"approver_remarks":"raceB"}' >"$codeB_file.code" ) &
pidB=$!
wait $pidA
wait $pidB
codeA=$(cat "$codeA_file.code")
codeB=$(cat "$codeB_file.code")
echo "    raceA=$codeA raceB=$codeB"
WINNERS=$(node -e "const a='$codeA',b='$codeB'; let n=0; if(a==='200')n++; if(b==='200')n++; console.log(n)")
LOSERS=$(node -e "const a='$codeA',b='$codeB'; let n=0; if(a==='409')n++; if(b==='409')n++; console.log(n)")
check "exactly one winner (200)" "1" "$WINNERS"
check "exactly one loser (409)"  "1" "$LOSERS"

# Final cleanup so the suite is rerunnable: cancel the race target.
req POST "/leaves/$RACE_ID/cancel" '{"cancellation_reason":"race cleanup"}' "$ADMIN_ACCESS" >/dev/null || true

# ── 9. Final cleanup ────────────────────────────────────────────────────

echo ""
echo "── Final cleanup ───────────────────────────────────────────────"
cleanup_user_leaves "$EMP_ID"
cleanup_user_leaves "$EMP2_ID"
cleanup_user_leaves "$MGR_ID"
# Custom leave type was already deactivated above; nothing else to do.

echo ""
echo "────────────────────────────────────────────────────────────────"
printf "  \e[1m%d passed, %d failed\e[0m\n" "$pass" "$fail"
echo "────────────────────────────────────────────────────────────────"
exit $fail
