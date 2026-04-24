#!/usr/bin/env bash
# End-to-end smoke test for /holidays (Step 9).
#
# Runs against a server already listening on http://localhost:3001.
# Uses the seed admin (smoke@example.com / SmokeA@123!) and lazily creates
# a smoke manager + employee so we can prove the contract:
#  - All authenticated roles READ.
#  - Only admin can WRITE (POST / POST /bulk / PATCH / DELETE).
#
# Strategy: every run picks a fresh future-year window (`SMOKE_YEAR`) so
# repeated runs don't collide on the unique `date` index. A best-effort
# cleanup at the start removes any stale `Smoke Holiday ${STAMP}` rows
# from prior runs in that year.
set -u

API=http://localhost:3001/api/v1
ADMIN_EMAIL=smoke@example.com
ADMIN_PASS='SmokeA@123!'

MGR_EMAIL=smoke-mgr@example.com
MGR_PASS='SmokeM@123!'

EMP_EMAIL=smoke-emp@example.com
EMP_PASS='SmokeE@123!'

# Use a far-future year so we never collide with real holidays the admin
# might be entering, and so two runs back-to-back collide *intentionally*
# on the dup-date checks but not on the per-run picked dates.
SMOKE_YEAR=2099
DATE_A="${SMOKE_YEAR}-01-26"   # Republic Day
DATE_B="${SMOKE_YEAR}-08-15"   # Independence Day
DATE_C="${SMOKE_YEAR}-10-02"   # Gandhi Jayanti
DATE_D="${SMOKE_YEAR}-12-25"   # Christmas
DATE_BAD='2099-13-40'          # bad month/day
DATE_BADFMT='2099/01/26'       # bad separator

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

req() {
    local method=$1 path=$2 body=$3 token=${4:-}
    local args=(-sS -o /tmp/sm.json -w '%{http_code}' -X "$method" "$API$path" -H 'Content-Type: application/json')
    [[ -n "$token" ]] && args+=(-H "Authorization: Bearer $token")
    [[ -n "$body" ]] && args+=(-d "$body")
    curl "${args[@]}"
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
    body="{\"email\":\"$email\",\"full_name\":\"$full\",\"role\":\"$role\",\"initial_password\":\"$password\",\"internal_profile\":{\"employee_id\":\"$empid\",\"job_title\":\"$job\",\"department\":\"Eng\",\"date_of_joining\":\"2025-01-01\"}}"
    local code
    code=$(req POST /users "$body" "$ADMIN_ACCESS")
    if [[ "$code" == "201" ]]; then
        echo "  created $email"
    elif [[ "$code" == "409" ]]; then
        echo "  $email already exists (reusing)"
    else
        printf "  \e[31mFAIL\e[0m create %s unexpected code %s\n" "$email" "$code"
        fail=$((fail + 1))
    fi
}

# ─── 0. Login as admin ────────────────────────────────────────────────────

echo "── Login as admin ──────────────────────────────────────────────"
code=$(req POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
check "admin login 200" 200 "$code"
ADMIN_ACCESS=$(jq1 .data.access_token)

# ─── 1. Lazy-create supporting users ─────────────────────────────────────

echo ""
echo "── Lazy-create smoke users (idempotent on 409) ─────────────────"
ensure_user "$MGR_EMAIL" "$MGR_PASS" manager  "Smoke Manager"  SMOKE-MGR-001 "Engineering Manager"
ensure_user "$EMP_EMAIL" "$EMP_PASS" employee "Smoke Employee" SMOKE-EMP-001 "Engineer"

MGR_ACCESS=$(login_get_token "$MGR_EMAIL" "$MGR_PASS")
EMP_ACCESS=$(login_get_token "$EMP_EMAIL" "$EMP_PASS")
[[ -n "$MGR_ACCESS" && "$MGR_ACCESS" != "undefined" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m manager login\n"; }
[[ -n "$EMP_ACCESS" && "$EMP_ACCESS" != "undefined" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m employee login\n"; }

# ─── 2. Wipe ALL smoke-year holidays so the run is fully idempotent ──────

echo ""
echo "── Best-effort cleanup of ${SMOKE_YEAR} smoke holidays ────────"
req GET "/holidays?year=${SMOKE_YEAR}" '' "$ADMIN_ACCESS" >/dev/null
EXISTING_IDS=$(jqx "b.data.map(h => h.id).join(' ')")
if [[ -n "$EXISTING_IDS" ]]; then
    for id in $EXISTING_IDS; do
        req DELETE "/holidays/$id" '' "$ADMIN_ACCESS" >/dev/null || true
    done
    echo "    deleted $(echo "$EXISTING_IDS" | wc -w | tr -d ' ') stale row(s)"
else
    echo "    nothing to clean up"
fi

# ─── 3. POST /holidays — happy path ──────────────────────────────────────

echo ""
echo "── POST /holidays (admin) → 201 ───────────────────────────────"
code=$(req POST /holidays "{\"date\":\"$DATE_A\",\"name\":\"Smoke Republic Day ${SMOKE_YEAR}\"}" "$ADMIN_ACCESS")
check "create 201" 201 "$code"
HOL_A_ID=$(jq1 .data.id)
HOL_A_DATE=$(jq1 .data.date)
HOL_A_NAME=$(jq1 .data.name)
HOL_A_OPT=$(jq1 .data.is_optional)
check "date echoed" "$DATE_A" "$HOL_A_DATE"
check "name echoed" "Smoke Republic Day ${SMOKE_YEAR}" "$HOL_A_NAME"
check "is_optional defaults false" "false" "$HOL_A_OPT"
HAS_CREATED_BY=$(jqx "typeof b.data.created_by === 'string' && b.data.created_by.length === 24")
check "created_by stamped" "true" "$HAS_CREATED_BY"

echo ""
echo "── POST is_optional=true → echoed ─────────────────────────────"
code=$(req POST /holidays "{\"date\":\"$DATE_B\",\"name\":\"Smoke Independence Day\",\"is_optional\":true}" "$ADMIN_ACCESS")
check "create optional 201" 201 "$code"
HOL_B_ID=$(jq1 .data.id)
HOL_B_OPT=$(jq1 .data.is_optional)
check "is_optional true echoed" "true" "$HOL_B_OPT"

# ─── 4. POST /holidays — duplicate date → 409 ────────────────────────────

echo ""
echo "── Duplicate date → 409 DUPLICATE_RESOURCE ────────────────────"
code=$(req POST /holidays "{\"date\":\"$DATE_A\",\"name\":\"Same date again\"}" "$ADMIN_ACCESS")
check "dup 409" 409 "$code"
err=$(jq1 .error.code)
check "DUPLICATE_RESOURCE" "DUPLICATE_RESOURCE" "$err"

# ─── 5. POST /holidays — validation ──────────────────────────────────────

echo ""
echo "── POST validation ────────────────────────────────────────────"
code=$(req POST /holidays '{}' "$ADMIN_ACCESS")
check "empty body 400" 400 "$code"

code=$(req POST /holidays "{\"date\":\"$DATE_BAD\",\"name\":\"x\"}" "$ADMIN_ACCESS")
check "impossible calendar date 400" 400 "$code"

code=$(req POST /holidays "{\"date\":\"$DATE_BADFMT\",\"name\":\"x\"}" "$ADMIN_ACCESS")
check "wrong separator 400" 400 "$code"

code=$(req POST /holidays "{\"date\":\"$DATE_C\",\"name\":\"\"}" "$ADMIN_ACCESS")
check "blank name 400" 400 "$code"

LONG_NAME=$(node -e "process.stdout.write('x'.repeat(101))")
code=$(req POST /holidays "{\"date\":\"$DATE_C\",\"name\":\"$LONG_NAME\"}" "$ADMIN_ACCESS")
check "name>100 chars 400" 400 "$code"

# ─── 6. POST /holidays/bulk ──────────────────────────────────────────────

echo ""
echo "── POST /holidays/bulk → mix new + existing ───────────────────"
BULK_BODY="{\"items\":[
    {\"date\":\"$DATE_A\",\"name\":\"already exists\"},
    {\"date\":\"$DATE_C\",\"name\":\"Smoke Gandhi Jayanti\"},
    {\"date\":\"$DATE_D\",\"name\":\"Smoke Christmas\",\"is_optional\":true}
]}"
code=$(req POST /holidays/bulk "$BULK_BODY" "$ADMIN_ACCESS")
check "bulk 201" 201 "$code"
INSERTED_LEN=$(jqx "b.data.inserted.length")
check "2 rows inserted" "2" "$INSERTED_LEN"
SKIPPED_LEN=$(jqx "b.data.skipped.length")
check "1 row skipped" "1" "$SKIPPED_LEN"
SKIPPED_DATE=$(jqx "b.data.skipped[0].date")
check "skipped is the dup date" "$DATE_A" "$SKIPPED_DATE"
SKIPPED_REASON=$(jqx "b.data.skipped[0].reason")
check "skipped reason already_exists" "already_exists" "$SKIPPED_REASON"

echo ""
echo "── Bulk validation: in-payload duplicate → 400 ────────────────"
DUP_PAYLOAD="{\"items\":[
    {\"date\":\"${SMOKE_YEAR}-11-01\",\"name\":\"a\"},
    {\"date\":\"${SMOKE_YEAR}-11-01\",\"name\":\"b\"}
]}"
code=$(req POST /holidays/bulk "$DUP_PAYLOAD" "$ADMIN_ACCESS")
check "in-payload dup 400" 400 "$code"

echo ""
echo "── Bulk validation: empty items array → 400 ───────────────────"
code=$(req POST /holidays/bulk '{"items":[]}' "$ADMIN_ACCESS")
check "empty bulk 400" 400 "$code"

# ─── 7. GET /holidays — list / filters ───────────────────────────────────

echo ""
echo "── GET /holidays?year=${SMOKE_YEAR} returns the 4 we created ─"
code=$(req GET "/holidays?year=${SMOKE_YEAR}" '' "$ADMIN_ACCESS")
check "list 200" 200 "$code"
TOTAL=$(jqx "b.meta.total")
check "meta.total = 4" "4" "$TOTAL"
SORTED=$(jqx "b.data.every((h, i, arr) => i === 0 || arr[i-1].date <= h.date)")
check "rows sorted by date asc" "true" "$SORTED"
HAS_FROM=$(jqx "b.meta.from_date")
check "year expanded to from_date Jan 1" "${SMOKE_YEAR}-01-01" "$HAS_FROM"
HAS_TO=$(jqx "b.meta.to_date")
check "year expanded to to_date Dec 31" "${SMOKE_YEAR}-12-31" "$HAS_TO"

echo ""
echo "── GET /holidays?from_date=&to_date= narrows the window ──────"
code=$(req GET "/holidays?from_date=${SMOKE_YEAR}-08-01&to_date=${SMOKE_YEAR}-10-31" '' "$ADMIN_ACCESS")
check "narrow 200" 200 "$code"
NARROW_TOTAL=$(jqx "b.meta.total")
check "narrow returns 2 rows" "2" "$NARROW_TOTAL"

echo ""
echo "── Explicit window beats year shortcut ───────────────────────"
code=$(req GET "/holidays?year=2050&from_date=${SMOKE_YEAR}-08-01&to_date=${SMOKE_YEAR}-10-31" '' "$ADMIN_ACCESS")
check "explicit wins 200" 200 "$code"
EXPLICIT_FROM=$(jqx "b.meta.from_date")
check "from_date is the explicit one" "${SMOKE_YEAR}-08-01" "$EXPLICIT_FROM"

echo ""
echo "── GET /holidays?is_optional=true filters ─────────────────────"
code=$(req GET "/holidays?year=${SMOKE_YEAR}&is_optional=true" '' "$ADMIN_ACCESS")
check "filter optional 200" 200 "$code"
OPT_TOTAL=$(jqx "b.meta.total")
check "optional rows = 2 (Independence + Christmas)" "2" "$OPT_TOTAL"
ALL_OPT=$(jqx "b.data.every(h => h.is_optional === true)")
check "all returned rows is_optional=true" "true" "$ALL_OPT"

echo ""
echo "── List validation: from > to → 400 ──────────────────────────"
code=$(req GET "/holidays?from_date=${SMOKE_YEAR}-12-31&to_date=${SMOKE_YEAR}-01-01" '' "$ADMIN_ACCESS")
check "swapped range 400" 400 "$code"

echo ""
echo "── List validation: only one of from/to → 400 ────────────────"
code=$(req GET "/holidays?from_date=${SMOKE_YEAR}-01-01" '' "$ADMIN_ACCESS")
check "missing to_date 400" 400 "$code"
code=$(req GET "/holidays?to_date=${SMOKE_YEAR}-12-31" '' "$ADMIN_ACCESS")
check "missing from_date 400" 400 "$code"

echo ""
echo "── List validation: range > 5 years → 400 ────────────────────"
code=$(req GET "/holidays?from_date=2020-01-01&to_date=2030-01-01" '' "$ADMIN_ACCESS")
check "10-year span 400" 400 "$code"

# ─── 8. PATCH /holidays/:id ──────────────────────────────────────────────

echo ""
echo "── PATCH name only ─────────────────────────────────────────────"
code=$(req PATCH "/holidays/$HOL_A_ID" '{"name":"Smoke Republic Day RENAMED"}' "$ADMIN_ACCESS")
check "patch 200" 200 "$code"
NEW_NAME=$(jq1 .data.name)
check "name reflects" "Smoke Republic Day RENAMED" "$NEW_NAME"
SAME_DATE=$(jq1 .data.date)
check "date unchanged on PATCH" "$DATE_A" "$SAME_DATE"

echo ""
echo "── PATCH is_optional=true ────────────────────────────────────"
code=$(req PATCH "/holidays/$HOL_A_ID" '{"is_optional":true}' "$ADMIN_ACCESS")
check "patch optional 200" 200 "$code"
NEW_OPT=$(jq1 .data.is_optional)
check "is_optional now true" "true" "$NEW_OPT"

echo ""
echo "── PATCH date to a free day ──────────────────────────────────"
FREE_DATE="${SMOKE_YEAR}-03-21"
code=$(req PATCH "/holidays/$HOL_A_ID" "{\"date\":\"$FREE_DATE\"}" "$ADMIN_ACCESS")
check "patch date 200" 200 "$code"
NEW_DATE=$(jq1 .data.date)
check "date updated" "$FREE_DATE" "$NEW_DATE"

echo ""
echo "── PATCH date to an occupied day → 409 ───────────────────────"
code=$(req PATCH "/holidays/$HOL_A_ID" "{\"date\":\"$DATE_B\"}" "$ADMIN_ACCESS")
check "dup-on-patch 409" 409 "$code"
err=$(jq1 .error.code)
check "DUPLICATE_RESOURCE" "DUPLICATE_RESOURCE" "$err"

echo ""
echo "── PATCH empty body → 400 ────────────────────────────────────"
code=$(req PATCH "/holidays/$HOL_A_ID" '{}' "$ADMIN_ACCESS")
check "empty patch 400" 400 "$code"

echo ""
echo "── PATCH unknown id → 404 ────────────────────────────────────"
code=$(req PATCH "/holidays/000000000000000000000000" '{"name":"ghost"}' "$ADMIN_ACCESS")
check "unknown 404" 404 "$code"

echo ""
echo "── PATCH bad ObjectId → 400 ──────────────────────────────────"
code=$(req PATCH "/holidays/not-an-objectid" '{"name":"x"}' "$ADMIN_ACCESS")
check "bad id 400" 400 "$code"

# ─── 9. RBAC — manager + employee READ allowed, WRITE 403 ────────────────

echo ""
echo "── Manager can READ ──────────────────────────────────────────"
code=$(req GET "/holidays?year=${SMOKE_YEAR}" '' "$MGR_ACCESS")
check "manager list 200" 200 "$code"

echo ""
echo "── Employee can READ ─────────────────────────────────────────"
code=$(req GET "/holidays?year=${SMOKE_YEAR}" '' "$EMP_ACCESS")
check "employee list 200" 200 "$code"

echo ""
echo "── Manager CANNOT WRITE → 403 ────────────────────────────────"
code=$(req POST /holidays "{\"date\":\"${SMOKE_YEAR}-04-01\",\"name\":\"mgr tries\"}" "$MGR_ACCESS")
check "manager POST 403" 403 "$code"
code=$(req POST /holidays/bulk '{"items":[{"date":"2099-04-02","name":"x"}]}' "$MGR_ACCESS")
check "manager bulk 403" 403 "$code"
code=$(req PATCH "/holidays/$HOL_A_ID" '{"name":"mgr tries"}' "$MGR_ACCESS")
check "manager PATCH 403" 403 "$code"
code=$(req DELETE "/holidays/$HOL_A_ID" '' "$MGR_ACCESS")
check "manager DELETE 403" 403 "$code"

echo ""
echo "── Employee CANNOT WRITE → 403 ───────────────────────────────"
code=$(req POST /holidays "{\"date\":\"${SMOKE_YEAR}-04-01\",\"name\":\"emp tries\"}" "$EMP_ACCESS")
check "employee POST 403" 403 "$code"
code=$(req PATCH "/holidays/$HOL_A_ID" '{"name":"emp tries"}' "$EMP_ACCESS")
check "employee PATCH 403" 403 "$code"
code=$(req DELETE "/holidays/$HOL_A_ID" '' "$EMP_ACCESS")
check "employee DELETE 403" 403 "$code"

# ─── 10. No-token requests → 401 ─────────────────────────────────────────

echo ""
echo "── No-token requests → 401 ───────────────────────────────────"
code=$(req GET "/holidays" '')
check "GET list no-auth 401" 401 "$code"
code=$(req POST "/holidays" "{\"date\":\"${SMOKE_YEAR}-05-01\",\"name\":\"x\"}")
check "POST no-auth 401" 401 "$code"
code=$(req PATCH "/holidays/$HOL_A_ID" '{"name":"x"}')
check "PATCH no-auth 401" 401 "$code"
code=$(req DELETE "/holidays/$HOL_A_ID" '')
check "DELETE no-auth 401" 401 "$code"

# ─── 11. DELETE (hard) ───────────────────────────────────────────────────

echo ""
echo "── DELETE /holidays/:id (admin) → 204 ────────────────────────"
code=$(req DELETE "/holidays/$HOL_B_ID" '' "$ADMIN_ACCESS")
check "delete 204" 204 "$code"

echo ""
echo "── DELETE again → 404 (hard delete) ──────────────────────────"
code=$(req DELETE "/holidays/$HOL_B_ID" '' "$ADMIN_ACCESS")
check "second delete 404" 404 "$code"

echo ""
echo "── List no longer shows deleted row ──────────────────────────"
code=$(req GET "/holidays?year=${SMOKE_YEAR}" '' "$ADMIN_ACCESS")
HAS_DEL_ROW=$(jqx "b.data.some(h => h.id === '$HOL_B_ID')")
check "deleted row absent from list" "false" "$HAS_DEL_ROW"

echo ""
echo "── DELETE unknown id → 404 ───────────────────────────────────"
code=$(req DELETE "/holidays/000000000000000000000000" '' "$ADMIN_ACCESS")
check "delete unknown 404" 404 "$code"

# ─── 12. Final cleanup so the suite is rerunnable ────────────────────────

echo ""
echo "── Final cleanup of remaining ${SMOKE_YEAR} smoke rows ────────"
req GET "/holidays?year=${SMOKE_YEAR}" '' "$ADMIN_ACCESS" >/dev/null
LEFTOVER_IDS=$(jqx "b.data.map(h => h.id).join(' ')")
if [[ -n "$LEFTOVER_IDS" ]]; then
    for id in $LEFTOVER_IDS; do
        req DELETE "/holidays/$id" '' "$ADMIN_ACCESS" >/dev/null || true
    done
    echo "    cleaned $(echo "$LEFTOVER_IDS" | wc -w | tr -d ' ') trailing row(s)"
fi

echo ""
echo "────────────────────────────────────────────────────────────────"
printf "  \e[1m%d passed, %d failed\e[0m\n" "$pass" "$fail"
echo "────────────────────────────────────────────────────────────────"
exit $fail
