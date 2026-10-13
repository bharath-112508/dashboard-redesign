#!/usr/bin/env bash
# End-to-end smoke test for /office-locations (Step 7).
#
# Runs against a server already listening on http://localhost:3001.
# Uses the seed admin (smoke@example.com / SmokeA@123!).
# Lazily creates a smoke manager + employee for the RBAC tests.
#
# To get a fresh DB state first, run `npx tsx scripts/smoke-reset-users.ts`.
# Soft-deleted rows accumulate across runs by design (DELETE is soft-only —
# hard cleanup is via direct DB ops if you really need it).
set -u

API=http://localhost:3001/api/v1
ADMIN_EMAIL=smoke@example.com
ADMIN_PASS='SmokeA@123!'

MGR_EMAIL=smoke-mgr@example.com
MGR_PASS='SmokeM@123!'

EMP_EMAIL=smoke-emp@example.com
EMP_PASS='SmokeE@123!'

# Stamp every created row so reruns don't visually collide in the DB.
STAMP=$(date +%s)
LOCATION_NAME="Smoke Office ${STAMP}"
LOCATION_NAME_2="Smoke Annex ${STAMP}"
LOCATION_ADDR='4th Floor, Tower B, Embassy Tech Village, Bangalore'

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
    # usage: req METHOD PATH BODY [TOKEN]
    local method=$1 path=$2 body=$3 token=${4:-}
    local args=(-sS -o /tmp/sm.json -w '%{http_code}' -X "$method" "$API$path" -H 'Content-Type: application/json')
    [[ -n "$token" ]] && args+=(-H "Authorization: Bearer $token")
    [[ -n "$body" ]] && args+=(-d "$body")
    curl "${args[@]}"
}

jq1() {
    # APPEND a JS expression to the parsed body.
    #   jq1 .data.id          → JSON.parse(...).data.id
    node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/sm.json','utf8'))$1)"
}

jqx() {
    # Bind the parsed body to `b`, then evaluate an arbitrary expression.
    #   jqx "b.data.qr_code_token.length"
    node -e "const b=JSON.parse(require('fs').readFileSync('/tmp/sm.json','utf8')); console.log($1)"
}

login_get_token() {
    local email=$1 password=$2
    req POST /auth/login "{\"email\":\"$email\",\"password\":\"$password\"}" >/dev/null
    jq1 .data.access_token
}

# ─── 0. Login as admin ─────────────────────────────────────────────────────

echo "── Login as admin ──────────────────────────────────────────────"
code=$(req POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
check "admin login 200" 200 "$code"
ADMIN_ACCESS=$(jq1 .data.access_token)

# ─── 1. POST /office-locations as admin ───────────────────────────────────

echo ""
echo "── POST /office-locations (admin) → 201 + QR ──────────────────"
code=$(req POST /office-locations "{\"name\":\"$LOCATION_NAME\",\"address\":\"$LOCATION_ADDR\"}" "$ADMIN_ACCESS")
check "create 201" 201 "$code"
LOC_ID=$(jq1 .data.id)
LOC_TOKEN=$(jq1 .data.qr_code_token)
echo "    id    = $LOC_ID"
echo "    token = $LOC_TOKEN (len=${#LOC_TOKEN})"
TOKEN_LEN=$(jqx "b.data.qr_code_token.length")
check "qr_code_token base64url length=32" "32" "$TOKEN_LEN"
TOKEN_FORMAT=$(jqx "/^[A-Za-z0-9_-]+$/.test(b.data.qr_code_token)")
check "qr_code_token is base64url" "true" "$TOKEN_FORMAT"
IMG_URL_NULL=$(jqx "b.data.qr_code_image_url === null")
check "qr_code_image_url null pending Blob" "true" "$IMG_URL_NULL"
QR_PREFIX=$(jqx "b.data.qr_data_url.slice(0,30)")
check "qr_data_url is PNG data URL" "data:image/png;base64," "${QR_PREFIX:0:22}"
IS_ACTIVE=$(jq1 .data.is_active)
check "is_active true on create" "true" "$IS_ACTIVE"
CREATED_BY=$(jqx "typeof b.data.created_by === 'string' && b.data.created_by.length === 24")
check "created_by stamped (24-char hex)" "true" "$CREATED_BY"

# ─── 2. POST validation ───────────────────────────────────────────────────

echo ""
echo "── POST validation ────────────────────────────────────────────"
code=$(req POST /office-locations '{}' "$ADMIN_ACCESS")
check "empty body 400" 400 "$code"
err_code=$(jq1 .error.code)
check "VALIDATION_ERROR" "VALIDATION_ERROR" "$err_code"

code=$(req POST /office-locations "{\"name\":\"\",\"address\":\"x\"}" "$ADMIN_ACCESS")
check "blank name 400" 400 "$code"

code=$(req POST /office-locations "{\"name\":\"x\"}" "$ADMIN_ACCESS")
check "missing address 400" 400 "$code"

LONG_NAME=$(node -e "process.stdout.write('x'.repeat(201))")
code=$(req POST /office-locations "{\"name\":\"$LONG_NAME\",\"address\":\"y\"}" "$ADMIN_ACCESS")
check "name>200 chars 400" 400 "$code"

# ─── 3. GET /office-locations (list) ──────────────────────────────────────

echo ""
echo "── GET /office-locations (admin, list) ────────────────────────"
code=$(req GET "/office-locations?limit=100" '' "$ADMIN_ACCESS")
check "list 200" 200 "$code"
HAS_META=$(jqx "b.meta && typeof b.meta.total === 'number'")
check "paginated meta present" "true" "$HAS_META"
HAS_OUR_ROW=$(jqx "b.data.some((r) => r.id === '$LOC_ID')")
check "list contains created row" "true" "$HAS_OUR_ROW"

echo ""
echo "── GET ?is_active=true filters out inactive ──────────────────"
code=$(req GET "/office-locations?is_active=true&limit=100" '' "$ADMIN_ACCESS")
check "filter 200" 200 "$code"
ALL_ACTIVE=$(jqx "b.data.every((r) => r.is_active === true)")
check "every row is_active=true" "true" "$ALL_ACTIVE"

echo ""
echo "── GET ?q=<unique> matches by name ────────────────────────────"
code=$(req GET "/office-locations?q=${STAMP}&limit=100" '' "$ADMIN_ACCESS")
check "search 200" 200 "$code"
SEARCH_LEN=$(jqx "b.data.length")
if [[ "$SEARCH_LEN" -ge 1 ]]; then
    pass=$((pass + 1))
    printf "  \e[32mPASS\e[0m search returned >=1 row\n"
else
    fail=$((fail + 1))
    printf "  \e[31mFAIL\e[0m search returned 0 rows\n"
fi

# ─── 4. GET /office-locations/:id ─────────────────────────────────────────

echo ""
echo "── GET /office-locations/:id (admin) ──────────────────────────"
code=$(req GET "/office-locations/$LOC_ID" '' "$ADMIN_ACCESS")
check "get one 200" 200 "$code"
GOT_NAME=$(jq1 .data.name)
check "name matches" "$LOCATION_NAME" "$GOT_NAME"
GOT_TOKEN=$(jq1 .data.qr_code_token)
check "token matches creation token" "$LOC_TOKEN" "$GOT_TOKEN"

echo ""
echo "── GET /office-locations/<unknown> → 404 ──────────────────────"
code=$(req GET "/office-locations/000000000000000000000000" '' "$ADMIN_ACCESS")
check "unknown id 404" 404 "$code"

echo ""
echo "── GET /office-locations/<bad-id> → 400 (CastError) ───────────"
code=$(req GET "/office-locations/not-an-objectid" '' "$ADMIN_ACCESS")
check "bad id 400" 400 "$code"

# ─── 5. PATCH /office-locations/:id ───────────────────────────────────────

echo ""
echo "── PATCH name ──────────────────────────────────────────────────"
code=$(req PATCH "/office-locations/$LOC_ID" "{\"name\":\"$LOCATION_NAME_2\"}" "$ADMIN_ACCESS")
check "patch 200" 200 "$code"
NEW_NAME=$(jq1 .data.name)
check "name reflects" "$LOCATION_NAME_2" "$NEW_NAME"
SAME_TOKEN=$(jq1 .data.qr_code_token)
check "token unchanged on PATCH" "$LOC_TOKEN" "$SAME_TOKEN"

echo ""
echo "── PATCH empty body → 400 ────────────────────────────────────"
code=$(req PATCH "/office-locations/$LOC_ID" '{}' "$ADMIN_ACCESS")
check "empty patch 400" 400 "$code"

echo ""
echo "── PATCH is_active=false (soft-deactivate) ────────────────────"
code=$(req PATCH "/office-locations/$LOC_ID" '{"is_active":false}' "$ADMIN_ACCESS")
check "deactivate 200" 200 "$code"
DEACT=$(jq1 .data.is_active)
check "is_active false" "false" "$DEACT"

echo ""
echo "── ?is_active=true now excludes the row ──────────────────────"
code=$(req GET "/office-locations?is_active=true&limit=100" '' "$ADMIN_ACCESS")
check "active-only filter 200" 200 "$code"
HAS_DEACT_ROW=$(jqx "b.data.some((r) => r.id === '$LOC_ID')")
check "deactivated row hidden from active list" "false" "$HAS_DEACT_ROW"

echo ""
echo "── PATCH is_active=true (reactivate) ──────────────────────────"
code=$(req PATCH "/office-locations/$LOC_ID" '{"is_active":true}' "$ADMIN_ACCESS")
check "reactivate 200" 200 "$code"
REACT=$(jq1 .data.is_active)
check "is_active true again" "true" "$REACT"

# ─── 6. POST /office-locations/:id/regenerate-qr ──────────────────────────

echo ""
echo "── POST /:id/regenerate-qr (admin) ────────────────────────────"
code=$(req POST "/office-locations/$LOC_ID/regenerate-qr" '' "$ADMIN_ACCESS")
check "regenerate 200" 200 "$code"
NEW_TOKEN=$(jq1 .data.qr_code_token)
if [[ "$NEW_TOKEN" != "$LOC_TOKEN" ]]; then
    pass=$((pass + 1))
    printf "  \e[32mPASS\e[0m token rotated (different from original)\n"
else
    fail=$((fail + 1))
    printf "  \e[31mFAIL\e[0m token NOT rotated\n"
fi
NEW_TOKEN_LEN=$(jqx "b.data.qr_code_token.length")
check "rotated token length=32" "32" "$NEW_TOKEN_LEN"
NEW_IMG_NULL=$(jqx "b.data.qr_code_image_url === null")
check "qr_code_image_url stays null after rotate" "true" "$NEW_IMG_NULL"
QR_PREFIX2=$(jqx "b.data.qr_data_url.slice(0,30)")
check "qr_data_url still PNG after rotate" "data:image/png;base64," "${QR_PREFIX2:0:22}"

# ─── 7. RBAC — without token ──────────────────────────────────────────────

echo ""
echo "── No-token requests → 401 ────────────────────────────────────"
code=$(req GET "/office-locations" '')
check "GET list no-auth 401" 401 "$code"
code=$(req POST "/office-locations" '{"name":"x","address":"y"}')
check "POST no-auth 401" 401 "$code"
code=$(req PATCH "/office-locations/$LOC_ID" '{"name":"x"}')
check "PATCH no-auth 401" 401 "$code"
code=$(req DELETE "/office-locations/$LOC_ID" '')
check "DELETE no-auth 401" 401 "$code"
code=$(req POST "/office-locations/$LOC_ID/regenerate-qr" '')
check "regenerate no-auth 401" 401 "$code"

# ─── 8. RBAC — manager (lazy create) ──────────────────────────────────────

echo ""
echo "── Lazily create smoke manager (ignore 409) ───────────────────"
MGR_BODY="{\"email\":\"$MGR_EMAIL\",\"full_name\":\"Smoke Manager\",\"role\":\"manager\",\"initial_password\":\"$MGR_PASS\",\"internal_profile\":{\"employee_id\":\"SMOKE-MGR-001\",\"job_title\":\"Engineering Manager\",\"department\":\"Eng\",\"date_of_joining\":\"2025-01-01\"}}"
code=$(req POST /users "$MGR_BODY" "$ADMIN_ACCESS")
if [[ "$code" == "201" ]]; then
    echo "  created smoke manager"
elif [[ "$code" == "409" ]]; then
    echo "  smoke manager already exists (reusing)"
else
    printf "  \e[31mFAIL\e[0m create manager unexpected code %s\n" "$code"
    fail=$((fail + 1))
fi

MGR_ACCESS=$(login_get_token "$MGR_EMAIL" "$MGR_PASS")
if [[ -n "$MGR_ACCESS" && "$MGR_ACCESS" != "undefined" ]]; then
    pass=$((pass + 1))
    printf "  \e[32mPASS\e[0m manager login OK\n"
else
    fail=$((fail + 1))
    printf "  \e[31mFAIL\e[0m manager login failed\n"
fi

echo ""
echo "── Manager can READ ──────────────────────────────────────────"
code=$(req GET "/office-locations" '' "$MGR_ACCESS")
check "manager list 200" 200 "$code"
code=$(req GET "/office-locations/$LOC_ID" '' "$MGR_ACCESS")
check "manager get 200" 200 "$code"

echo ""
echo "── Manager CANNOT WRITE → 403 ────────────────────────────────"
code=$(req POST /office-locations '{"name":"mgr-tries","address":"x"}' "$MGR_ACCESS")
check "manager POST 403" 403 "$code"
code=$(req PATCH "/office-locations/$LOC_ID" '{"name":"mgr-tries"}' "$MGR_ACCESS")
check "manager PATCH 403" 403 "$code"
code=$(req POST "/office-locations/$LOC_ID/regenerate-qr" '' "$MGR_ACCESS")
check "manager regenerate 403" 403 "$code"
code=$(req DELETE "/office-locations/$LOC_ID" '' "$MGR_ACCESS")
check "manager DELETE 403" 403 "$code"

# ─── 9. RBAC — employee (lazy create) ─────────────────────────────────────

echo ""
echo "── Lazily create smoke employee (ignore 409) ──────────────────"
EMP_BODY="{\"email\":\"$EMP_EMAIL\",\"full_name\":\"Smoke Employee\",\"role\":\"employee\",\"initial_password\":\"$EMP_PASS\",\"internal_profile\":{\"employee_id\":\"SMOKE-EMP-001\",\"job_title\":\"Engineer\",\"department\":\"Eng\",\"date_of_joining\":\"2025-01-01\"}}"
code=$(req POST /users "$EMP_BODY" "$ADMIN_ACCESS")
if [[ "$code" == "201" ]]; then
    echo "  created smoke employee"
elif [[ "$code" == "409" ]]; then
    echo "  smoke employee already exists (reusing)"
else
    printf "  \e[31mFAIL\e[0m create employee unexpected code %s\n" "$code"
    fail=$((fail + 1))
fi

EMP_ACCESS=$(login_get_token "$EMP_EMAIL" "$EMP_PASS")
if [[ -n "$EMP_ACCESS" && "$EMP_ACCESS" != "undefined" ]]; then
    pass=$((pass + 1))
    printf "  \e[32mPASS\e[0m employee login OK\n"
else
    fail=$((fail + 1))
    printf "  \e[31mFAIL\e[0m employee login failed\n"
fi

echo ""
echo "── Employee CANNOT READ or WRITE → 403 ───────────────────────"
code=$(req GET "/office-locations" '' "$EMP_ACCESS")
check "employee list 403" 403 "$code"
code=$(req GET "/office-locations/$LOC_ID" '' "$EMP_ACCESS")
check "employee get 403" 403 "$code"
code=$(req POST /office-locations '{"name":"emp-tries","address":"x"}' "$EMP_ACCESS")
check "employee POST 403" 403 "$code"
code=$(req DELETE "/office-locations/$LOC_ID" '' "$EMP_ACCESS")
check "employee DELETE 403" 403 "$code"

# ─── 10. DELETE (soft) ───────────────────────────────────────────────────

echo ""
echo "── DELETE /office-locations/:id (admin) → 204 ────────────────"
code=$(req DELETE "/office-locations/$LOC_ID" '' "$ADMIN_ACCESS")
check "delete 204" 204 "$code"

echo ""
echo "── After DELETE, GET still works (soft-only) ─────────────────"
code=$(req GET "/office-locations/$LOC_ID" '' "$ADMIN_ACCESS")
check "get after soft-delete 200" 200 "$code"
SOFT_DEACT=$(jq1 .data.is_active)
check "is_active false after soft delete" "false" "$SOFT_DEACT"

echo ""
echo "── DELETE on unknown id → 404 ────────────────────────────────"
code=$(req DELETE "/office-locations/000000000000000000000000" '' "$ADMIN_ACCESS")
check "delete unknown 404" 404 "$code"

echo ""
echo "────────────────────────────────────────────────────────────────"
printf "  \e[1m%d passed, %d failed\e[0m\n" "$pass" "$fail"
echo "────────────────────────────────────────────────────────────────"
exit $fail
