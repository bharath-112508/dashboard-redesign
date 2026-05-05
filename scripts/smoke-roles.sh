#!/usr/bin/env bash
# End-to-end smoke test for the Step 47 RBAC surface.
#
# Covers:
#   - GET /roles (list, with optional ?is_system filter)
#   - GET /roles/:id
#   - POST /roles (custom-role creation + wildcard rejection + duplicate-key)
#   - PATCH /roles/:id (system-role display patch + admin-lockout prevention)
#   - DELETE /roles/:id (system-role refusal + in-use refusal + happy path)
#   - PATCH /users/:user_id/roles (assignment)
#   - PATCH /users/:user_id/extra-permissions (Pattern B + wildcard rejection)
#   - /auth/me reflects the resolved permission union after re-login
#
# Runs against a server already listening on http://localhost:3001.
# Reuses the seed admin (smoke@example.com) and lazily creates one
# employee target (smoke-emp-rbac@example.com) so we don't collide
# with the holiday/leaves smokes' user pool.
#
# Idempotent: every run picks a fresh role-key suffix so re-runs don't
# 409 on duplicate-key, and best-effort cleanup at start removes stale
# `smoke-rbac-*` rows from prior runs.
set -u

API=http://localhost:3001/api/v1
ADMIN_EMAIL=smoke@example.com
ADMIN_PASS='SmokeA@123!'

EMP_EMAIL=smoke-emp-rbac@example.com
EMP_PASS='SmokeERBAC@123!'

# Unique-per-run suffix on the custom-role key so re-runs don't collide
# with prior runs that didn't reach the cleanup step.
STAMP=$(date +%s)
CUSTOM_KEY="smoke-rbac-${STAMP}"

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

# ─── 1. Lazy-create employee target ──────────────────────────────────────

echo ""
echo "── Lazy-create smoke employee (idempotent on 409) ──────────────"
ensure_user "$EMP_EMAIL" "$EMP_PASS" employee "Smoke RBAC Employee" SMOKE-RBAC-001 "Engineer"
EMP_ACCESS=$(login_get_token "$EMP_EMAIL" "$EMP_PASS")
[[ -n "$EMP_ACCESS" && "$EMP_ACCESS" != "undefined" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m employee login\n"; }
EMP_ID=$(req GET /auth/me '' "$EMP_ACCESS" >/dev/null && jq1 .data.id)

# ─── 2. Cleanup stale smoke-rbac-* roles from prior runs ─────────────────

echo ""
echo "── Best-effort cleanup of stale smoke-rbac-* custom roles ─────"
req GET '/roles?is_system=false' '' "$ADMIN_ACCESS" >/dev/null
STALE_IDS=$(jqx "b.data.filter(r => /^smoke-rbac-/.test(r.key)).map(r => r.id).join(' ')")
if [[ -n "$STALE_IDS" ]]; then
    for id in $STALE_IDS; do
        req DELETE "/roles/$id" '' "$ADMIN_ACCESS" >/dev/null || true
    done
    echo "    deleted $(echo "$STALE_IDS" | wc -w | tr -d ' ') stale custom role(s)"
else
    echo "    nothing to clean up"
fi

# ─── 3. GET /roles — list every role ─────────────────────────────────────

echo ""
echo "── GET /roles → 200, includes the 5 system roles ──────────────"
code=$(req GET /roles '' "$ADMIN_ACCESS")
check "list 200" 200 "$code"
SYSTEM_COUNT=$(jqx "b.data.filter(r => r.is_system === true).length")
check "five system roles seeded" 5 "$SYSTEM_COUNT"
HAS_TEAM_LEAD=$(jqx "b.data.some(r => r.key === 'team_lead' && r.is_system)")
check "team_lead system role present" "true" "$HAS_TEAM_LEAD"

# Capture the manager + admin role ids for use below.
MANAGER_ROLE_ID=$(jqx "b.data.find(r => r.key === 'manager').id")
ADMIN_ROLE_ID=$(jqx "b.data.find(r => r.key === 'admin').id")
EMPLOYEE_ROLE_ID=$(jqx "b.data.find(r => r.key === 'employee').id")

# ─── 4. GET /roles?is_system=false ───────────────────────────────────────

echo ""
echo "── GET /roles?is_system=false → only customs (none yet) ──────"
code=$(req GET '/roles?is_system=false' '' "$ADMIN_ACCESS")
check "list filtered 200" 200 "$code"
ALL_NON_SYSTEM=$(jqx "b.data.every(r => r.is_system === false)")
check "every result is_system=false" "true" "$ALL_NON_SYSTEM"

# ─── 5. DELETE system role → 422 ROLE_IS_SYSTEM ──────────────────────────

echo ""
echo "── DELETE system role → 422 ROLE_IS_SYSTEM ────────────────────"
code=$(req DELETE "/roles/${MANAGER_ROLE_ID}" '' "$ADMIN_ACCESS")
check "delete-system 422" 422 "$code"
ERR_CODE=$(jq1 .error.code)
check "error code" "ROLE_IS_SYSTEM" "$ERR_CODE"

# ─── 6. PATCH Admin role to strip wildcard → 422 (lockout prevention) ────

echo ""
echo "── PATCH Admin role with permissions=[project.read] → 422 ─────"
code=$(req PATCH "/roles/${ADMIN_ROLE_ID}" "{\"permissions\":[\"project.read\"]}" "$ADMIN_ACCESS")
check "lockout 422" 422 "$code"
ERR_CODE=$(jq1 .error.code)
check "error code" "ROLE_INVALID_PERMISSIONS" "$ERR_CODE"

# ─── 7. PATCH Admin description → 200 (display-only patch is fine) ───────

echo ""
echo "── PATCH Admin description → 200 ──────────────────────────────"
code=$(req PATCH "/roles/${ADMIN_ROLE_ID}" "{\"description\":\"Smoke probe ${STAMP}\"}" "$ADMIN_ACCESS")
check "patch description 200" 200 "$code"

# ─── 8. POST /roles with system.admin wildcard → 422 ────────────────────

echo ""
echo "── POST /roles with system.admin wildcard → 422 ──────────────"
code=$(req POST /roles "{\"key\":\"${CUSTOM_KEY}-bad\",\"display_name\":\"Bad\",\"permissions\":[\"system.admin\"]}" "$ADMIN_ACCESS")
check "wildcard create 422" 422 "$code"
ERR_CODE=$(jq1 .error.code)
check "error code" "ROLE_INVALID_PERMISSIONS" "$ERR_CODE"

# ─── 9. POST /roles — valid custom role ─────────────────────────────────

echo ""
echo "── POST /roles → 201 ──────────────────────────────────────────"
code=$(req POST /roles "{\"key\":\"${CUSTOM_KEY}\",\"display_name\":\"Smoke RBAC ${STAMP}\",\"description\":\"Smoke role\",\"permissions\":[\"project.read\",\"task.read\"]}" "$ADMIN_ACCESS")
check "create 201" 201 "$code"
CUSTOM_ROLE_ID=$(jq1 .data.id)
IS_SYSTEM=$(jq1 .data.is_system)
check "created with is_system=false" "false" "$IS_SYSTEM"
PERM_COUNT=$(jqx "b.data.permissions.length")
check "two permissions stored" 2 "$PERM_COUNT"

# ─── 10. POST duplicate key → 409 DUPLICATE_RESOURCE ───────────────────

echo ""
echo "── POST /roles with same key → 409 ───────────────────────────"
code=$(req POST /roles "{\"key\":\"${CUSTOM_KEY}\",\"display_name\":\"Dup\",\"permissions\":[\"task.read\"]}" "$ADMIN_ACCESS")
check "duplicate 409" 409 "$code"
ERR_CODE=$(jq1 .error.code)
check "error code" "DUPLICATE_RESOURCE" "$ERR_CODE"

# ─── 11. PATCH custom role → 200 ────────────────────────────────────────

echo ""
echo "── PATCH /roles/:id → 200 ────────────────────────────────────"
code=$(req PATCH "/roles/${CUSTOM_ROLE_ID}" '{"display_name":"Smoke RBAC (renamed)","permissions":["project.read","task.read","task.write"]}' "$ADMIN_ACCESS")
check "patch 200" 200 "$code"
NEW_PERM_COUNT=$(jqx "b.data.permissions.length")
check "now has 3 permissions" 3 "$NEW_PERM_COUNT"

# ─── 12. Assign custom role to employee → 200 ─────────────────────────

echo ""
echo "── PATCH /users/:user_id/roles → 200 ──────────────────────────"
code=$(req PATCH "/users/${EMP_ID}/roles" "{\"role_ids\":[\"${CUSTOM_ROLE_ID}\"]}" "$ADMIN_ACCESS")
check "assign 200" 200 "$code"

# ─── 13. DELETE custom role while assigned → 422 ROLE_IN_USE ─────────

echo ""
echo "── DELETE assigned custom role → 422 ROLE_IN_USE ─────────────"
code=$(req DELETE "/roles/${CUSTOM_ROLE_ID}" '' "$ADMIN_ACCESS")
check "in-use 422" 422 "$code"
ERR_CODE=$(jq1 .error.code)
check "error code" "ROLE_IN_USE" "$ERR_CODE"

# ─── 14. Reassign employee to a system role + delete → 204 ─────────

echo ""
echo "── Reassign employee to manager system role ──────────────────"
code=$(req PATCH "/users/${EMP_ID}/roles" "{\"role_ids\":[\"${EMPLOYEE_ROLE_ID}\"]}" "$ADMIN_ACCESS")
check "reassign 200" 200 "$code"

echo ""
echo "── DELETE custom role → 204 ──────────────────────────────────"
code=$(req DELETE "/roles/${CUSTOM_ROLE_ID}" '' "$ADMIN_ACCESS")
check "delete 204" 204 "$code"

# Verify it's gone.
code=$(req GET "/roles/${CUSTOM_ROLE_ID}" '' "$ADMIN_ACCESS")
check "now 404" 404 "$code"
ERR_CODE=$(jq1 .error.code)
check "error code" "ROLE_NOT_FOUND" "$ERR_CODE"

# ─── 15. Pattern B — PATCH extras with wildcard → 422 ─────────────────

echo ""
echo "── PATCH /users/:user_id/extra-permissions wildcard → 422 ────"
code=$(req PATCH "/users/${EMP_ID}/extra-permissions" '{"extra_permissions":["system.admin"]}' "$ADMIN_ACCESS")
check "wildcard 422" 422 "$code"
ERR_CODE=$(jq1 .error.code)
check "error code" "ROLE_INVALID_PERMISSIONS" "$ERR_CODE"

# ─── 16. Pattern B — happy path + verify via /auth/me ─────────────────

echo ""
echo "── PATCH extras = [report.read, audit_log.read] → 200 ────────"
code=$(req PATCH "/users/${EMP_ID}/extra-permissions" '{"extra_permissions":["report.read","audit_log.read"]}' "$ADMIN_ACCESS")
check "extras 200" 200 "$code"

# Re-login the employee so the JWT picks up the new permission set.
EMP_ACCESS=$(login_get_token "$EMP_EMAIL" "$EMP_PASS")

echo ""
echo "── /auth/me reflects the union (role + extra perms) ──────────"
code=$(req GET /auth/me '' "$EMP_ACCESS")
check "/auth/me 200" 200 "$code"
HAS_REPORT_READ=$(jqx "Array.isArray(b.data.permissions) && b.data.permissions.includes('report.read')")
check "report.read present (Pattern B)" "true" "$HAS_REPORT_READ"
HAS_PROJECT_READ=$(jqx "b.data.permissions.includes('project.read')")
check "project.read present (from employee role)" "true" "$HAS_PROJECT_READ"

# ─── 17. Clear extras + re-verify ─────────────────────────────────────

echo ""
echo "── Clear extras (PATCH with []) → 200 ────────────────────────"
code=$(req PATCH "/users/${EMP_ID}/extra-permissions" '{"extra_permissions":[]}' "$ADMIN_ACCESS")
check "clear 200" 200 "$code"

EMP_ACCESS=$(login_get_token "$EMP_EMAIL" "$EMP_PASS")
req GET /auth/me '' "$EMP_ACCESS" >/dev/null
HAS_REPORT_READ=$(jqx "b.data.permissions.includes('report.read')")
check "report.read gone after clear" "false" "$HAS_REPORT_READ"

# ─── 18. Non-admin cannot hit /roles ──────────────────────────────────

echo ""
echo "── GET /roles as employee → 403 ──────────────────────────────"
code=$(req GET /roles '' "$EMP_ACCESS")
check "non-admin forbidden" 403 "$code"

# ─── Summary ─────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Roles smoke summary: $pass passed, $fail failed"
echo "════════════════════════════════════════════════════════════════"
exit $fail
