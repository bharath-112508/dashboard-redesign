#!/usr/bin/env bash
# End-to-end smoke test for Notifications (Step 11).
#
# Covers the five endpoints from API_Contract §11:
#   - GET    /notifications              (list, filters, pagination)
#   - GET    /notifications/unread-count (badge)
#   - POST   /notifications/:id/read     (mark single, idempotent)
#   - POST   /notifications/read-all     (bulk mark)
#   - DELETE /notifications/:id          (dismiss)
#
# Plus the dispatch hookups from §11.6:
#   - Submitting a leave fans `leave_requested` to admin + manager,
#     excluding the requester.
#   - Approving fans `leave_approved` only to the requester.
#   - Cancelling (by self) fans `leave_cancelled` to the reviewer pool.
#
# And the cross-cutting RBAC contract:
#   - Owner-scoped: another user can't read/dismiss someone else's row.
#   - Unauth requests get 401, not 403, on every endpoint.
#   - Validators reject bad query/param shapes with 400.
#
# Strategy:
#   - Lazy-creates manager + employee + employee2 (idempotent on 409).
#   - Wipes all notifications + leave_requests for smoke users at start
#     so the assertions about exact counts hold across reruns.
#   - Cancels every leave it creates at the end so the suite is rerunnable
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

# Generic boolean assert — gives clearer failure messages than `check 1` for
# numeric / inequality checks.
assert_true() {
    local name=$1 cond=$2
    if [[ "$cond" == "true" || "$cond" == "1" ]]; then
        printf "  \e[32mPASS\e[0m %s\n" "$name"
        pass=$((pass + 1))
    else
        printf "  \e[31mFAIL\e[0m %s (got %s)\n" "$name" "$cond"
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

next_weekday() {
    node -e "
        const d=process.argv[1], target=parseInt(process.argv[2],10);
        const dt=new Date(d+'T00:00:00Z');
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

# Brief sleep so the dispatcher (best-effort, off the request thread) has
# time to write the in-app rows before we start asserting on them.
let_dispatch_settle() {
    sleep 0.4
}

# ── 0. Prep: wipe stale notifications + leaves so counts are deterministic ─
#
# Without this, a previous run's leftover notifications would inflate
# unread-count and pollute the type-filtered list.

echo "── Prep: clear stale notifications + leaves ────────────────────"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
( cd "$SCRIPT_DIR/.." && npx tsx scripts/smoke-notifications-prep.ts ) || {
    printf "  \e[31mFAIL\e[0m smoke-notifications-prep.ts (continuing — counts may be off)\n"
    fail=$((fail + 1))
}

# ── 1. Login as admin ────────────────────────────────────────────────────

echo ""
echo "── Login as admin ──────────────────────────────────────────────"
code=$(req POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
check "admin login 200" 200 "$code"
ADMIN_ACCESS=$(jq1 .data.access_token)
ADMIN_ID=$(jq1 .data.user.id)

# ── 2. Lazy-create supporting users ─────────────────────────────────────

echo ""
echo "── Lazy-create smoke users (idempotent on 409) ─────────────────"
ensure_user "$MGR_EMAIL"  "$MGR_PASS"  manager  "Smoke Manager"     SMOKE-NTF-MGR-001 "Engineering Manager"
ensure_user "$EMP_EMAIL"  "$EMP_PASS"  employee "Smoke Employee"    SMOKE-NTF-EMP-001 "Engineer"
ensure_user "$EMP2_EMAIL" "$EMP2_PASS" employee "Smoke Employee 2"  SMOKE-NTF-EMP-002 "Engineer"

MGR_ACCESS=$(login_get_token "$MGR_EMAIL"  "$MGR_PASS")
EMP_ACCESS=$(login_get_token "$EMP_EMAIL"  "$EMP_PASS")
EMP2_ACCESS=$(login_get_token "$EMP2_EMAIL" "$EMP2_PASS")
[[ -n "$MGR_ACCESS"  && "$MGR_ACCESS"  != "undefined" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m manager login\n"; }
[[ -n "$EMP_ACCESS"  && "$EMP_ACCESS"  != "undefined" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m employee login\n"; }
[[ -n "$EMP2_ACCESS" && "$EMP2_ACCESS" != "undefined" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m employee2 login\n"; }

req POST /auth/login "{\"email\":\"$EMP_EMAIL\",\"password\":\"$EMP_PASS\"}" >/dev/null
EMP_ID=$(jq1 .data.user.id)
req POST /auth/login "{\"email\":\"$MGR_EMAIL\",\"password\":\"$MGR_PASS\"}" >/dev/null
MGR_ID=$(jq1 .data.user.id)

echo "    EMP_ID=$EMP_ID MGR_ID=$MGR_ID ADMIN_ID=$ADMIN_ID"

# Re-wipe any notifications that the lazy-create above just generated for
# the freshly-invited users — we want a known-empty starting state.
( cd "$SCRIPT_DIR/.." && npx tsx scripts/smoke-notifications-prep.ts >/dev/null ) || true

# ── 3. Resolve a usable leave type so the dispatch hooks fire ───────────

echo ""
echo "── Lookup CL leave type ────────────────────────────────────────"
code=$(req GET /leave-types '' "$ADMIN_ACCESS")
check "leave-types 200" 200 "$code"
CL_ID=$(jqx "(b.data.find(t => t.code==='CL')||{}).id")
[[ -n "$CL_ID" && "$CL_ID" != "undefined" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m CL seed missing\n"; }

# ── 4. Baseline: every smoke user starts at 0 unread ────────────────────

echo ""
echo "── Baseline unread counts ──────────────────────────────────────"
req GET /notifications/unread-count '' "$EMP_ACCESS" >/dev/null
EMP_BASE=$(jq1 .data.count)
check "emp base unread = 0" "0" "$EMP_BASE"
req GET /notifications/unread-count '' "$MGR_ACCESS" >/dev/null
MGR_BASE=$(jq1 .data.count)
check "mgr base unread = 0" "0" "$MGR_BASE"
req GET /notifications/unread-count '' "$ADMIN_ACCESS" >/dev/null
ADMIN_BASE=$(jq1 .data.count)
check "admin base unread = 0" "0" "$ADMIN_BASE"

# ── 5. Dispatch hookup: leave_requested → admin + manager get notified ──

TODAY=$(today_iso)
CL_OK=$(next_weekday "$(add_days "$TODAY" 21)" 1)   # First Monday ≥ today+21
CL_OK_END=$(add_days "$CL_OK" 0)                    # Single day to keep it simple
APPLY_BODY="{\"leave_type_id\":\"$CL_ID\",\"start_date\":\"$CL_OK\",\"end_date\":\"$CL_OK_END\",\"reason\":\"smoke notif dispatch\"}"

echo ""
echo "── Employee submits a leave (triggers leave_requested fan-out) ─"
code=$(req POST /leaves "$APPLY_BODY" "$EMP_ACCESS")
check "apply 201" 201 "$code"
LEAVE_ID=$(jq1 .data.id)
let_dispatch_settle

# Manager + admin should both see exactly one new unread `leave_requested`.
req GET /notifications/unread-count '' "$MGR_ACCESS" >/dev/null
MGR_AFTER_APPLY=$(jq1 .data.count)
check "mgr unread after apply = 1" "1" "$MGR_AFTER_APPLY"
req GET /notifications/unread-count '' "$ADMIN_ACCESS" >/dev/null
ADMIN_AFTER_APPLY=$(jq1 .data.count)
check "admin unread after apply = 1" "1" "$ADMIN_AFTER_APPLY"

# Requester (employee) should NOT receive a notification for their own action.
req GET /notifications/unread-count '' "$EMP_ACCESS" >/dev/null
EMP_AFTER_APPLY=$(jq1 .data.count)
check "emp unread unchanged after own apply = 0" "0" "$EMP_AFTER_APPLY"

# Verify the manager's notification is shaped correctly.
req GET '/notifications?type=leave_requested' '' "$MGR_ACCESS" >/dev/null
MGR_NOTIF_ID=$(jqx "(b.data[0]||{}).id")
MGR_NOTIF_TYPE=$(jqx "(b.data[0]||{}).type")
MGR_NOTIF_LINK=$(jqx "(b.data[0]||{}).link_url")
MGR_NOTIF_KIND=$(jqx "((b.data[0]||{}).related_entity||{}).kind")
MGR_NOTIF_REL_ID=$(jqx "((b.data[0]||{}).related_entity||{}).id")
MGR_NOTIF_USER_ID=$(jqx "(b.data[0]||{}).user_id")
MGR_NOTIF_READ=$(jqx "(b.data[0]||{}).is_read")
check "mgr notif type = leave_requested"               "leave_requested"               "$MGR_NOTIF_TYPE"
check "mgr notif link_url points at leave"             "/leaves/$LEAVE_ID"             "$MGR_NOTIF_LINK"
check "mgr notif related_entity.kind"                  "leave_request"                 "$MGR_NOTIF_KIND"
check "mgr notif related_entity.id = leave id"         "$LEAVE_ID"                     "$MGR_NOTIF_REL_ID"
check "mgr notif owned by manager (user_id)"           "$MGR_ID"                       "$MGR_NOTIF_USER_ID"
check "mgr notif initial is_read=false"                "false"                         "$MGR_NOTIF_READ"

# ── 6. Dispatch hookup: leave_approved → only requester ─────────────────

echo ""
echo "── Manager approves the leave (triggers leave_approved to requester) ─"
code=$(req POST "/leaves/$LEAVE_ID/approve" '{"approver_remarks":"smoke approve"}' "$MGR_ACCESS")
check "approve 200" 200 "$code"
let_dispatch_settle

req GET /notifications/unread-count '' "$EMP_ACCESS" >/dev/null
EMP_AFTER_APPROVE=$(jq1 .data.count)
check "emp unread after approve = 1" "1" "$EMP_AFTER_APPROVE"

# Manager / admin counts should be unchanged (decisions notify the requester only,
# not the reviewer pool).
req GET /notifications/unread-count '' "$MGR_ACCESS" >/dev/null
MGR_AFTER_APPROVE=$(jq1 .data.count)
check "mgr unread unchanged after approve = 1" "1" "$MGR_AFTER_APPROVE"
req GET /notifications/unread-count '' "$ADMIN_ACCESS" >/dev/null
ADMIN_AFTER_APPROVE=$(jq1 .data.count)
check "admin unread unchanged after approve = 1" "1" "$ADMIN_AFTER_APPROVE"

req GET '/notifications?type=leave_approved' '' "$EMP_ACCESS" >/dev/null
EMP_NOTIF_ID=$(jq1 .data[0].id)
EMP_NOTIF_TYPE=$(jq1 .data[0].type)
check "emp notif type = leave_approved" "leave_approved" "$EMP_NOTIF_TYPE"

# ── 7. GET /notifications — list, filters, pagination ───────────────────

echo ""
echo "── GET /notifications (manager: defaults) ──────────────────────"
code=$(req GET '/notifications' '' "$MGR_ACCESS")
check "list 200" 200 "$code"
MGR_LIST_TOTAL=$(jq1 .meta.total)
MGR_LIST_PAGE=$(jq1 .meta.page)
MGR_LIST_LIMIT=$(jq1 .meta.limit)
check "default page = 1"   "1"  "$MGR_LIST_PAGE"
check "default limit = 20" "20" "$MGR_LIST_LIMIT"
[[ "$MGR_LIST_TOTAL" -ge 1 ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m mgr list non-empty (got %s)\n" "$MGR_LIST_TOTAL"; }

echo ""
echo "── GET /notifications?is_read=false (manager) ──────────────────"
code=$(req GET '/notifications?is_read=false' '' "$MGR_ACCESS")
check "is_read=false 200" 200 "$code"
ALL_UNREAD=$(jqx "b.data.every(r => r.is_read === false)")
check "every row unread" "true" "$ALL_UNREAD"

echo ""
echo "── GET /notifications?type=leave_requested (manager) ──────────"
code=$(req GET '/notifications?type=leave_requested' '' "$MGR_ACCESS")
check "type filter 200" 200 "$code"
ALL_TYPE=$(jqx "b.data.every(r => r.type === 'leave_requested')")
check "every row leave_requested" "true" "$ALL_TYPE"

echo ""
echo "── GET /notifications?page=1&limit=1 (manager) — pagination ───"
code=$(req GET '/notifications?page=1&limit=1' '' "$MGR_ACCESS")
check "limit=1 200" 200 "$code"
PAGE_LEN=$(jqx "b.data.length")
PAGE_LIMIT=$(jq1 .meta.limit)
PAGE_PAGES=$(jq1 .meta.total_pages)
check "data length = 1"  "1" "$PAGE_LEN"
check "meta.limit = 1"   "1" "$PAGE_LIMIT"
[[ "$PAGE_PAGES" -ge 1 ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m total_pages >= 1 (got %s)\n" "$PAGE_PAGES"; }

# ── 8. GET /notifications validation ────────────────────────────────────

echo ""
echo "── Validation: bad is_read → 400 ───────────────────────────────"
code=$(req GET '/notifications?is_read=maybe' '' "$MGR_ACCESS")
check "bad is_read 400" 400 "$code"

echo ""
echo "── Validation: bad type → 400 ──────────────────────────────────"
code=$(req GET '/notifications?type=not_a_real_type' '' "$MGR_ACCESS")
check "bad type 400" 400 "$code"

echo ""
echo "── Validation: limit > 100 → 400 ───────────────────────────────"
code=$(req GET '/notifications?limit=500' '' "$MGR_ACCESS")
check "huge limit 400" 400 "$code"

echo ""
echo "── Validation: unknown query key → 400 (strict schema) ─────────"
code=$(req GET '/notifications?surprise=1' '' "$MGR_ACCESS")
check "unknown key 400" 400 "$code"

# ── 9. POST /notifications/:id/read — mark single, idempotent ──────────

echo ""
echo "── POST /notifications/:id/read (manager, first time) ─────────"
code=$(req POST "/notifications/$MGR_NOTIF_ID/read" '' "$MGR_ACCESS")
check "mark-read 200" 200 "$code"
READ_FLAG=$(jq1 .data.is_read)
READ_AT=$(jq1 .data.read_at)
check "is_read=true after mark"  "true" "$READ_FLAG"
[[ -n "$READ_AT" && "$READ_AT" != "null" && "$READ_AT" != "undefined" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m read_at populated (got %s)\n" "$READ_AT"; }

echo ""
echo "── POST /notifications/:id/read again (idempotent, 200) ───────"
code=$(req POST "/notifications/$MGR_NOTIF_ID/read" '' "$MGR_ACCESS")
check "mark-read idempotent 200" 200 "$code"
STILL_READ=$(jq1 .data.is_read)
check "is_read still true" "true" "$STILL_READ"

echo ""
echo "── unread-count drops by 1 after mark ──────────────────────────"
req GET /notifications/unread-count '' "$MGR_ACCESS" >/dev/null
MGR_AFTER_MARK=$(jq1 .data.count)
check "mgr unread after mark = 0" "0" "$MGR_AFTER_MARK"

# ── 10. POST /notifications/read-all — bulk mark (employee branch) ──────

# Generate a second unread row for the employee by cancelling their (now
# approved) leave — that fans `leave_cancelled` to the reviewer pool, but
# also lands a row on the requester for the cancelled-by-self decision
# branch (handled by notifyLeaveDecided).
echo ""
echo "── Cancel the approved leave to seed more notifications ────────"
code=$(req POST "/leaves/$LEAVE_ID/cancel" '{"cancellation_reason":"smoke notif test"}' "$EMP_ACCESS")
check "cancel 200" 200 "$code"
let_dispatch_settle

# Self-cancel does NOT add a row to the requester (actorIsRequester branch
# skips the requester push), so emp count is still 1. But the reviewer pool
# (admin + manager, minus the actor=employee) DOES get a row.
req GET /notifications/unread-count '' "$EMP_ACCESS" >/dev/null
EMP_AFTER_CANCEL=$(jq1 .data.count)
check "emp unread after self-cancel = 1 (no self-row)" "1" "$EMP_AFTER_CANCEL"

req GET /notifications/unread-count '' "$MGR_ACCESS" >/dev/null
MGR_AFTER_CANCEL=$(jq1 .data.count)
check "mgr unread after cancel = 1 (cancel row added)" "1" "$MGR_AFTER_CANCEL"

req GET /notifications/unread-count '' "$ADMIN_ACCESS" >/dev/null
ADMIN_AFTER_CANCEL=$(jq1 .data.count)
check "admin unread after cancel = 2 (apply + cancel)" "2" "$ADMIN_AFTER_CANCEL"

echo ""
echo "── POST /notifications/read-all (admin) → updated >= 2 ────────"
code=$(req POST '/notifications/read-all' '' "$ADMIN_ACCESS")
check "read-all 200" 200 "$code"
UPDATED=$(jq1 .data.updated)
[[ "$UPDATED" -ge 2 ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m read-all updated >= 2 (got %s)\n" "$UPDATED"; }

req GET /notifications/unread-count '' "$ADMIN_ACCESS" >/dev/null
ADMIN_AFTER_READALL=$(jq1 .data.count)
check "admin unread after read-all = 0" "0" "$ADMIN_AFTER_READALL"

# Re-fire read-all on the same user to assert it's idempotent (returns 0
# updated rows when nothing is unread).
echo ""
echo "── POST /notifications/read-all again (idempotent) → updated=0 ─"
code=$(req POST '/notifications/read-all' '' "$ADMIN_ACCESS")
check "read-all idempotent 200" 200 "$code"
UPDATED2=$(jq1 .data.updated)
check "second read-all updated=0" "0" "$UPDATED2"

# ── 11. RBAC: owner-scoping — emp2 can't touch emp's notification ──────

# Employee gets a row id we can probe with a different user.
req GET '/notifications?type=leave_approved' '' "$EMP_ACCESS" >/dev/null
EMP_TARGET_ID=$(jq1 .data[0].id)
[[ -n "$EMP_TARGET_ID" && "$EMP_TARGET_ID" != "undefined" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m emp leave_approved row exists\n"; }

echo ""
echo "── RBAC: emp2 tries to mark emp's notification → 404 ──────────"
code=$(req POST "/notifications/$EMP_TARGET_ID/read" '' "$EMP2_ACCESS")
check "cross-user mark 404" 404 "$code"
ERR=$(jq1 .error.code)
check "RESOURCE_NOT_FOUND" "RESOURCE_NOT_FOUND" "$ERR"

echo ""
echo "── RBAC: emp2 tries to dismiss emp's notification → 404 ───────"
code=$(req DELETE "/notifications/$EMP_TARGET_ID" '' "$EMP2_ACCESS")
check "cross-user delete 404" 404 "$code"

echo ""
echo "── RBAC: emp2 list never includes emp's rows ──────────────────"
# Capture emp2's id once via a clean login, then list and assert.
req POST /auth/login "{\"email\":\"$EMP2_EMAIL\",\"password\":\"$EMP2_PASS\"}" >/dev/null
EMP2_ID=$(jq1 .data.user.id)
req GET '/notifications?limit=100' '' "$EMP2_ACCESS" >/dev/null
EMP2_LIST_LEN=$(jqx "b.data.length")
check "emp2 list is empty (no events trigger them in this run)" "0" "$EMP2_LIST_LEN"
EMP2_ALL_OWN=$(jqx "b.data.every(r => r.user_id === '$EMP2_ID')")
check "every visible row belongs to emp2 (vacuously true on empty)" "true" "$EMP2_ALL_OWN"

# ── 12. DELETE /notifications/:id — dismiss happy path + double-delete ──

echo ""
echo "── DELETE /notifications/:id (employee dismisses own) → 204 ───"
code=$(req DELETE "/notifications/$EMP_TARGET_ID" '' "$EMP_ACCESS")
check "dismiss 204" 204 "$code"

echo ""
echo "── DELETE /notifications/:id again → 404 ──────────────────────"
code=$(req DELETE "/notifications/$EMP_TARGET_ID" '' "$EMP_ACCESS")
check "double-dismiss 404" 404 "$code"

# ── 13. Param validation: bad ObjectId → 400 ───────────────────────────

echo ""
echo "── POST /notifications/not-an-id/read → 400 ───────────────────"
code=$(req POST '/notifications/not-an-id/read' '' "$EMP_ACCESS")
check "bad id 400" 400 "$code"

echo ""
echo "── DELETE /notifications/not-an-id → 400 ──────────────────────"
code=$(req DELETE '/notifications/not-an-id' '' "$EMP_ACCESS")
check "bad id delete 400" 400 "$code"

# Well-formed but unknown id → 404
echo ""
echo "── POST /notifications/<missing-id>/read → 404 ────────────────"
code=$(req POST '/notifications/000000000000000000000000/read' '' "$EMP_ACCESS")
check "missing id 404" 404 "$code"

# ── 14. No-token requests → 401 across all 5 endpoints ─────────────────

echo ""
echo "── No-token: GET /notifications → 401 ─────────────────────────"
code=$(req GET '/notifications' '')
check "list no-auth 401" 401 "$code"
echo "── No-token: GET /notifications/unread-count → 401 ────────────"
code=$(req GET '/notifications/unread-count' '')
check "unread-count no-auth 401" 401 "$code"
echo "── No-token: POST /notifications/<id>/read → 401 ──────────────"
code=$(req POST '/notifications/000000000000000000000000/read' '')
check "mark no-auth 401" 401 "$code"
echo "── No-token: POST /notifications/read-all → 401 ───────────────"
code=$(req POST '/notifications/read-all' '')
check "read-all no-auth 401" 401 "$code"
echo "── No-token: DELETE /notifications/<id> → 401 ─────────────────"
code=$(req DELETE '/notifications/000000000000000000000000' '')
check "delete no-auth 401" 401 "$code"

# ── 15. Final cleanup ──────────────────────────────────────────────────

echo ""
echo "── Final cleanup ───────────────────────────────────────────────"
( cd "$SCRIPT_DIR/.." && npx tsx scripts/smoke-notifications-prep.ts >/dev/null ) || true
echo "    notifications + smoke-notifications leaves wiped"

echo ""
echo "────────────────────────────────────────────────────────────────"
printf "  \e[1m%d passed, %d failed\e[0m\n" "$pass" "$fail"
echo "────────────────────────────────────────────────────────────────"
exit $fail
