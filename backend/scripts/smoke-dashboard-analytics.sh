#!/usr/bin/env bash
# End-to-end smoke test for the dashboard analytics endpoints (Task 10).
#
# Covers:
#   - Admin: GET /dashboard/admin/analytics?range=month → 200 + .data.sections.kpi present
#   - Admin: GET /dashboard/admin/analytics?range=bogus  → 400 (validator rejects unknown range)
#   - Employee (403 on admin scope): GET /dashboard/admin/analytics → 403
#   - Employee (own scope): GET /dashboard/employee/analytics       → 200
#
# Requires a dev server on :3001.
# Admin creds:    smoke@example.com / SmokeA@123!
# Employee creds: smoke-emp-da@example.com / SmokeE@123!  (lazily created)
set -euo pipefail

API=http://localhost:3001/api/v1
ADMIN_EMAIL=smoke@example.com
ADMIN_PASS='SmokeA@123!'

EMP_EMAIL=smoke-emp-da@example.com
EMP_PASS='SmokeE@123!'

pass=0
fail=0

# ─── Helpers ─────────────────────────────────────────────────────────────────

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

# ─── 0. Login as admin ────────────────────────────────────────────────────────

echo "── Login as admin ──────────────────────────────────────────────"
code=$(req POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
check "admin login 200" 200 "$code"
ADMIN_ACCESS=$(jq1 .data.access_token)

# ─── 1. Lazy-create smoke employee (idempotent on 409) ───────────────────────

echo ""
echo "── Lazy-create smoke employee (idempotent on 409) ─────────────"
ensure_user "$EMP_EMAIL" "$EMP_PASS" employee "Smoke Dashboard Analytics Emp" SMOKE-DA-001 "Engineer"
EMP_ACCESS=$(login_get_token "$EMP_EMAIL" "$EMP_PASS")
[[ -n "$EMP_ACCESS" && "$EMP_ACCESS" != "undefined" ]] \
    && pass=$((pass + 1)) \
    || { fail=$((fail + 1)); printf "  \e[31mFAIL\e[0m employee login\n"; }

# ─── 2. Admin: valid range → 200 + sections.kpi present ─────────────────────

echo ""
echo "── GET /dashboard/admin/analytics?range=month (admin) → 200 ──"
code=$(req GET '/dashboard/admin/analytics?range=month' '' "$ADMIN_ACCESS")
check "admin analytics 200" 200 "$code"
HAS_SECTIONS=$(jqx "typeof b.data.sections === 'object' && b.data.sections !== null")
check "data.sections is an object" "true" "$HAS_SECTIONS"
HAS_KPI=$(jqx "b.data.sections.kpi !== undefined")
check "data.sections.kpi present" "true" "$HAS_KPI"

# ─── 3. Admin: bogus range → 400 ─────────────────────────────────────────────

echo ""
echo "── GET /dashboard/admin/analytics?range=bogus (admin) → 400 ──"
code=$(req GET '/dashboard/admin/analytics?range=bogus' '' "$ADMIN_ACCESS")
check "bogus range 400" 400 "$code"

# ─── 4. Employee hitting admin scope → 403 ───────────────────────────────────

echo ""
echo "── GET /dashboard/admin/analytics (employee token) → 403 ─────"
code=$(req GET '/dashboard/admin/analytics' '' "$EMP_ACCESS")
check "employee on admin scope 403" 403 "$code"

# ─── 5. Employee hitting own scope → 200 ────────────────────────────────────

echo ""
echo "── GET /dashboard/employee/analytics (employee token) → 200 ──"
code=$(req GET '/dashboard/employee/analytics' '' "$EMP_ACCESS")
check "employee analytics 200" 200 "$code"

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Dashboard-analytics smoke summary: $pass passed, $fail failed"
echo "════════════════════════════════════════════════════════════════"
exit $fail
