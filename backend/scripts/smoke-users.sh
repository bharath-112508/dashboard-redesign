#!/usr/bin/env bash
# End-to-end smoke test for /users/* (Step 3).
#
# Runs against a server already listening on http://localhost:3001.
# Uses the seed admin (smoke@example.com / SmokeA@123!).
# Lazily creates ~5 fixture users (employee, manager, client, plus a couple
# of role-axis edge cases). Idempotent across runs — 409 on duplicate create
# is treated as "fixture already exists".
#
# To get a fresh DB state first, run `npx tsx scripts/smoke-reset-users.ts`.
set -u

API=http://localhost:3001/api/v1
ADMIN_EMAIL=smoke@example.com
ADMIN_PASS='SmokeA@123!'

# NOTE: EMP_PASS / MGR_PASS must match the values smoke-settings.sh and
# smoke-office-locations.sh hard-code for the same accounts (SmokeE@123! /
# SmokeM@123!). Keep these aligned so cross-suite logins keep working when
# smoke-all.sh runs everything in sequence against the same DB.
EMP_EMAIL=smoke-emp@example.com
EMP_PASS='SmokeE@123!'
MGR_EMAIL=smoke-mgr@example.com
MGR_PASS='SmokeM@123!'
CLIENT_EMAIL=smoke-client@example.com
CLIENT_PASS='Cli@1234567'
EMP2_EMAIL=smoke-emp2@example.com
EMP2_PASS='Emp@2234567'

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

# Login as admin and capture token
echo "── Login as seed admin ────────────────────────────────────────"
code=$(req POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
check "admin login 200" 200 "$code"
ADMIN_ACCESS=$(jq1 .data.access_token)
ADMIN_ID=$(jq1 .data.user.id)
echo "    admin id=$ADMIN_ID"

# ─── 1. POST /users — validation matrix ──────────────────────────────────

echo ""
echo "── POST /users — validation ──────────────────────────────────"
code=$(req POST /users '{}' "$ADMIN_ACCESS")
check "empty body 400" 400 "$code"

code=$(req POST /users '{"email":"x@y.com","full_name":"","role":"employee","initial_password":"SomePass@1"}' "$ADMIN_ACCESS")
check "blank full_name 400" 400 "$code"

# Missing initial_password
code=$(req POST /users '{"email":"x@y.com","full_name":"X","role":"employee"}' "$ADMIN_ACCESS")
check "missing initial_password 400" 400 "$code"

# role=employee without internal_profile
code=$(req POST /users "{\"email\":\"shape-emp@example.com\",\"full_name\":\"Shape Emp\",\"role\":\"employee\",\"initial_password\":\"$EMP_PASS\"}" "$ADMIN_ACCESS")
check "employee w/o internal_profile 400" 400 "$code"

# role=manager without internal_profile
code=$(req POST /users "{\"email\":\"shape-mgr@example.com\",\"full_name\":\"Shape Mgr\",\"role\":\"manager\",\"initial_password\":\"$MGR_PASS\"}" "$ADMIN_ACCESS")
check "manager w/o internal_profile 400" 400 "$code"

# role=client without client_profile
code=$(req POST /users "{\"email\":\"shape-cli@example.com\",\"full_name\":\"Shape Cli\",\"role\":\"client\",\"initial_password\":\"$CLIENT_PASS\"}" "$ADMIN_ACCESS")
check "client w/o client_profile 400" 400 "$code"

# role=employee with client_profile
code=$(req POST /users "{\"email\":\"shape-emp2@example.com\",\"full_name\":\"Shape Emp2\",\"role\":\"employee\",\"initial_password\":\"$EMP_PASS\",\"client_profile\":{\"company_name\":\"X\",\"access_type\":\"login\"}}" "$ADMIN_ACCESS")
check "employee w/ client_profile 400" 400 "$code"

# role=client with internal_profile
code=$(req POST /users "{\"email\":\"shape-cli2@example.com\",\"full_name\":\"Shape Cli2\",\"role\":\"client\",\"initial_password\":\"$CLIENT_PASS\",\"client_profile\":{\"company_name\":\"X\",\"access_type\":\"login\"},\"internal_profile\":{\"employee_id\":\"X\",\"job_title\":\"X\",\"department\":\"X\",\"date_of_joining\":\"2025-01-01\"}}" "$ADMIN_ACCESS")
check "client w/ internal_profile 400" 400 "$code"

# Weak initial_password (passes structural validator, fails policy in service → 422)
code=$(req POST /users "{\"email\":\"shape-weak@example.com\",\"full_name\":\"Weak Pass\",\"role\":\"employee\",\"initial_password\":\"weak\",\"internal_profile\":{\"employee_id\":\"WEAK-1\",\"job_title\":\"QA\",\"department\":\"Eng\",\"date_of_joining\":\"2025-01-01\"}}" "$ADMIN_ACCESS")
check "weak password 422" 422 "$code"
err=$(jq1 .error.code)
check "PASSWORD_POLICY_VIOLATION" "PASSWORD_POLICY_VIOLATION" "$err"

# role=admin while admin already active → 409 ADMIN_ALREADY_EXISTS
code=$(req POST /users "{\"email\":\"shape-2admin@example.com\",\"full_name\":\"Second Admin\",\"role\":\"admin\",\"initial_password\":\"Adm@1234567\",\"internal_profile\":{\"employee_id\":\"ADM-2\",\"job_title\":\"Boss\",\"department\":\"Mgmt\",\"date_of_joining\":\"2025-01-01\"}}" "$ADMIN_ACCESS")
check "second admin 409" 409 "$code"
err=$(jq1 .error.code)
check "ADMIN_ALREADY_EXISTS" "ADMIN_ALREADY_EXISTS" "$err"

# ─── 2. POST /users — happy paths (lazy 409) ─────────────────────────────

echo ""
echo "── POST /users — create employee ─────────────────────────────"
EMP_BODY="{\"email\":\"$EMP_EMAIL\",\"full_name\":\"Smoke Employee\",\"role\":\"employee\",\"initial_password\":\"$EMP_PASS\",\"internal_profile\":{\"employee_id\":\"SMOKE-EMP-001\",\"job_title\":\"Engineer\",\"department\":\"Eng\",\"date_of_joining\":\"2025-01-01\"}}"
code=$(req POST /users "$EMP_BODY" "$ADMIN_ACCESS")
if [[ "$code" == "201" ]]; then
    EMP_ID=$(jq1 .data.id)
    NO_HASH=$(jqx "!('password_hash' in b.data)")
    check "employee created 201" 201 "$code"
    check "password_hash NOT returned" "true" "$NO_HASH"
    HAS_PROFILE=$(jqx "b.data.internal_profile && b.data.internal_profile.employee_id === 'SMOKE-EMP-001'")
    check "internal_profile echoed" "true" "$HAS_PROFILE"
elif [[ "$code" == "409" ]]; then
    echo "  employee exists — looking up id"
    code=$(req GET "/users?q=$EMP_EMAIL&limit=10" '' "$ADMIN_ACCESS")
    EMP_ID=$(jqx "(b.data.find((u)=>u.email==='$EMP_EMAIL')||{}).id")
    pass=$((pass + 1))
    echo "    EMP_ID=$EMP_ID"
else
    printf "  \e[31mFAIL\e[0m unexpected code %s\n" "$code"
    fail=$((fail + 1))
    EMP_ID=""
fi

echo ""
echo "── POST /users — duplicate email → 409 ───────────────────────"
code=$(req POST /users "$EMP_BODY" "$ADMIN_ACCESS")
check "duplicate 409" 409 "$code"
err=$(jq1 .error.code)
check "EMAIL_ALREADY_EXISTS" "EMAIL_ALREADY_EXISTS" "$err"

echo ""
echo "── POST /users — create manager ──────────────────────────────"
MGR_BODY="{\"email\":\"$MGR_EMAIL\",\"full_name\":\"Smoke Manager\",\"role\":\"manager\",\"initial_password\":\"$MGR_PASS\",\"internal_profile\":{\"employee_id\":\"SMOKE-MGR-001\",\"job_title\":\"Manager\",\"department\":\"Eng\",\"date_of_joining\":\"2025-01-01\"}}"
code=$(req POST /users "$MGR_BODY" "$ADMIN_ACCESS")
if [[ "$code" == "201" || "$code" == "409" ]]; then
    if [[ "$code" == "201" ]]; then
        MGR_ID=$(jq1 .data.id)
    else
        code=$(req GET "/users?q=$MGR_EMAIL&limit=10" '' "$ADMIN_ACCESS")
        MGR_ID=$(jqx "(b.data.find((u)=>u.email==='$MGR_EMAIL')||{}).id")
    fi
    printf "  \e[32mPASS\e[0m manager ready (id=%s)\n" "$MGR_ID"
    pass=$((pass + 1))
else
    printf "  \e[31mFAIL\e[0m manager create %s\n" "$code"
    fail=$((fail + 1))
fi

echo ""
echo "── POST /users — create client ───────────────────────────────"
CLIENT_BODY="{\"email\":\"$CLIENT_EMAIL\",\"full_name\":\"Smoke Client\",\"role\":\"client\",\"initial_password\":\"$CLIENT_PASS\",\"client_profile\":{\"company_name\":\"Acme\",\"point_of_contact\":\"AcmeBoss\",\"access_type\":\"login\"}}"
code=$(req POST /users "$CLIENT_BODY" "$ADMIN_ACCESS")
if [[ "$code" == "201" || "$code" == "409" ]]; then
    if [[ "$code" == "201" ]]; then
        CLIENT_ID=$(jq1 .data.id)
        HAS_CLIENT_PROFILE=$(jqx "b.data.client_profile && b.data.client_profile.company_name === 'Acme'")
        check "client_profile echoed" "true" "$HAS_CLIENT_PROFILE"
        NO_INTERNAL=$(jqx "!b.data.internal_profile || Object.keys(b.data.internal_profile).length === 0")
        check "internal_profile NOT set on client" "true" "$NO_INTERNAL"
    else
        code=$(req GET "/users?q=$CLIENT_EMAIL&limit=10" '' "$ADMIN_ACCESS")
        CLIENT_ID=$(jqx "(b.data.find((u)=>u.email==='$CLIENT_EMAIL')||{}).id")
    fi
    printf "  \e[32mPASS\e[0m client ready (id=%s)\n" "$CLIENT_ID"
    pass=$((pass + 1))
else
    printf "  \e[31mFAIL\e[0m client create %s\n" "$code"
    fail=$((fail + 1))
fi

echo ""
echo "── POST /users — create employee #2 (for change-role tests) ──"
EMP2_BODY="{\"email\":\"$EMP2_EMAIL\",\"full_name\":\"Smoke Employee 2\",\"role\":\"employee\",\"initial_password\":\"$EMP2_PASS\",\"internal_profile\":{\"employee_id\":\"SMOKE-EMP-002\",\"job_title\":\"Engineer\",\"department\":\"Eng\",\"date_of_joining\":\"2025-01-01\"}}"
code=$(req POST /users "$EMP2_BODY" "$ADMIN_ACCESS")
if [[ "$code" == "201" || "$code" == "409" ]]; then
    if [[ "$code" == "201" ]]; then
        EMP2_ID=$(jq1 .data.id)
    else
        code=$(req GET "/users?q=$EMP2_EMAIL&limit=10" '' "$ADMIN_ACCESS")
        EMP2_ID=$(jqx "(b.data.find((u)=>u.email==='$EMP2_EMAIL')||{}).id")
    fi
    printf "  \e[32mPASS\e[0m emp2 ready (id=%s)\n" "$EMP2_ID"
    pass=$((pass + 1))
else
    printf "  \e[31mFAIL\e[0m emp2 create %s\n" "$code"
    fail=$((fail + 1))
fi

# Snapshot active state of EMP2 so we can restore at end (in case prior runs deactivated)
code=$(req POST "/users/$EMP2_ID/reactivate" '' "$ADMIN_ACCESS")
# don't assert — best-effort cleanup of prior-run state

# ─── 3. GET /users — listing ─────────────────────────────────────────────

echo ""
echo "── GET /users — admin can list ───────────────────────────────"
code=$(req GET /users '' "$ADMIN_ACCESS")
check "list 200" 200 "$code"
HAS_META=$(jqx "b.meta && typeof b.meta.page === 'number' && typeof b.meta.total === 'number'")
check "pagination meta present" "true" "$HAS_META"
HAS_OUR_ROW=$(jqx "Array.isArray(b.data) && b.data.some((u) => u.email === '$EMP_EMAIL')")
check "list contains our employee" "true" "$HAS_OUR_ROW"

echo ""
echo "── GET /users?role=employee — filter ─────────────────────────"
code=$(req GET '/users?role=employee&limit=100' '' "$ADMIN_ACCESS")
check "filter by role 200" 200 "$code"
ALL_EMP=$(jqx "b.data.every((u) => u.role === 'employee')")
check "all rows are employees" "true" "$ALL_EMP"

echo ""
echo "── GET /users?status=active — filter ─────────────────────────"
code=$(req GET '/users?status=active&limit=100' '' "$ADMIN_ACCESS")
check "filter by status 200" 200 "$code"
ALL_ACTIVE=$(jqx "b.data.every((u) => u.status === 'active')")
check "all rows are active" "true" "$ALL_ACTIVE"

echo ""
echo "── GET /users?q=Smoke — search ───────────────────────────────"
code=$(req GET '/users?q=Smoke&limit=100' '' "$ADMIN_ACCESS")
check "search 200" 200 "$code"
ANY_HIT=$(jqx "b.data.some((u) => /Smoke/i.test(u.full_name) || /smoke/i.test(u.email))")
check "search returns matches" "true" "$ANY_HIT"

echo ""
echo "── GET /users — pagination meta math ─────────────────────────"
code=$(req GET '/users?page=1&limit=2' '' "$ADMIN_ACCESS")
check "limit=2 200" 200 "$code"
PAGE_OK=$(jqx "b.data.length <= 2 && b.meta.page === 1 && b.meta.limit === 2 && b.meta.total_pages >= 1")
check "page meta consistent" "true" "$PAGE_OK"

# ─── 4. GET /users/:id ───────────────────────────────────────────────────

echo ""
echo "── GET /users/:id — admin can fetch any ──────────────────────"
code=$(req GET "/users/$EMP_ID" '' "$ADMIN_ACCESS")
check "admin → employee 200" 200 "$code"
GOT_EMAIL=$(jq1 .data.email)
check "email matches" "$EMP_EMAIL" "$GOT_EMAIL"

echo ""
echo "── GET /users/<unknown id> → 404 ─────────────────────────────"
code=$(req GET "/users/000000000000000000000000" '' "$ADMIN_ACCESS")
check "unknown 404" 404 "$code"

echo ""
echo "── GET /users/<bad id> → 400 (CastError) ─────────────────────"
code=$(req GET "/users/not-a-real-id" '' "$ADMIN_ACCESS")
check "bad id 400" 400 "$code"

# ─── 5. PATCH /users/:id ─────────────────────────────────────────────────

echo ""
echo "── PATCH /users/:id — empty body 400 ─────────────────────────"
code=$(req PATCH "/users/$EMP_ID" '{}' "$ADMIN_ACCESS")
check "empty patch 400" 400 "$code"

echo ""
echo "── PATCH (admin) — full_name + nested ────────────────────────"
NEW_NAME="Smoke Employee — patched $(date +%s)"
code=$(req PATCH "/users/$EMP_ID" "{\"full_name\":\"$NEW_NAME\",\"internal_profile\":{\"job_title\":\"Senior Engineer\"}}" "$ADMIN_ACCESS")
check "admin patch 200" 200 "$code"
GOT_NAME=$(jq1 .data.full_name)
check "full_name updated" "$NEW_NAME" "$GOT_NAME"
GOT_TITLE=$(jq1 .data.internal_profile.job_title)
check "job_title updated" "Senior Engineer" "$GOT_TITLE"
# employee_id should still be there (shallow merge of internal_profile)
GOT_EMP_ID=$(jq1 .data.internal_profile.employee_id)
check "employee_id preserved (shallow merge)" "SMOKE-EMP-001" "$GOT_EMP_ID"

echo ""
echo "── PATCH employee on client → role-axis 400 ──────────────────"
code=$(req PATCH "/users/$CLIENT_ID" '{"internal_profile":{"job_title":"X"}}' "$ADMIN_ACCESS")
check "internal_profile on client 400" 400 "$code"

code=$(req PATCH "/users/$EMP_ID" '{"client_profile":{"company_name":"X","access_type":"login"}}' "$ADMIN_ACCESS")
check "client_profile on employee 400" 400 "$code"

# ─── 6. PATCH self vs admin ──────────────────────────────────────────────

echo ""
echo "── Login as employee ─────────────────────────────────────────"
code=$(req POST /auth/login "{\"email\":\"$EMP_EMAIL\",\"password\":\"$EMP_PASS\"}")
check "employee login 200" 200 "$code"
EMP_ACCESS=$(jq1 .data.access_token)

echo ""
echo "── PATCH self (full_name) → 200 ──────────────────────────────"
code=$(req PATCH "/users/$EMP_ID" '{"full_name":"Self-Patched Name"}' "$EMP_ACCESS")
check "self full_name 200" 200 "$code"

echo ""
echo "── PATCH self emergency_contact (allowlisted nested) → 200 ──"
code=$(req PATCH "/users/$EMP_ID" '{"internal_profile":{"emergency_contact":{"name":"Mom","phone":"+91-9999999999","relation":"mother"}}}' "$EMP_ACCESS")
check "self emergency_contact 200" 200 "$code"
EC=$(jq1 .data.internal_profile.emergency_contact.name)
check "emergency_contact saved" "Mom" "$EC"

echo ""
echo "── PATCH self job_title (NOT allowlisted) → 403 ──────────────"
# When the only field in the patch is a non-allowlisted nested key, the
# service strips it and complains there's nothing left to patch (403).
code=$(req PATCH "/users/$EMP_ID" '{"internal_profile":{"job_title":"Hacker"}}' "$EMP_ACCESS")
check "self job_title 403" 403 "$code"

echo ""
echo "── PATCH another user as employee → 403 ─────────────────────"
code=$(req PATCH "/users/$EMP2_ID" '{"full_name":"Hacked"}' "$EMP_ACCESS")
check "self → other 403" 403 "$code"

# ─── 7. RBAC — list/create as non-admin ─────────────────────────────────

echo ""
echo "── GET /users as employee → 403 ──────────────────────────────"
code=$(req GET /users '' "$EMP_ACCESS")
check "employee list 403" 403 "$code"

echo ""
echo "── POST /users as employee → 403 ─────────────────────────────"
code=$(req POST /users "$EMP_BODY" "$EMP_ACCESS")
check "employee create 403" 403 "$code"

echo ""
echo "── Login as manager ──────────────────────────────────────────"
code=$(req POST /auth/login "{\"email\":\"$MGR_EMAIL\",\"password\":\"$MGR_PASS\"}")
check "manager login 200" 200 "$code"
MGR_ACCESS=$(jq1 .data.access_token)

echo ""
echo "── GET /users as manager → 200 (read-only access) ───────────"
code=$(req GET /users '' "$MGR_ACCESS")
check "manager list 200" 200 "$code"

echo ""
echo "── POST /users as manager → 403 (write is admin-only) ───────"
code=$(req POST /users "$EMP_BODY" "$MGR_ACCESS")
check "manager create 403" 403 "$code"

echo ""
echo "── GET /users/:id as manager (any user) → 200 ───────────────"
code=$(req GET "/users/$EMP_ID" '' "$MGR_ACCESS")
check "manager → employee 200" 200 "$code"

echo ""
echo "── GET self as employee → 200 ────────────────────────────────"
code=$(req GET "/users/$EMP_ID" '' "$EMP_ACCESS")
check "employee → self 200" 200 "$code"

echo ""
echo "── GET other user as employee → 403 ──────────────────────────"
code=$(req GET "/users/$ADMIN_ID" '' "$EMP_ACCESS")
check "employee → admin 403" 403 "$code"

# ─── 8. Deactivate / reactivate ─────────────────────────────────────────

echo ""
echo "── POST /users/:id/deactivate as employee → 403 ─────────────"
code=$(req POST "/users/$EMP2_ID/deactivate" '{}' "$EMP_ACCESS")
check "employee deactivate 403" 403 "$code"

echo ""
echo "── POST /users/:id/deactivate self (admin) → 403 ────────────"
code=$(req POST "/users/$ADMIN_ID/deactivate" '{}' "$ADMIN_ACCESS")
check "admin self-deactivate 403" 403 "$code"

echo ""
echo "── POST /users/:id/deactivate (admin → emp2) → 200 ──────────"
code=$(req POST "/users/$EMP2_ID/deactivate" '{"reason":"smoke"}' "$ADMIN_ACCESS")
check "deactivate 200" 200 "$code"
STATUS=$(jq1 .data.status)
check "status=deactivated" "deactivated" "$STATUS"

echo ""
echo "── Login as deactivated emp2 → 403 ───────────────────────────"
code=$(req POST /auth/login "{\"email\":\"$EMP2_EMAIL\",\"password\":\"$EMP2_PASS\"}")
check "deactivated login 403" 403 "$code"

echo ""
echo "── POST /users/:id/deactivate idempotent → 200 ──────────────"
code=$(req POST "/users/$EMP2_ID/deactivate" '{}' "$ADMIN_ACCESS")
check "deactivate again 200" 200 "$code"

echo ""
echo "── POST /users/:id/reactivate (admin) → 200 ──────────────────"
code=$(req POST "/users/$EMP2_ID/reactivate" '' "$ADMIN_ACCESS")
check "reactivate 200" 200 "$code"
STATUS=$(jq1 .data.status)
check "status=active" "active" "$STATUS"

echo ""
echo "── POST /users/:id/reactivate idempotent → 200 ──────────────"
code=$(req POST "/users/$EMP2_ID/reactivate" '' "$ADMIN_ACCESS")
check "reactivate again 200" 200 "$code"

echo ""
echo "── POST /users/:id/reactivate as employee → 403 ─────────────"
code=$(req POST "/users/$EMP2_ID/reactivate" '' "$EMP_ACCESS")
check "employee reactivate 403" 403 "$code"

# ─── 9. Change role ─────────────────────────────────────────────────────

echo ""
echo "── POST /users/:id/change-role (admin) employee → manager ───"
code=$(req POST "/users/$EMP2_ID/change-role" '{"new_role":"manager"}' "$ADMIN_ACCESS")
check "promote employee→manager 200" 200 "$code"
ROLE=$(jq1 .data.role)
check "role=manager" "manager" "$ROLE"

echo ""
echo "── change-role idempotent (same role) → 200 ─────────────────"
code=$(req POST "/users/$EMP2_ID/change-role" '{"new_role":"manager"}' "$ADMIN_ACCESS")
check "same role 200" 200 "$code"

echo ""
echo "── change-role to admin (active admin exists) → 409 ─────────"
code=$(req POST "/users/$EMP2_ID/change-role" '{"new_role":"admin"}' "$ADMIN_ACCESS")
check "promote to second admin 409" 409 "$code"
err=$(jq1 .error.code)
check "ADMIN_ALREADY_EXISTS" "ADMIN_ALREADY_EXISTS" "$err"

echo ""
echo "── change-role across client/internal axis → 400 ────────────"
code=$(req POST "/users/$EMP2_ID/change-role" '{"new_role":"client"}' "$ADMIN_ACCESS")
check "manager→client 400" 400 "$code"
code=$(req POST "/users/$CLIENT_ID/change-role" '{"new_role":"employee"}' "$ADMIN_ACCESS")
check "client→employee 400" 400 "$code"

echo ""
echo "── change-role self → 403 ────────────────────────────────────"
code=$(req POST "/users/$ADMIN_ID/change-role" '{"new_role":"manager"}' "$ADMIN_ACCESS")
check "admin self-demote 403" 403 "$code"

echo ""
echo "── change-role as employee → 403 ─────────────────────────────"
code=$(req POST "/users/$EMP2_ID/change-role" '{"new_role":"employee"}' "$EMP_ACCESS")
check "employee change-role 403" 403 "$code"

# Restore emp2 back to employee for next run
code=$(req POST "/users/$EMP2_ID/change-role" '{"new_role":"employee"}' "$ADMIN_ACCESS")

# ─── 10. GET /users/assignable ─────────────────────────────────────────

echo ""
echo "── GET /users/assignable — default (excludes clients) ───────"
code=$(req GET /users/assignable '' "$ADMIN_ACCESS")
check "assignable 200" 200 "$code"
NO_CLIENTS=$(jqx "Array.isArray(b.data) && b.data.every((u) => u.role !== 'client')")
check "no clients in default" "true" "$NO_CLIENTS"
HAS_OUR_EMP=$(jqx "b.data.some((u) => u.id === '$EMP_ID')")
check "includes our employee" "true" "$HAS_OUR_EMP"

echo ""
echo "── GET /users/assignable?role=manager — filter ──────────────"
code=$(req GET '/users/assignable?role=manager' '' "$ADMIN_ACCESS")
check "filter manager 200" 200 "$code"
ALL_MGR=$(jqx "b.data.every((u) => u.role === 'manager')")
check "all are managers" "true" "$ALL_MGR"

echo ""
echo "── GET /users/assignable as employee → 200 (open to all) ────"
code=$(req GET /users/assignable '' "$EMP_ACCESS")
check "employee assignable 200" 200 "$code"

echo ""
echo "── GET /users/assignable?role=client → ok but 0/few ─────────"
code=$(req GET '/users/assignable?role=client' '' "$ADMIN_ACCESS")
check "explicit role=client 200" 200 "$code"
ALL_CLIENT=$(jqx "b.data.every((u) => u.role === 'client')")
check "explicit role=client honoured" "true" "$ALL_CLIENT"

# ─── 11. Auth requirement on every /users endpoint ──────────────────────

echo ""
echo "── Every /users endpoint requires auth ──────────────────────"
code=$(req GET /users '')
check "GET /users no-auth 401" 401 "$code"
code=$(req POST /users "$EMP_BODY")
check "POST /users no-auth 401" 401 "$code"
code=$(req GET "/users/$EMP_ID" '')
check "GET /users/:id no-auth 401" 401 "$code"
code=$(req PATCH "/users/$EMP_ID" '{"full_name":"X"}')
check "PATCH no-auth 401" 401 "$code"
code=$(req POST "/users/$EMP_ID/deactivate" '{}')
check "deactivate no-auth 401" 401 "$code"
code=$(req POST "/users/$EMP_ID/reactivate" '')
check "reactivate no-auth 401" 401 "$code"
code=$(req POST "/users/$EMP_ID/change-role" '{"new_role":"manager"}')
check "change-role no-auth 401" 401 "$code"
code=$(req GET /users/assignable '')
check "assignable no-auth 401" 401 "$code"

# ─── 12. Cleanup — restore EMP names for next run ──────────────────────

echo ""
echo "── Cleanup: restore emp full_name ───────────────────────────"
code=$(req PATCH "/users/$EMP_ID" '{"full_name":"Smoke Employee"}' "$ADMIN_ACCESS")
check "emp restored" 200 "$code"

echo ""
echo "────────────────────────────────────────────────────────────────"
printf "  \e[1m%d passed, %d failed\e[0m\n" "$pass" "$fail"
echo "────────────────────────────────────────────────────────────────"
exit $fail
