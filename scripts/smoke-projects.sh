#!/usr/bin/env bash
# End-to-end smoke test for Phase-2 project surfaces — Step 26 exit criterion.
#
# Covers the create + read flow for:
#   - /projects        (Step 16) — admin creates a project, adds members + clients.
#   - /sprints         (Step 16) — manager creates a sprint under the project.
#   - /stories         (Step 17) — manager creates a story.
#   - /tasks           (Step 18) — manager creates a task; story-board list returns it.
#   - /tasks/:id/comments (Step 19) — comment authoring.
#
# AND the Step-26 security exit criterion:
#   "Client `@mention` scoping automated tests (no cross-project leakage)"
#
# Cross-project mention scenarios exercised:
#   1. Project A has client_alice + employee_bob.
#      Project B has client_carol + employee_dave.
#      → client_alice posting on project A and mentioning employee_bob succeeds.
#      → client_alice posting on project A and mentioning employee_dave (project B)
#        is rejected with 422 MENTION_NOT_PROJECT_MEMBER.
#      → client_carol on project B mentioning employee_bob is rejected too
#        (symmetric — confirms it's not a project-A-specific guard).
#
# Strategy:
#   - Lazy-creates smoke users via admin POST /users so this runs standalone
#     after `smoke-reset-users.ts` + `smoke-seed-user.ts`.
#   - Cleans up the test projects on entry AND exit so the suite is
#     re-runnable in the same Mongo without leftover rows from previous runs.
set -u

# Hard dependency check: every assertion + body builder uses `jq`. Without
# it, the script's failures are cryptic empty-string captures rather than
# a clean "missing tool" message. Fail loud + early.
if ! command -v jq >/dev/null 2>&1; then
    printf "\e[31mERROR\e[0m: jq is required but not installed (brew install jq, or apt install jq).\n" >&2
    exit 2
fi

API=http://localhost:3001/api/v1

ADMIN_EMAIL=smoke@example.com
ADMIN_PASS='SmokeA@123!'

MGR_EMAIL=smoke-mgr@example.com
MGR_PASS='SmokeM@123!'

EMP_BOB_EMAIL=smoke-bob@example.com
EMP_BOB_PASS='SmokeB@123!'

EMP_DAVE_EMAIL=smoke-dave@example.com
EMP_DAVE_PASS='SmokeD@123!'

CLIENT_ALICE_EMAIL=smoke-alice@example.com
CLIENT_ALICE_PASS='SmokeAl@123!'

CLIENT_CAROL_EMAIL=smoke-carol@example.com
CLIENT_CAROL_PASS='SmokeC@123!'

PROJECT_A_CODE=SMK-PROJ-A
PROJECT_B_CODE=SMK-PROJ-B

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

check_code() {
    local name=$1 expected_code=$2
    local got
    got=$(jq -r '.error.code // empty' /tmp/sm.json 2>/dev/null)
    if [[ "$got" == "$expected_code" ]]; then
        printf "  \e[32mPASS\e[0m %s (%s)\n" "$name" "$got"
        pass=$((pass + 1))
    else
        printf "  \e[31mFAIL\e[0m %s (expected %s, got %s)\n" "$name" "$expected_code" "$got"
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

extract_id() {
    jq -r '.data.id // .data._id // empty' /tmp/sm.json
}

login_or_die() {
    local email=$1 pass=$2
    local code
    code=$(req POST /auth/login "{\"email\":\"$email\",\"password\":\"$pass\"}" "")
    if [[ "$code" != "200" ]]; then
        printf "  \e[31mFAIL\e[0m login failed for %s (status %s)\n" "$email" "$code"
        fail=$((fail + 1))
        echo ""
        return 1
    fi
    jq -r '.data.access_token // empty' /tmp/sm.json
}

# Lazy-create a smoke user via admin POST /users. Idempotent:
# 409 EMAIL_ALREADY_EXISTS is treated as success.
ensure_user() {
    local admin_token=$1 email=$2 password=$3 full_name=$4 role=$5
    local body
    if [[ "$role" == "client" ]]; then
        body=$(jq -nc \
            --arg email "$email" \
            --arg password "$password" \
            --arg name "$full_name" \
            --arg role "$role" \
            '{email: $email, initial_password: $password, full_name: $name, role: $role,
              client_profile: {company_name: "Smoke Co", access_type: "login"}}')
    else
        local emp_id="EMP-$(printf '%s' "$email" | shasum | cut -c1-6 | tr 'a-z' 'A-Z')"
        body=$(jq -nc \
            --arg email "$email" \
            --arg password "$password" \
            --arg name "$full_name" \
            --arg role "$role" \
            --arg eid "$emp_id" \
            '{email: $email, initial_password: $password, full_name: $name, role: $role,
              internal_profile: {employee_id: $eid, job_title: "Smoke", department: "Smoke",
                                 date_of_joining: "2024-01-01"}}')
    fi
    local code
    code=$(req POST /users "$body" "$admin_token")
    if [[ "$code" == "201" || "$code" == "200" ]]; then
        return 0
    fi
    if [[ "$code" == "409" ]]; then
        # Already exists — that's the idempotent path.
        return 0
    fi
    printf "  \e[31mFAIL\e[0m ensure_user %s status %s\n" "$email" "$code"
    fail=$((fail + 1))
    return 1
}

# Look up a user_id by email via admin GET /users?q=…
user_id_by_email() {
    local admin_token=$1 email=$2
    req GET "/users?q=$email&limit=10" '' "$admin_token" >/dev/null
    jq -r --arg email "$email" '.data[] | select(.email == $email) | .id' /tmp/sm.json | head -1
}

# Hard-delete a smoke project + cascading children, by code. Tolerates 404.
cleanup_project() {
    local admin_token=$1 code=$2
    req GET "/projects?q=$code&limit=10" '' "$admin_token" >/dev/null
    local pid
    pid=$(jq -r --arg code "$code" '.data[] | select(.code == $code) | .id' /tmp/sm.json | head -1)
    if [[ -n "$pid" ]]; then
        req DELETE "/projects/$pid" '' "$admin_token" >/dev/null
    fi
}

echo "── Auth smoke admin ──────────────────────────────────────────────"
ADMIN_TOKEN=$(login_or_die "$ADMIN_EMAIL" "$ADMIN_PASS") || exit 2

echo ""
echo "── Lazy-create smoke users ───────────────────────────────────────"
ensure_user "$ADMIN_TOKEN" "$MGR_EMAIL"          "$MGR_PASS"          "Smoke Manager" manager
ensure_user "$ADMIN_TOKEN" "$EMP_BOB_EMAIL"      "$EMP_BOB_PASS"      "Bob Employee"   employee
ensure_user "$ADMIN_TOKEN" "$EMP_DAVE_EMAIL"     "$EMP_DAVE_PASS"     "Dave Employee"  employee
ensure_user "$ADMIN_TOKEN" "$CLIENT_ALICE_EMAIL" "$CLIENT_ALICE_PASS" "Alice Client"   client
ensure_user "$ADMIN_TOKEN" "$CLIENT_CAROL_EMAIL" "$CLIENT_CAROL_PASS" "Carol Client"   client

MGR_TOKEN=$(login_or_die "$MGR_EMAIL" "$MGR_PASS") || exit 2
ALICE_TOKEN=$(login_or_die "$CLIENT_ALICE_EMAIL" "$CLIENT_ALICE_PASS") || exit 2
CAROL_TOKEN=$(login_or_die "$CLIENT_CAROL_EMAIL" "$CLIENT_CAROL_PASS") || exit 2

BOB_ID=$(user_id_by_email "$ADMIN_TOKEN" "$EMP_BOB_EMAIL")
DAVE_ID=$(user_id_by_email "$ADMIN_TOKEN" "$EMP_DAVE_EMAIL")
ALICE_ID=$(user_id_by_email "$ADMIN_TOKEN" "$CLIENT_ALICE_EMAIL")
CAROL_ID=$(user_id_by_email "$ADMIN_TOKEN" "$CLIENT_CAROL_EMAIL")
MGR_ID=$(user_id_by_email "$ADMIN_TOKEN" "$MGR_EMAIL")

if [[ -z "$BOB_ID" || -z "$DAVE_ID" || -z "$ALICE_ID" || -z "$CAROL_ID" || -z "$MGR_ID" ]]; then
    printf "  \e[31mFAIL\e[0m could not resolve all user ids — bailing\n"
    exit 2
fi

echo ""
echo "── Cleanup any leftover smoke projects ──────────────────────────"
cleanup_project "$ADMIN_TOKEN" "$PROJECT_A_CODE"
cleanup_project "$ADMIN_TOKEN" "$PROJECT_B_CODE"

# ─── Step 16: project create (admin) ──────────────────────────────────────

echo ""
echo "── Step 16: create project A (admin) ────────────────────────────"
body=$(jq -nc \
    --arg code "$PROJECT_A_CODE" \
    --arg mgr "$MGR_ID" \
    --arg bob "$BOB_ID" \
    --arg alice "$ALICE_ID" \
    '{name: "Smoke project A", code: $code, description: "smk-A",
      start_date: "2026-01-01", end_date: null, status: "active",
      member_ids: [$mgr, $bob], client_ids: [$alice], custom_task_statuses: []}')
status=$(req POST /projects "$body" "$ADMIN_TOKEN")
check "POST /projects (project A) → 201" 201 "$status"
PROJECT_A_ID=$(extract_id)

echo ""
echo "── Step 16: create project B (admin) ────────────────────────────"
body=$(jq -nc \
    --arg code "$PROJECT_B_CODE" \
    --arg mgr "$MGR_ID" \
    --arg dave "$DAVE_ID" \
    --arg carol "$CAROL_ID" \
    '{name: "Smoke project B", code: $code, description: "smk-B",
      start_date: "2026-01-01", end_date: null, status: "active",
      member_ids: [$mgr, $dave], client_ids: [$carol], custom_task_statuses: []}')
status=$(req POST /projects "$body" "$ADMIN_TOKEN")
check "POST /projects (project B) → 201" 201 "$status"
PROJECT_B_ID=$(extract_id)

# ─── Step 16/17: sprint + story under project A (manager) ─────────────────

echo ""
echo "── Step 16: create sprint under project A (manager) ─────────────"
body=$(jq -nc --arg pid "$PROJECT_A_ID" \
    '{project_id: $pid, name: "S1", start_date: "2026-01-01", end_date: "2026-01-14", status: "active"}')
status=$(req POST /sprints "$body" "$MGR_TOKEN")
check "POST /sprints → 201" 201 "$status"
SPRINT_A_ID=$(extract_id)

echo ""
echo "── Step 17: create story under project A (manager) ──────────────"
body=$(jq -nc --arg pid "$PROJECT_A_ID" \
    '{project_id: $pid, title: "Smoke story", description: "the kanban swimlane"}')
status=$(req POST /stories "$body" "$MGR_TOKEN")
check "POST /stories → 201" 201 "$status"
STORY_A_ID=$(extract_id)

# ─── Step 18: task create + story-board list ──────────────────────────────

echo ""
echo "── Step 18: create task in project A (manager) ──────────────────"
# `due_date` is required by the task validator (Data_Model §5.4 — Tasks
# always carry a target date). The smoke uses a far-future ISO date so
# the row is unambiguously "active" relative to any real-world today.
body=$(jq -nc \
    --arg pid "$PROJECT_A_ID" \
    --arg sprint "$SPRINT_A_ID" \
    --arg story "$STORY_A_ID" \
    '{project_id: $pid, sprint_id: $sprint, story_id: $story,
      title: "Smoke task #1", description: "", status: "to_do", priority: "medium",
      due_date: "2099-12-31"}')
status=$(req POST /tasks "$body" "$MGR_TOKEN")
check "POST /tasks → 201" 201 "$status"
TASK_A_ID=$(extract_id)

echo ""
echo "── Step 18: GET /tasks?project_id=A returns the task ────────────"
status=$(req GET "/tasks?project_id=$PROJECT_A_ID&limit=20" '' "$MGR_TOKEN")
check "GET /tasks?project_id=A → 200" 200 "$status"
count=$(jq '.data | length' /tmp/sm.json)
check "story-board list count >= 1" "true" "$([[ $count -ge 1 ]] && echo true || echo false)"

# ─── Step 19: comment + the cross-project mention scoping (Step-26 gate) ──

echo ""
echo "── Step 19/26: client Alice mentions Bob (same project) → 201 ────"
body=$(jq -nc --arg bob "$BOB_ID" \
    '{body: "hi @bob can you take this", mentioned_user_ids: [$bob]}')
status=$(req POST "/tasks/$TASK_A_ID/comments" "$body" "$ALICE_TOKEN")
check "POST /tasks/:id/comments (alice → bob, same proj) → 201" 201 "$status"

echo ""
echo "── Step 26 EXIT GATE: client Alice mentions Dave (project B!) ────"
echo "    Expected: 422 MENTION_NOT_PROJECT_MEMBER (no cross-project leakage)."
body=$(jq -nc --arg dave "$DAVE_ID" \
    '{body: "secret @dave question", mentioned_user_ids: [$dave]}')
status=$(req POST "/tasks/$TASK_A_ID/comments" "$body" "$ALICE_TOKEN")
check "POST /tasks/:id/comments cross-project mention → 422" 422 "$status"
check_code "  error code is MENTION_NOT_PROJECT_MEMBER" "MENTION_NOT_PROJECT_MEMBER"

echo ""
echo "── Step 26 SYMMETRIC: Carol on project B can't mention Bob ──────"
echo "    Confirms the gate is symmetric, not just project-A-specific."
# Carol needs a task in project B — let her project's manager create one.
body=$(jq -nc --arg pid "$PROJECT_B_ID" \
    '{project_id: $pid, title: "Project B task", description: "", status: "to_do", priority: "medium",
      due_date: "2099-12-31"}')
req POST /tasks "$body" "$MGR_TOKEN" >/dev/null
TASK_B_ID=$(extract_id)

body=$(jq -nc --arg bob "$BOB_ID" \
    '{body: "leak attempt @bob", mentioned_user_ids: [$bob]}')
status=$(req POST "/tasks/$TASK_B_ID/comments" "$body" "$CAROL_TOKEN")
check "POST /tasks/:id/comments carol-mentioning-bob → 422" 422 "$status"
check_code "  error code is MENTION_NOT_PROJECT_MEMBER" "MENTION_NOT_PROJECT_MEMBER"

echo ""
echo "── Cleanup ──────────────────────────────────────────────────────"
cleanup_project "$ADMIN_TOKEN" "$PROJECT_A_CODE"
cleanup_project "$ADMIN_TOKEN" "$PROJECT_B_CODE"

echo ""
echo "════════════════════════════════════════════════════════════════"
printf "  \e[1m%d passed · %d failed\e[0m\n" "$pass" "$fail"
echo "════════════════════════════════════════════════════════════════"

exit "$fail"
