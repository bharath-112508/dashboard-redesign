#!/usr/bin/env bash
# End-to-end smoke test for /attendance (Step 8).
#
# Runs against a server already listening on http://localhost:3001.
# Uses the seed admin (smoke@example.com / SmokeA@123!) and lazily creates
# a smoke manager + two employees for the RBAC and self-vs-other tests.
#
# Strategy: each run uses a fresh per-day attendance row by *resetting* the
# smoke employees' rows for today (best-effort delete via direct mongoose
# script — see scripts/smoke-reset-attendance.ts). If that script isn't
# present, the smoke still works on the first run of the day; reruns will
# expect 409 ALREADY_CHECKED_IN on the second pass and adapt.
set -u

API=http://localhost:3001/api/v1
ADMIN_EMAIL=smoke@example.com
ADMIN_PASS='SmokeA@123!'

MGR_EMAIL=smoke-mgr@example.com
MGR_PASS='SmokeM@123!'

# Two employees so we can test cross-user 404 on correction submission.
EMP_EMAIL=smoke-emp@example.com
EMP_PASS='SmokeE@123!'
EMP2_EMAIL=smoke-emp2@example.com
EMP2_PASS='Emp@2234567'

STAMP=$(date +%s)
LOCATION_NAME="Smoke Attendance Office ${STAMP}"
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
    # ensure_user EMAIL PASSWORD ROLE FULL_NAME EMP_ID JOB
    local email=$1 password=$2 role=$3 full=$4 empid=$5 job=$6
    local body
    if [[ "$role" == "client" ]]; then
        body="{\"email\":\"$email\",\"full_name\":\"$full\",\"role\":\"$role\",\"initial_password\":\"$password\",\"client_profile\":{\"company_name\":\"Acme Corp\"}}"
    else
        body="{\"email\":\"$email\",\"full_name\":\"$full\",\"role\":\"$role\",\"initial_password\":\"$password\",\"internal_profile\":{\"employee_id\":\"$empid\",\"job_title\":\"$job\",\"department\":\"Eng\",\"date_of_joining\":\"2025-01-01\"}}"
    fi
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

# ─── 1. Lazy-create the supporting users ─────────────────────────────────

echo ""
echo "── Lazy-create smoke users (idempotent on 409) ─────────────────"
ensure_user "$MGR_EMAIL"  "$MGR_PASS"  manager  "Smoke Manager"   SMOKE-MGR-001  "Engineering Manager"
ensure_user "$EMP_EMAIL"  "$EMP_PASS"  employee "Smoke Employee"  SMOKE-EMP-001  "Engineer"
ensure_user "$EMP2_EMAIL" "$EMP2_PASS" employee "Smoke Employee2" SMOKE-EMP-002  "Engineer"

MGR_ACCESS=$(login_get_token "$MGR_EMAIL"  "$MGR_PASS")
EMP_ACCESS=$(login_get_token "$EMP_EMAIL"  "$EMP_PASS")
EMP2_ACCESS=$(login_get_token "$EMP2_EMAIL" "$EMP2_PASS")
[[ -n "$MGR_ACCESS"  && "$MGR_ACCESS"  != "undefined" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m manager login\n"; }
[[ -n "$EMP_ACCESS"  && "$EMP_ACCESS"  != "undefined" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m employee login\n"; }
[[ -n "$EMP2_ACCESS" && "$EMP2_ACCESS" != "undefined" ]] && pass=$((pass+1)) || { fail=$((fail+1)); printf "  \e[31mFAIL\e[0m employee2 login\n"; }

# Capture user_ids for filter tests.
req GET "/users?email=$EMP_EMAIL" '' "$ADMIN_ACCESS" >/dev/null
EMP_ID=$(jqx "(b.data.find(u => u.email === '$EMP_EMAIL') || {}).id || ''")
req GET "/users?email=$EMP2_EMAIL" '' "$ADMIN_ACCESS" >/dev/null
EMP2_ID=$(jqx "(b.data.find(u => u.email === '$EMP2_EMAIL') || {}).id || ''")
echo "    EMP_ID  = $EMP_ID"
echo "    EMP2_ID = $EMP2_ID"

# Best-effort: clean today's attendance rows for the two smoke employees so
# the suite is rerunnable in a single working day. Tolerated if the helper
# isn't present yet.
if [[ -f scripts/smoke-reset-attendance.ts ]]; then
    echo ""
    echo "── Reset today's attendance rows for smoke employees ──────────"
    npx tsx scripts/smoke-reset-attendance.ts "$EMP_EMAIL" "$EMP2_EMAIL" >/dev/null 2>&1 || true
fi

# ─── 2. Spin up an active office location (for QR check-in scenario) ─────

echo ""
echo "── Create an office_location to back QR check-in ──────────────"
code=$(req POST /office-locations "{\"name\":\"$LOCATION_NAME\",\"address\":\"$LOCATION_ADDR\"}" "$ADMIN_ACCESS")
check "create location 201" 201 "$code"
LOC_ID=$(jq1 .data.id)
LOC_TOKEN=$(jq1 .data.qr_code_token)
echo "    LOC_ID    = $LOC_ID"
echo "    LOC_TOKEN = $LOC_TOKEN"

# ─── 3. POST /attendance/qr-verify ───────────────────────────────────────

echo ""
echo "── POST /attendance/qr-verify ─────────────────────────────────"
code=$(req POST /attendance/qr-verify "{\"qr_token\":\"$LOC_TOKEN\"}" "$EMP_ACCESS")
check "qr-verify valid token 200" 200 "$code"
RESOLVED_ID=$(jq1 .data.location.id)
check "resolved location.id matches" "$LOC_ID" "$RESOLVED_ID"
RESOLVED_NAME=$(jq1 .data.location.name)
check "resolved location.name matches" "$LOCATION_NAME" "$RESOLVED_NAME"

code=$(req POST /attendance/qr-verify '{"qr_token":"obviously-not-a-real-token-xyz"}' "$EMP_ACCESS")
check "qr-verify bogus token 400" 400 "$code"
err=$(jq1 .error.code)
check "INVALID_QR_TOKEN" "INVALID_QR_TOKEN" "$err"

code=$(req POST /attendance/qr-verify '{}' "$EMP_ACCESS")
check "qr-verify empty body 400" 400 "$code"

# ─── 4. POST /attendance/check-in (manual) ───────────────────────────────

echo ""
echo "── POST /attendance/check-in (manual, employee) ───────────────"
code=$(req POST /attendance/check-in '{"method":"manual"}' "$EMP_ACCESS")
if [[ "$code" == "201" ]]; then
    check "check-in 201" 201 "$code"
    REC_ID=$(jq1 .data.id)
    REC_LOCAL_DATE=$(jq1 .data.local_date)
    METHOD_USED=$(jq1 .data.check_in.method)
    STATUS_USED=$(jq1 .data.status)
    check "method=manual" "manual" "$METHOD_USED"
    check "status=present" "present" "$STATUS_USED"
    check "check_out null on first check-in" "null" "$(jq1 .data.check_out)"
    HAS_LOCAL_DATE=$(jqx "/^\\d{4}-\\d{2}-\\d{2}$/.test(b.data.local_date)")
    check "local_date is YYYY-MM-DD" "true" "$HAS_LOCAL_DATE"
elif [[ "$code" == "409" ]]; then
    err=$(jq1 .error.code)
    check "rerun: already checked in 409" "ALREADY_CHECKED_IN" "$err"
    # Recover REC_ID via /me/today so subsequent assertions work.
    req GET /attendance/me/today '' "$EMP_ACCESS" >/dev/null
    REC_ID=$(jq1 .data.id)
    REC_LOCAL_DATE=$(jq1 .data.local_date)
else
    fail=$((fail+1))
    printf "  \e[31mFAIL\e[0m unexpected check-in code %s\n" "$code"
    REC_ID=""
    REC_LOCAL_DATE=""
fi

echo "    REC_ID         = $REC_ID"
echo "    REC_LOCAL_DATE = $REC_LOCAL_DATE"

# ─── 5. Idempotency — second check-in returns 409 ALREADY_CHECKED_IN ─────

echo ""
echo "── Second check-in same day → 409 ─────────────────────────────"
code=$(req POST /attendance/check-in '{"method":"manual"}' "$EMP_ACCESS")
check "duplicate check-in 409" 409 "$code"
err=$(jq1 .error.code)
check "ALREADY_CHECKED_IN" "ALREADY_CHECKED_IN" "$err"

# ─── 6. GET /attendance/me/today ─────────────────────────────────────────

echo ""
echo "── GET /attendance/me/today ───────────────────────────────────"
code=$(req GET /attendance/me/today '' "$EMP_ACCESS")
check "me/today 200" 200 "$code"
TODAY_ID=$(jq1 .data.id)
check "me/today returns the same record" "$REC_ID" "$TODAY_ID"

# Employee2 hasn't checked in → /me/today returns data: null.
echo ""
echo "── Other employee with no record → me/today data: null ────────"
code=$(req GET /attendance/me/today '' "$EMP2_ACCESS")
check "me/today emp2 200" 200 "$code"
TODAY2=$(jq1 .data)
check "data is null for emp2" "null" "$TODAY2"

# ─── 7. POST /attendance/check-out (manual) ──────────────────────────────

echo ""
echo "── POST /attendance/check-out (manual, employee) ──────────────"
code=$(req POST /attendance/check-out '{"method":"manual"}' "$EMP_ACCESS")
check "check-out 200" 200 "$code"
HAS_OUT=$(jqx "b.data.check_out !== null && typeof b.data.check_out.time === 'string'")
check "check_out populated" "true" "$HAS_OUT"
WORKED=$(jqx "typeof b.data.total_worked_minutes === 'number'")
check "total_worked_minutes computed (number)" "true" "$WORKED"

# Second check-out → 409 ALREADY_CHECKED_OUT.
code=$(req POST /attendance/check-out '{"method":"manual"}' "$EMP_ACCESS")
check "duplicate check-out 409" 409 "$code"
err=$(jq1 .error.code)
check "ALREADY_CHECKED_OUT" "ALREADY_CHECKED_OUT" "$err"

# Employee2 hasn't checked in → check-out returns 409 NOT_CHECKED_IN.
code=$(req POST /attendance/check-out '{"method":"manual"}' "$EMP2_ACCESS")
check "emp2 check-out without check-in 409" 409 "$code"
err=$(jq1 .error.code)
check "NOT_CHECKED_IN" "NOT_CHECKED_IN" "$err"

# ─── 8. QR check-in for emp2 ─────────────────────────────────────────────

echo ""
echo "── POST /attendance/check-in (qr, employee2) ──────────────────"
code=$(req POST /attendance/check-in "{\"method\":\"qr\",\"qr_token\":\"$LOC_TOKEN\"}" "$EMP2_ACCESS")
if [[ "$code" == "201" ]]; then
    check "qr check-in 201" 201 "$code"
    REC2_ID=$(jq1 .data.id)
    METHOD2=$(jq1 .data.check_in.method)
    LOC2=$(jq1 .data.check_in.location_id)
    check "method=qr" "qr" "$METHOD2"
    check "location_id matches office id" "$LOC_ID" "$LOC2"
elif [[ "$code" == "409" ]]; then
    err=$(jq1 .error.code)
    check "rerun: emp2 already checked in 409" "ALREADY_CHECKED_IN" "$err"
    req GET /attendance/me/today '' "$EMP2_ACCESS" >/dev/null
    REC2_ID=$(jq1 .data.id)
else
    fail=$((fail+1))
    REC2_ID=""
fi

# QR with bogus token → 400 INVALID_QR_TOKEN even on a fresh user — but emp2
# is now checked in, so we hit a fresh tester via emp instead.
code=$(req POST /attendance/check-in '{"method":"qr","qr_token":"obviously-bad"}' "$EMP_ACCESS")
# emp is already checked in, so the unique-per-day rule fires first → 409.
# The token-validity check happens *before* the upsert, so we still expect
# 400 here. Either way we want the error code to be INVALID_QR_TOKEN.
err=$(jq1 .error.code)
check "bogus QR check-in surfaces INVALID_QR_TOKEN" "INVALID_QR_TOKEN" "$err"

# ─── 9. GET /attendance/me with date range ───────────────────────────────

echo ""
echo "── GET /attendance/me?from_date=...&to_date=... ───────────────"
TODAY=$(node -e "console.log(new Date(Date.now()+5.5*3600*1000).toISOString().slice(0,10))")
PAST=$(node -e "const d=new Date(Date.now()+5.5*3600*1000); d.setUTCDate(d.getUTCDate()-30); console.log(d.toISOString().slice(0,10))")
code=$(req GET "/attendance/me?from_date=$PAST&to_date=$TODAY&limit=100" '' "$EMP_ACCESS")
check "me list 200" 200 "$code"
HAS_OUR_REC=$(jqx "b.data.some(r => r.id === '$REC_ID')")
check "list contains today's record" "true" "$HAS_OUR_REC"

# Inverted range → 400.
code=$(req GET "/attendance/me?from_date=$TODAY&to_date=$PAST" '' "$EMP_ACCESS")
check "inverted range 400" 400 "$code"

# Range too wide → 400.
WIDE=$(node -e "const d=new Date(Date.now()+5.5*3600*1000); d.setUTCDate(d.getUTCDate()-200); console.log(d.toISOString().slice(0,10))")
code=$(req GET "/attendance/me?from_date=$WIDE&to_date=$TODAY" '' "$EMP_ACCESS")
check "wide range 400" 400 "$code"

# ─── 10. GET /attendance (manager / admin) ───────────────────────────────

echo ""
echo "── GET /attendance (manager) — sees both employees ────────────"
code=$(req GET "/attendance?limit=100" '' "$MGR_ACCESS")
check "manager list 200" 200 "$code"
SEES_EMP=$(jqx "b.data.some(r => r.user_id === '$EMP_ID')")
check "manager list sees emp record" "true" "$SEES_EMP"
SEES_EMP2=$(jqx "b.data.some(r => r.user_id === '$EMP2_ID')")
check "manager list sees emp2 record" "true" "$SEES_EMP2"

echo ""
echo "── GET /attendance?user_id= filters ───────────────────────────"
code=$(req GET "/attendance?user_id=$EMP_ID&limit=100" '' "$MGR_ACCESS")
check "filter by user_id 200" 200 "$code"
ALL_EMP=$(jqx "b.data.every(r => r.user_id === '$EMP_ID')")
check "every row belongs to emp" "true" "$ALL_EMP"

echo ""
echo "── GET /attendance?status=present filters ────────────────────"
code=$(req GET "/attendance?status=present&limit=100" '' "$MGR_ACCESS")
check "filter by status 200" 200 "$code"
ALL_PRESENT=$(jqx "b.data.every(r => r.status === 'present')")
check "every row is status=present" "true" "$ALL_PRESENT"

echo ""
echo "── Employee CANNOT GET /attendance (collection) → 403 ────────"
code=$(req GET "/attendance" '' "$EMP_ACCESS")
check "employee 403" 403 "$code"

# ─── 11. PATCH /attendance/:id (manager direct correction) ──────────────

echo ""
echo "── PATCH /attendance/:id (manager) ────────────────────────────"
NEW_OUT=$(node -e "const d=new Date(); d.setSeconds(d.getSeconds()+60); console.log(d.toISOString())")
code=$(req PATCH "/attendance/$REC_ID" "{\"check_out\":{\"time\":\"$NEW_OUT\"},\"notes\":\"Smoke patched\"}" "$MGR_ACCESS")
check "manager patch 200" 200 "$code"
PATCHED_NOTES=$(jq1 .data.notes)
check "notes reflect patch" "Smoke patched" "$PATCHED_NOTES"
PATCHED_BY=$(jqx "typeof b.data.last_corrected_by === 'string' && b.data.last_corrected_by.length === 24")
check "last_corrected_by stamped" "true" "$PATCHED_BY"

echo ""
echo "── PATCH empty body → 400 ────────────────────────────────────"
code=$(req PATCH "/attendance/$REC_ID" '{}' "$MGR_ACCESS")
check "empty patch 400" 400 "$code"

echo ""
echo "── Employee CANNOT PATCH → 403 ───────────────────────────────"
code=$(req PATCH "/attendance/$REC_ID" '{"notes":"emp tries"}' "$EMP_ACCESS")
check "employee patch 403" 403 "$code"

echo ""
echo "── PATCH unknown id → 404 ────────────────────────────────────"
code=$(req PATCH "/attendance/000000000000000000000000" '{"notes":"x"}' "$MGR_ACCESS")
check "patch unknown 404" 404 "$code"
err=$(jq1 .error.code)
check "ATTENDANCE_RECORD_NOT_FOUND" "ATTENDANCE_RECORD_NOT_FOUND" "$err"

# ─── 12. POST /attendance/correction-requests ───────────────────────────

echo ""
echo "── POST /attendance/correction-requests (employee) ────────────"
NEW_IN=$(node -e "const d=new Date(); d.setHours(d.getHours()-9); console.log(d.toISOString())")
NEW_OUT=$(node -e "const d=new Date(); d.setSeconds(d.getSeconds()+90); console.log(d.toISOString())")
BODY="{\"attendance_record_id\":\"$REC_ID\",\"requested_changes\":{\"check_in\":\"$NEW_IN\",\"check_out\":\"$NEW_OUT\",\"reason\":\"Forgot to check in/out at the right times\"}}"
code=$(req POST /attendance/correction-requests "$BODY" "$EMP_ACCESS")
check "submit correction 201" 201 "$code"
COR_ID=$(jq1 .data.id)
COR_STATUS=$(jq1 .data.status)
check "correction status=pending" "pending" "$COR_STATUS"

echo ""
echo "── Duplicate pending correction for same record → 409 ────────"
code=$(req POST /attendance/correction-requests "$BODY" "$EMP_ACCESS")
check "duplicate pending 409" 409 "$code"
err=$(jq1 .error.code)
check "CORRECTION_REQUEST_ALREADY_PENDING" "CORRECTION_REQUEST_ALREADY_PENDING" "$err"

echo ""
echo "── Cross-user submission → 404 (existence hidden) ─────────────"
BODY_X="{\"attendance_record_id\":\"$REC_ID\",\"requested_changes\":{\"check_in\":\"$NEW_IN\",\"reason\":\"Trying someone else's record\"}}"
code=$(req POST /attendance/correction-requests "$BODY_X" "$EMP2_ACCESS")
check "cross-user 404" 404 "$code"
err=$(jq1 .error.code)
check "ATTENDANCE_RECORD_NOT_FOUND" "ATTENDANCE_RECORD_NOT_FOUND" "$err"

echo ""
echo "── Validation: no check_in/out → 400 ─────────────────────────"
BODY_BAD="{\"attendance_record_id\":\"$REC_ID\",\"requested_changes\":{\"reason\":\"Missing both punches\"}}"
code=$(req POST /attendance/correction-requests "$BODY_BAD" "$EMP_ACCESS")
check "no punches 400" 400 "$code"

echo ""
echo "── Validation: check_in >= check_out → 400 ───────────────────"
BAD_IN=$(node -e "console.log(new Date().toISOString())")
BAD_OUT=$(node -e "const d=new Date(); d.setHours(d.getHours()-1); console.log(d.toISOString())")
BODY_BAD2="{\"attendance_record_id\":\"$REC_ID\",\"requested_changes\":{\"check_in\":\"$BAD_IN\",\"check_out\":\"$BAD_OUT\",\"reason\":\"Times reversed\"}}"
code=$(req POST /attendance/correction-requests "$BODY_BAD2" "$EMP_ACCESS")
check "in >= out 400" 400 "$code"

# ─── 13. GET /attendance/correction-requests ─────────────────────────────

echo ""
echo "── GET /attendance/correction-requests (employee → self only) ─"
code=$(req GET "/attendance/correction-requests?limit=100" '' "$EMP_ACCESS")
check "employee list 200" 200 "$code"
ALL_SELF=$(jqx "b.data.every(r => r.user_id === '$EMP_ID')")
check "every row belongs to emp (self-filter)" "true" "$ALL_SELF"

echo ""
echo "── Employee2 sees their own (likely empty) list, not emp's ───"
code=$(req GET "/attendance/correction-requests?limit=100" '' "$EMP2_ACCESS")
check "employee2 list 200" 200 "$code"
NO_LEAK=$(jqx "b.data.every(r => r.user_id === '$EMP2_ID')")
check "no cross-user leakage" "true" "$NO_LEAK"

echo ""
echo "── Manager sees everything ───────────────────────────────────"
code=$(req GET "/attendance/correction-requests?limit=100" '' "$MGR_ACCESS")
check "manager list 200" 200 "$code"
SEES_REQ=$(jqx "b.data.some(r => r.id === '$COR_ID')")
check "manager sees emp's request" "true" "$SEES_REQ"

echo ""
echo "── Filter ?status=pending ────────────────────────────────────"
code=$(req GET "/attendance/correction-requests?status=pending&limit=100" '' "$MGR_ACCESS")
check "status filter 200" 200 "$code"
ALL_PEND=$(jqx "b.data.every(r => r.status === 'pending')")
check "all pending" "true" "$ALL_PEND"

# ─── 14. Approve / reject ────────────────────────────────────────────────

echo ""
echo "── Employee CANNOT approve → 403 ─────────────────────────────"
code=$(req POST "/attendance/correction-requests/$COR_ID/approve" '{}' "$EMP_ACCESS")
check "employee approve 403" 403 "$code"

echo ""
echo "── Manager approves → 200 ────────────────────────────────────"
code=$(req POST "/attendance/correction-requests/$COR_ID/approve" '{"reviewer_remarks":"OK by smoke"}' "$MGR_ACCESS")
check "manager approve 200" 200 "$code"
APP_STATUS=$(jq1 .data.request.status)
check "request status=approved" "approved" "$APP_STATUS"
REVIEWER=$(jqx "typeof b.data.request.reviewer_id === 'string' && b.data.request.reviewer_id.length === 24")
check "reviewer_id stamped" "true" "$REVIEWER"
ACTED=$(jqx "typeof b.data.request.acted_at === 'string'")
check "acted_at stamped" "true" "$ACTED"
REMARKS=$(jq1 .data.request.reviewer_remarks)
check "reviewer_remarks reflect" "OK by smoke" "$REMARKS"
RECOMP=$(jqx "typeof b.data.record.total_worked_minutes === 'number' && b.data.record.total_worked_minutes >= 0")
check "underlying record total_worked_minutes recomputed" "true" "$RECOMP"

echo ""
echo "── Re-approving an already-approved request → 409 ────────────"
code=$(req POST "/attendance/correction-requests/$COR_ID/approve" '{}' "$MGR_ACCESS")
check "re-approve 409" 409 "$code"
err=$(jq1 .error.code)
check "CORRECTION_REQUEST_NOT_PENDING" "CORRECTION_REQUEST_NOT_PENDING" "$err"

# Submit + reject lifecycle on a fresh request.
echo ""
echo "── Submit a second correction (now no pending) and reject it ─"
NEW_IN2=$(node -e "const d=new Date(); d.setHours(d.getHours()-10); console.log(d.toISOString())")
BODY2="{\"attendance_record_id\":\"$REC_ID\",\"requested_changes\":{\"check_in\":\"$NEW_IN2\",\"reason\":\"Need a slightly different in time\"}}"
code=$(req POST /attendance/correction-requests "$BODY2" "$EMP_ACCESS")
check "submit second correction 201" 201 "$code"
COR2_ID=$(jq1 .data.id)

code=$(req POST "/attendance/correction-requests/$COR2_ID/reject" '{"reviewer_remarks":"Insufficient reason"}' "$MGR_ACCESS")
check "reject 200" 200 "$code"
REJ_STATUS=$(jq1 .data.status)
check "second request status=rejected" "rejected" "$REJ_STATUS"

echo ""
echo "── Reject already-rejected → 409 ─────────────────────────────"
code=$(req POST "/attendance/correction-requests/$COR2_ID/reject" '{}' "$MGR_ACCESS")
check "re-reject 409" 409 "$code"

echo ""
echo "── Approve unknown id → 404 ──────────────────────────────────"
code=$(req POST "/attendance/correction-requests/000000000000000000000000/approve" '{}' "$MGR_ACCESS")
check "unknown id 404" 404 "$code"
err=$(jq1 .error.code)
check "CORRECTION_REQUEST_NOT_FOUND" "CORRECTION_REQUEST_NOT_FOUND" "$err"

# ─── 15. RBAC sweep — no auth ────────────────────────────────────────────

echo ""
echo "── No-token requests → 401 ───────────────────────────────────"
code=$(req POST /attendance/check-in '{"method":"manual"}' '')
check "check-in no-auth 401" 401 "$code"
code=$(req POST /attendance/check-out '{"method":"manual"}' '')
check "check-out no-auth 401" 401 "$code"
code=$(req GET /attendance/me/today '' '')
check "me/today no-auth 401" 401 "$code"
code=$(req GET /attendance '' '')
check "list no-auth 401" 401 "$code"
code=$(req PATCH "/attendance/$REC_ID" '{"notes":"x"}' '')
check "patch no-auth 401" 401 "$code"
code=$(req POST /attendance/correction-requests "{\"attendance_record_id\":\"$REC_ID\",\"requested_changes\":{\"check_in\":\"$NEW_IN\",\"reason\":\"x\"}}" '')
check "correction no-auth 401" 401 "$code"

# ─── 16. Cleanup the office_location used here (soft-delete) ────────────

echo ""
echo "── Soft-delete the smoke office location ──────────────────────"
code=$(req DELETE "/office-locations/$LOC_ID" '' "$ADMIN_ACCESS")
check "delete location 204" 204 "$code"

echo ""
echo "────────────────────────────────────────────────────────────────"
printf "  \e[1m%d passed, %d failed\e[0m\n" "$pass" "$fail"
echo "────────────────────────────────────────────────────────────────"
exit $fail
