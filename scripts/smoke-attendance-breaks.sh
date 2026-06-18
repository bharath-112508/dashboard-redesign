#!/usr/bin/env bash
# End-to-end smoke test for attendance break endpoints (Task 8).
#
# Covers:
#   - check in → break/start {lunch} → 200
#   - second break/start → 409 ALREADY_ON_BREAK
#   - break/end → 200
#   - second break/end → 409 NOT_ON_BREAK
#   - break/start {nap} (invalid type) → 400
#   - break/start without checking in → 409 NOT_CHECKED_IN
#   - no-auth → 401 on both endpoints
#
# Requires a dev server on :3001.
# Admin creds:    smoke@example.com / SmokeA@123!  (seeded by smoke-seed-user.ts)
#                 Falls back to admin@viljetech.com / Vilje@1234 (demo seed).
# Employee creds: smoke-emp-brk@example.com / SmokeB@123!  (lazily created)
set -euo pipefail

API=http://localhost:3001/api/v1

# ── Admin credential discovery ────────────────────────────────────────────────
# Try the smoke-seeded admin first; fall back to the demo-seed admin so the
# script works against both a full smoke-reset and a plain dev database.
_try_login() {
    local email=$1 pass=$2
    local code
    code=$(curl -sS -o /tmp/sm_login_probe.json -w '%{http_code}' \
        -X POST "$API/auth/login" \
        -H 'Content-Type: application/json' \
        -d "{\"email\":\"$email\",\"password\":\"$pass\"}")
    echo "$code"
}

ADMIN_EMAIL=smoke@example.com
ADMIN_PASS='SmokeA@123!'
_probe=$(_try_login "$ADMIN_EMAIL" "$ADMIN_PASS")
if [[ "$_probe" != "200" ]]; then
    ADMIN_EMAIL=admin@viljetech.com
    ADMIN_PASS='Vilje@1234'
fi

EMP_EMAIL=smoke-emp-brk@example.com
EMP_PASS='SmokeB@123!'

# A second employee who has NOT checked in — used to test NOT_CHECKED_IN.
EMP2_EMAIL=smoke-emp-brk2@example.com
EMP2_PASS='SmokeC@123!'

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

# ─── 1. Lazy-create smoke employees (idempotent on 409) ──────────────────────

echo ""
echo "── Lazy-create smoke employees (idempotent on 409) ────────────"
ensure_user "$EMP_EMAIL"  "$EMP_PASS"  employee "Smoke Break Employee"  SMOKE-BRK-001 "Engineer"
ensure_user "$EMP2_EMAIL" "$EMP2_PASS" employee "Smoke Break Employee2" SMOKE-BRK-002 "Engineer"
EMP_ACCESS=$(login_get_token "$EMP_EMAIL" "$EMP_PASS")
EMP2_ACCESS=$(login_get_token "$EMP2_EMAIL" "$EMP2_PASS")
[[ -n "$EMP_ACCESS"  && "$EMP_ACCESS"  != "undefined" ]] \
    && pass=$((pass + 1)) \
    || { fail=$((fail + 1)); printf "  \e[31mFAIL\e[0m employee login\n"; }
[[ -n "$EMP2_ACCESS" && "$EMP2_ACCESS" != "undefined" ]] \
    && pass=$((pass + 1)) \
    || { fail=$((fail + 1)); printf "  \e[31mFAIL\e[0m employee2 login\n"; }

# ─── 2. break/start without check-in → 409 NOT_CHECKED_IN ────────────────────

echo ""
echo "── break/start without check-in → 409 NOT_CHECKED_IN ─────────"
# Best-effort: reset today's row for emp2 if the helper exists (so this test
# is re-runnable on the same calendar day).
if [[ -f scripts/smoke-reset-attendance.ts ]]; then
    npx tsx scripts/smoke-reset-attendance.ts "$EMP2_EMAIL" >/dev/null 2>&1 || true
fi
code=$(req POST /attendance/break/start '{"break_type":"lunch"}' "$EMP2_ACCESS")
check "break/start no check-in 409" 409 "$code"
err=$(jq1 .error.code)
check "NOT_CHECKED_IN" "NOT_CHECKED_IN" "$err"

# ─── 3. Check in the primary employee ────────────────────────────────────────

echo ""
echo "── Check in the primary employee ───────────────────────────────"
# Best-effort: reset today's row so the suite is re-runnable in the same day.
if [[ -f scripts/smoke-reset-attendance.ts ]]; then
    npx tsx scripts/smoke-reset-attendance.ts "$EMP_EMAIL" >/dev/null 2>&1 || true
fi
code=$(req POST /attendance/check-in '{"method":"manual"}' "$EMP_ACCESS")
if [[ "$code" == "201" ]]; then
    check "check-in 201" 201 "$code"
elif [[ "$code" == "409" ]]; then
    err=$(jq1 .error.code)
    check "rerun: already checked in 409" "ALREADY_CHECKED_IN" "$err"
    printf "  (already checked in from a prior run — continuing)\n"
else
    check "check-in 201 or 409" "201" "$code"
fi

# ─── 4. POST /attendance/break/start {lunch} → 200 ───────────────────────────

echo ""
echo "── POST /attendance/break/start {lunch} → 200 ─────────────────"
code=$(req POST /attendance/break/start '{"break_type":"lunch"}' "$EMP_ACCESS")
if [[ "$code" == "200" ]]; then
    check "break/start lunch 200" 200 "$code"
    HAS_BREAKS=$(node -e "
const b=JSON.parse(require('fs').readFileSync('/tmp/sm.json','utf8'));
const segs = b.data && b.data.segments;
const hasOpen = Array.isArray(segs) && segs.some(s =>
    Array.isArray(s.breaks) && s.breaks.some(brk => brk.break_type === 'lunch' && brk.end === null)
);
console.log(hasOpen);" 2>/dev/null || echo "false")
    check "open lunch break present in segments" "true" "$HAS_BREAKS"
elif [[ "$code" == "409" ]]; then
    err=$(jq1 .error.code)
    # If already on a break from a prior re-run, accept it and continue.
    if [[ "$err" == "ALREADY_ON_BREAK" ]]; then
        check "rerun: already on break 409" "ALREADY_ON_BREAK" "$err"
        printf "  (already on a break from a prior run — ending it first)\n"
        req POST /attendance/break/end '' "$EMP_ACCESS" >/dev/null || true
        # Retry start after ending the stale break.
        code=$(req POST /attendance/break/start '{"break_type":"lunch"}' "$EMP_ACCESS")
        check "break/start after cleanup 200" 200 "$code"
    else
        check "break/start lunch 200" 200 "$code"
    fi
else
    check "break/start lunch 200" 200 "$code"
fi

# ─── 5. Second break/start → 409 ALREADY_ON_BREAK ────────────────────────────

echo ""
echo "── Second break/start → 409 ALREADY_ON_BREAK ──────────────────"
code=$(req POST /attendance/break/start '{"break_type":"tea"}' "$EMP_ACCESS")
check "second break/start 409" 409 "$code"
err=$(jq1 .error.code)
check "ALREADY_ON_BREAK" "ALREADY_ON_BREAK" "$err"

# ─── 6. POST /attendance/break/end → 200 ─────────────────────────────────────

echo ""
echo "── POST /attendance/break/end → 200 ───────────────────────────"
code=$(req POST /attendance/break/end '' "$EMP_ACCESS")
check "break/end 200" 200 "$code"
HAS_CLOSED=$(node -e "
const b=JSON.parse(require('fs').readFileSync('/tmp/sm.json','utf8'));
const segs = b.data && b.data.segments;
const hasClosed = Array.isArray(segs) && segs.some(s =>
    Array.isArray(s.breaks) && s.breaks.some(brk => brk.end !== null && brk.end !== undefined)
);
console.log(hasClosed);" 2>/dev/null || echo "false")
check "break end time recorded in segments" "true" "$HAS_CLOSED"

# ─── 7. Second break/end → 409 NOT_ON_BREAK ──────────────────────────────────

echo ""
echo "── Second break/end → 409 NOT_ON_BREAK ────────────────────────"
code=$(req POST /attendance/break/end '' "$EMP_ACCESS")
check "second break/end 409" 409 "$code"
err=$(jq1 .error.code)
check "NOT_ON_BREAK" "NOT_ON_BREAK" "$err"

# ─── 8. break/start with invalid break_type → 400 ────────────────────────────

echo ""
echo "── break/start {nap} (invalid type) → 400 ─────────────────────"
code=$(req POST /attendance/break/start '{"break_type":"nap"}' "$EMP_ACCESS")
check "invalid break_type 400" 400 "$code"

# ─── 9. break/start with missing break_type → 400 ────────────────────────────

echo ""
echo "── break/start missing break_type → 400 ───────────────────────"
code=$(req POST /attendance/break/start '{}' "$EMP_ACCESS")
check "missing break_type 400" 400 "$code"

# ─── 10. No-auth → 401 on both endpoints ─────────────────────────────────────

echo ""
echo "── No-token requests → 401 ─────────────────────────────────────"
code=$(req POST /attendance/break/start '{"break_type":"lunch"}' '')
check "break/start no-auth 401" 401 "$code"
code=$(req POST /attendance/break/end '' '')
check "break/end no-auth 401" 401 "$code"

# ─── 11. Optional: check out to leave clean state ─────────────────────────────

echo ""
echo "── Check out primary employee (clean state) ─────────────────────"
code=$(req POST /attendance/check-out '{"method":"manual"}' "$EMP_ACCESS")
if [[ "$code" == "200" ]]; then
    check "check-out 200" 200 "$code"
elif [[ "$code" == "409" ]]; then
    err=$(jq1 .error.code)
    check "rerun: already checked out 409" "ALREADY_CHECKED_OUT" "$err"
else
    check "check-out 200" 200 "$code"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Attendance-breaks smoke summary: $pass passed, $fail failed"
echo "════════════════════════════════════════════════════════════════"
exit $fail
