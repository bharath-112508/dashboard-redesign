#!/usr/bin/env bash
# End-to-end smoke test for the Step 49 unified command-palette surface.
#
# Single endpoint: GET /command-palette[?q=...] returns
#   { data: { actions: [...], items: { users, projects, sprints, tasks } } }
#
# Covers:
#   - Unauthenticated → 401
#   - Admin (no q): full action catalog + EMPTY items (no Mongo hit)
#   - Employee (no q): strict subset of actions + empty items
#   - Admin (q < SEARCH_MIN_QUERY_LENGTH=2): actions filtered, items still empty
#   - Admin (q ≥ 2): actions + items fetched in parallel
#   - Validator rejects empty q (per `min(1)`)
#   - No-match query: empty actions + empty items, NOT 404
set -u

API=http://localhost:3001/api/v1
ADMIN_EMAIL=smoke@example.com
ADMIN_PASS='SmokeA@123!'

EMP_EMAIL=smoke-emp-cmd@example.com
EMP_PASS='SmokeECMD@123!'

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
ensure_user "$EMP_EMAIL" "$EMP_PASS" employee "Smoke CmdK Employee" SMOKE-CMDK-001 "Engineer"
EMP_ACCESS=$(login_get_token "$EMP_EMAIL" "$EMP_PASS")
[[ -n "$EMP_ACCESS" && "$EMP_ACCESS" != "undefined" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m employee login\n"; }

# ─── 2. Unauthenticated → 401 ────────────────────────────────────────────

echo ""
echo "── GET /command-palette (no token) → 401 ──────────────────────"
code=$(req GET /command-palette '' '')
check "unauthenticated 401" 401 "$code"

# ─── 3. Admin no-q → full actions + empty items ──────────────────────────

echo ""
echo "── GET /command-palette (admin, no q) → 200 + full actions, empty items ─"
code=$(req GET /command-palette '' "$ADMIN_ACCESS")
check "admin no-q 200" 200 "$code"
HAS_ACTIONS=$(jqx "Array.isArray(b.data.actions)")
check "actions array present" "true" "$HAS_ACTIONS"
HAS_ITEMS=$(jqx "b.data.items && typeof b.data.items === 'object'")
check "items object present" "true" "$HAS_ITEMS"
ADMIN_ACTIONS_COUNT=$(jqx "b.data.actions.length")
HAS_USER_CREATE=$(jqx "b.data.actions.some(a => a.key === 'user.create')")
check "user.create present (admin-gated)" "true" "$HAS_USER_CREATE"
HAS_ROLE_CREATE=$(jqx "b.data.actions.some(a => a.key === 'role.create')")
check "role.create present (admin-gated)" "true" "$HAS_ROLE_CREATE"
ITEMS_EMPTY=$(jqx "b.data.items.users.length===0 && b.data.items.projects.length===0 && b.data.items.sprints.length===0 && b.data.items.tasks.length===0")
check "items empty (no q, no DB hit)" "true" "$ITEMS_EMPTY"

# ─── 4. Employee no-q → strict subset of actions ─────────────────────────

echo ""
echo "── GET /command-palette (employee, no q) → strict subset ─────"
code=$(req GET /command-palette '' "$EMP_ACCESS")
check "emp no-q 200" 200 "$code"
EMP_ACTIONS_COUNT=$(jqx "b.data.actions.length")
EMP_HAS_USER_CREATE=$(jqx "b.data.actions.some(a => a.key === 'user.create')")
check "user.create hidden from employee" "false" "$EMP_HAS_USER_CREATE"
EMP_HAS_LEAVE_APPLY=$(jqx "b.data.actions.some(a => a.key === 'leave_request.apply')")
check "leave_request.apply visible (employee perm)" "true" "$EMP_HAS_LEAVE_APPLY"
EMP_HAS_NAV=$(jqx "b.data.actions.some(a => a.key === 'nav.dashboard')")
check "navigation visible to employee" "true" "$EMP_HAS_NAV"

echo "  admin actions: $ADMIN_ACTIONS_COUNT; employee actions: $EMP_ACTIONS_COUNT"
if [[ "$EMP_ACTIONS_COUNT" -lt "$ADMIN_ACTIONS_COUNT" ]]; then
    printf "  \e[32mPASS\e[0m employee count is a strict subset\n"
    pass=$((pass + 1))
else
    printf "  \e[31mFAIL\e[0m employee count should be < admin count\n"
    fail=$((fail + 1))
fi

# ─── 5. q below SEARCH_MIN_QUERY_LENGTH (1 char) → actions filtered, items empty ─

echo ""
echo "── GET /command-palette?q=a (admin, 1 char) → actions filtered, items empty ─"
code=$(req GET '/command-palette?q=a' '' "$ADMIN_ACCESS")
check "1-char q 200" 200 "$code"
ITEMS_EMPTY=$(jqx "b.data.items.users.length===0 && b.data.items.projects.length===0 && b.data.items.sprints.length===0 && b.data.items.tasks.length===0")
check "items empty (q < min)" "true" "$ITEMS_EMPTY"
ACTIONS_FILTERED=$(jqx "b.data.actions.length > 0 && b.data.actions.length < $ADMIN_ACTIONS_COUNT")
check "actions filtered by q" "true" "$ACTIONS_FILTERED"

# ─── 6. q ≥ min (2+ chars) → actions + items both populated ──────────────

echo ""
echo "── GET /command-palette?q=ad (admin, 2+ chars) → actions + items ─"
code=$(req GET '/command-palette?q=ad' '' "$ADMIN_ACCESS")
check "2-char q 200" 200 "$code"
HAS_USERS_BUCKET=$(jqx "Array.isArray(b.data.items.users)")
check "users bucket present" "true" "$HAS_USERS_BUCKET"
HAS_PROJECTS_BUCKET=$(jqx "Array.isArray(b.data.items.projects)")
check "projects bucket present" "true" "$HAS_PROJECTS_BUCKET"
HAS_SPRINTS_BUCKET=$(jqx "Array.isArray(b.data.items.sprints)")
check "sprints bucket present" "true" "$HAS_SPRINTS_BUCKET"
HAS_TASKS_BUCKET=$(jqx "Array.isArray(b.data.items.tasks)")
check "tasks bucket present" "true" "$HAS_TASKS_BUCKET"
# Likely to find the smoke admin in the users bucket since admin's
# full_name/email contains 'ad'.
HAS_ADMIN_USER=$(jqx "b.data.items.users.length > 0")
check "admin user surfaced in items.users" "true" "$HAS_ADMIN_USER"

# ─── 7. Validator: empty q → 400 ─────────────────────────────────────────

echo ""
echo "── GET /command-palette?q= → 400 ──────────────────────────────"
code=$(req GET '/command-palette?q=' '' "$ADMIN_ACCESS")
check "empty q 400" 400 "$code"

# ─── 8. Substring filter on label + keywords ───────────────────────────

echo ""
echo "── GET /command-palette?q=new (admin) → keyword match ────────"
code=$(req GET '/command-palette?q=new' '' "$ADMIN_ACCESS")
check "filter 200" 200 "$code"
HAS_PROJECT_CREATE=$(jqx "b.data.actions.some(a => a.key === 'project.create')")
check "project.create surfaces (label/keyword 'new')" "true" "$HAS_PROJECT_CREATE"

# ─── 9. No-match → empty actions + empty items, 200 not 404 ────────────

echo ""
echo "── GET /command-palette?q=zzznotreal → 200 + empty buckets ───"
code=$(req GET '/command-palette?q=zzznotreal' '' "$ADMIN_ACCESS")
check "no-match 200" 200 "$code"
NO_ACTIONS=$(jqx "b.data.actions.length === 0")
check "actions empty" "true" "$NO_ACTIONS"

# ─── Summary ─────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Command-palette smoke summary: $pass passed, $fail failed"
echo "════════════════════════════════════════════════════════════════"
exit $fail
