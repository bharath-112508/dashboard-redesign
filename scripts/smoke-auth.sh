#!/usr/bin/env bash
# End-to-end smoke test for /auth/* (Step 2).
#
# Runs against a server already listening on http://localhost:3001.
# Uses the seed admin (smoke@example.com / SmokeA@123!).
# Lazily creates a brute-force victim + a deactivated user.
#
# To get a fresh DB state first, run `npx tsx scripts/smoke-reset-users.ts`.
#
# NOTE: this smoke fires ~10 failed-auth requests against the per-IP rate
# limiter. The bundled `.env` bumps `AUTH_RATE_LIMIT_MAX` so this fits;
# if you've changed that, restart the dev server before running.
set -u

API=http://localhost:3001/api/v1
ADMIN_EMAIL=smoke@example.com
ADMIN_PASS='SmokeA@123!'
ADMIN_PASS_TEMP='SmokeT@456!'

VICTIM_EMAIL=smoke-bf-victim@example.com
VICTIM_PASS='Victim@123!X'

DEACT_EMAIL=smoke-deact@example.com
DEACT_PASS='Deact@456!Y'

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

# ─── 1. Login validation ──────────────────────────────────────────────────

echo "── POST /auth/login validation ────────────────────────────────"
code=$(req POST /auth/login '{}')
check "empty body 400" 400 "$code"
err=$(jq1 .error.code)
check "VALIDATION_ERROR" "VALIDATION_ERROR" "$err"

code=$(req POST /auth/login '{"email":"not-an-email","password":"x"}')
check "bad email format 400" 400 "$code"

code=$(req POST /auth/login "{\"email\":\"$ADMIN_EMAIL\"}")
check "missing password 400" 400 "$code"

# ─── 2. Login happy path ─────────────────────────────────────────────────

echo ""
echo "── POST /auth/login happy path ────────────────────────────────"
code=$(req POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
check "login 200" 200 "$code"
ACCESS=$(jq1 .data.access_token)
REFRESH=$(jq1 .data.refresh_token)
ACCESS_EXP=$(jq1 .data.access_token_expires_at)
REFRESH_EXP=$(jq1 .data.refresh_token_expires_at)
USER_ROLE=$(jq1 .data.user.role)
USER_NAME=$(jq1 .data.user.full_name)
echo "    access len=${#ACCESS} refresh len=${#REFRESH}"

HAS_BOTH=$(jqx "typeof b.data.access_token === 'string' && b.data.access_token.length > 50 && typeof b.data.refresh_token === 'string' && b.data.refresh_token.length > 50")
check "both tokens issued (>50 chars)" "true" "$HAS_BOTH"
check "user.role=admin" "admin" "$USER_ROLE"
check "user.full_name set" "Smoke Admin" "$USER_NAME"
ACCESS_FUTURE=$(node -e "process.stdout.write(String(new Date('$ACCESS_EXP') > new Date()))")
check "access_token_expires_at in future" "true" "$ACCESS_FUTURE"
REFRESH_FUTURE=$(node -e "process.stdout.write(String(new Date('$REFRESH_EXP') > new Date()))")
check "refresh_token_expires_at in future" "true" "$REFRESH_FUTURE"

echo ""
echo "── Wrong password → 401 INVALID_CREDENTIALS ──────────────────"
code=$(req POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"WrongPass@1!\"}")
check "wrong password 401" 401 "$code"
err=$(jq1 .error.code)
check "INVALID_CREDENTIALS" "INVALID_CREDENTIALS" "$err"

echo ""
echo "── Unknown email → SAME 401 INVALID_CREDENTIALS (no enum) ────"
code=$(req POST /auth/login '{"email":"nobody@example.com","password":"Anything@1!"}')
check "unknown email 401" 401 "$code"
err=$(jq1 .error.code)
check "INVALID_CREDENTIALS (timing-equalised)" "INVALID_CREDENTIALS" "$err"

# ─── 3. GET /auth/me ─────────────────────────────────────────────────────

echo ""
echo "── GET /auth/me ────────────────────────────────────────────────"
code=$(req GET /auth/me '' "$ACCESS")
check "me 200" 200 "$code"
ME_EMAIL=$(jq1 .data.email)
check "email matches" "$ADMIN_EMAIL" "$ME_EMAIL"
ME_ROLE=$(jq1 .data.role)
check "role=admin" "admin" "$ME_ROLE"
HAS_PERMS=$(jqx "Array.isArray(b.data.permissions)")
check "permissions array present" "true" "$HAS_PERMS"
NO_PASSWORD=$(jqx "!('password_hash' in b.data) && !('mfa_secret_encrypted' in b.data)")
check "no sensitive fields leaked" "true" "$NO_PASSWORD"

echo ""
echo "── /auth/me without bearer → 401 ──────────────────────────────"
code=$(req GET /auth/me '')
check "no auth 401" 401 "$code"

echo ""
echo "── /auth/me with malformed bearer → 401 ──────────────────────"
code=$(req GET /auth/me '' 'malformed.jwt.token')
check "malformed jwt 401" 401 "$code"

# ─── 4. Refresh rotation ─────────────────────────────────────────────────

echo ""
echo "── POST /auth/refresh — rotation issues a NEW pair ───────────"
code=$(req POST /auth/refresh "{\"refresh_token\":\"$REFRESH\"}")
check "refresh 200" 200 "$code"
ACCESS2=$(jq1 .data.access_token)
REFRESH2=$(jq1 .data.refresh_token)
NEW_ACCESS=$(node -e "process.stdout.write(String('$ACCESS' !== '$ACCESS2'))")
check "access token rotated" "true" "$NEW_ACCESS"
NEW_REFRESH=$(node -e "process.stdout.write(String('$REFRESH' !== '$REFRESH2'))")
check "refresh token rotated" "true" "$NEW_REFRESH"
HAS_USER=$(jqx "'user' in b.data")
check "refresh response omits user object" "false" "$HAS_USER"

echo ""
echo "── Reusing the OLD refresh → 401 TOKEN_REUSE_DETECTED ────────"
code=$(req POST /auth/refresh "{\"refresh_token\":\"$REFRESH\"}")
check "reuse 401" 401 "$code"
err=$(jq1 .error.code)
check "TOKEN_REUSE_DETECTED" "TOKEN_REUSE_DETECTED" "$err"

echo ""
echo "── After reuse, the NEW chain is also revoked ─────────────────"
code=$(req POST /auth/refresh "{\"refresh_token\":\"$REFRESH2\"}")
check "post-reuse new refresh 401" 401 "$code"

echo ""
echo "── Refresh with garbage token → 401 ───────────────────────────"
code=$(req POST /auth/refresh '{"refresh_token":"not-a-real-jwt-just-noise"}')
check "garbage refresh 401" 401 "$code"

# Re-login to get fresh tokens for downstream tests
code=$(req POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
ACCESS=$(jq1 .data.access_token)
REFRESH=$(jq1 .data.refresh_token)

# ─── 5. Logout (single session) ──────────────────────────────────────────

echo ""
echo "── POST /auth/logout ──────────────────────────────────────────"
code=$(req POST /auth/logout "{\"refresh_token\":\"$REFRESH\"}")
check "logout 204" 204 "$code"

echo ""
echo "── Refreshing the logged-out token → 401 ─────────────────────"
code=$(req POST /auth/refresh "{\"refresh_token\":\"$REFRESH\"}")
check "post-logout refresh 401" 401 "$code"

echo ""
echo "── Logout is idempotent (same token → 204 again) ─────────────"
code=$(req POST /auth/logout "{\"refresh_token\":\"$REFRESH\"}")
check "logout idempotent 204" 204 "$code"

echo ""
echo "── Logout with garbage refresh → 204 (idempotent by design) ──"
code=$(req POST /auth/logout '{"refresh_token":"garbage-but-validates-min-length"}')
check "logout unknown 204" 204 "$code"

# ─── 6. Logout-all (multi-session) ───────────────────────────────────────

echo ""
echo "── /auth/logout-all revokes EVERY active refresh ─────────────"
# Issue two parallel sessions, then logout-all from one, verify the OTHER is dead.
code=$(req POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
ACCESS_A=$(jq1 .data.access_token)
REFRESH_A=$(jq1 .data.refresh_token)
code=$(req POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
ACCESS_B=$(jq1 .data.access_token)
REFRESH_B=$(jq1 .data.refresh_token)

DIFF_REFRESH=$(node -e "process.stdout.write(String('$REFRESH_A' !== '$REFRESH_B'))")
check "two parallel sessions issue distinct refreshes" "true" "$DIFF_REFRESH"

code=$(req POST /auth/logout-all '' "$ACCESS_A")
check "logout-all 204" 204 "$code"

code=$(req POST /auth/refresh "{\"refresh_token\":\"$REFRESH_A\"}")
check "session A refresh dead" 401 "$code"
code=$(req POST /auth/refresh "{\"refresh_token\":\"$REFRESH_B\"}")
check "session B refresh dead" 401 "$code"

echo ""
echo "── /auth/logout-all without bearer → 401 ─────────────────────"
code=$(req POST /auth/logout-all '')
check "logout-all no-auth 401" 401 "$code"

# ─── 7. Change-password ──────────────────────────────────────────────────

echo ""
echo "── /auth/change-password validation ──────────────────────────"
# Re-login to get a fresh access token.
code=$(req POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
ACCESS=$(jq1 .data.access_token)
REFRESH=$(jq1 .data.refresh_token)

code=$(req POST /auth/change-password '{}' "$ACCESS")
check "empty body 400" 400 "$code"

code=$(req POST /auth/change-password "{\"old_password\":\"$ADMIN_PASS\",\"new_password\":\"$ADMIN_PASS\"}" "$ACCESS")
check "same as old 400" 400 "$code"

code=$(req POST /auth/change-password "{\"old_password\":\"$ADMIN_PASS\",\"new_password\":\"weak\"}" "$ACCESS")
check "weak new password 400" 400 "$code"

echo ""
echo "── Wrong old password → 401 ──────────────────────────────────"
code=$(req POST /auth/change-password "{\"old_password\":\"WrongOld@1!\",\"new_password\":\"$ADMIN_PASS_TEMP\"}" "$ACCESS")
check "wrong old 401" 401 "$code"
err=$(jq1 .error.code)
check "INVALID_CREDENTIALS" "INVALID_CREDENTIALS" "$err"

echo ""
echo "── Happy-path change-password (and restore at end) ───────────"
code=$(req POST /auth/change-password "{\"old_password\":\"$ADMIN_PASS\",\"new_password\":\"$ADMIN_PASS_TEMP\"}" "$ACCESS")
check "change to TEMP 200" 200 "$code"

# OLD password no longer works.
code=$(req POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
check "old password rejected 401" 401 "$code"

# NEW password works.
code=$(req POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS_TEMP\"}")
check "new password accepted 200" 200 "$code"
ACCESS=$(jq1 .data.access_token)

# Change-password revokes all refresh tokens — the one issued before is dead.
code=$(req POST /auth/refresh "{\"refresh_token\":\"$REFRESH\"}")
check "pre-change refresh revoked 401" 401 "$code"

# Restore original password so the rest of the smoke pipeline keeps working.
code=$(req POST /auth/change-password "{\"old_password\":\"$ADMIN_PASS_TEMP\",\"new_password\":\"$ADMIN_PASS\"}" "$ACCESS")
check "restore original 200" 200 "$code"

# ─── 8. Brute-force lockout ──────────────────────────────────────────────

echo ""
echo "── Lazily create brute-force victim ───────────────────────────"
code=$(req POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
ADMIN_ACCESS=$(jq1 .data.access_token)

VICTIM_BODY="{\"email\":\"$VICTIM_EMAIL\",\"full_name\":\"Brute Force Victim\",\"role\":\"employee\",\"initial_password\":\"$VICTIM_PASS\",\"internal_profile\":{\"employee_id\":\"SMOKE-BF-001\",\"job_title\":\"QA\",\"department\":\"Eng\",\"date_of_joining\":\"2025-01-01\"}}"
code=$(req POST /users "$VICTIM_BODY" "$ADMIN_ACCESS")
if [[ "$code" == "201" ]]; then
    echo "  created brute-force victim"
elif [[ "$code" == "409" ]]; then
    echo "  brute-force victim already exists (reusing)"
else
    printf "  \e[31mFAIL\e[0m create victim unexpected code %s\n" "$code"
    fail=$((fail + 1))
fi

echo ""
echo "── 5 wrong attempts → 401 each ────────────────────────────────"
for i in 1 2 3 4 5; do
    code=$(req POST /auth/login "{\"email\":\"$VICTIM_EMAIL\",\"password\":\"WrongPass@${i}!\"}")
    # Could be 401 (still in budget) OR 423 (already locked from a previous run);
    # accept either as "lockout machinery firing".
    if [[ "$code" == "401" || "$code" == "423" ]]; then
        printf "  \e[32mPASS\e[0m attempt %d → %s\n" "$i" "$code"
        pass=$((pass + 1))
    else
        printf "  \e[31mFAIL\e[0m attempt %d → unexpected %s\n" "$i" "$code"
        fail=$((fail + 1))
    fi
done

echo ""
echo "── 6th attempt MUST be 423 ACCOUNT_LOCKED ────────────────────"
code=$(req POST /auth/login "{\"email\":\"$VICTIM_EMAIL\",\"password\":\"WrongPass@6!\"}")
check "6th attempt 423" 423 "$code"
err=$(jq1 .error.code)
check "ACCOUNT_LOCKED" "ACCOUNT_LOCKED" "$err"

echo ""
echo "── Even CORRECT password is locked out during the window ─────"
code=$(req POST /auth/login "{\"email\":\"$VICTIM_EMAIL\",\"password\":\"$VICTIM_PASS\"}")
check "correct password locked 423" 423 "$code"

# ─── 9. Deactivated-account guard ────────────────────────────────────────

echo ""
echo "── Lazily create a user, then deactivate them ─────────────────"
DEACT_BODY="{\"email\":\"$DEACT_EMAIL\",\"full_name\":\"Will Be Deactivated\",\"role\":\"employee\",\"initial_password\":\"$DEACT_PASS\",\"internal_profile\":{\"employee_id\":\"SMOKE-DEACT-001\",\"job_title\":\"QA\",\"department\":\"Eng\",\"date_of_joining\":\"2025-01-01\"}}"
code=$(req POST /users "$DEACT_BODY" "$ADMIN_ACCESS")
if [[ "$code" == "201" || "$code" == "409" ]]; then
    echo "  user ready (code=$code)"
else
    printf "  \e[31mFAIL\e[0m create deact user unexpected %s\n" "$code"
    fail=$((fail + 1))
fi

# Get their id (admin GET)
code=$(req GET "/users?q=$DEACT_EMAIL" '' "$ADMIN_ACCESS")
DEACT_ID=$(jqx "b.data.find((u) => u.email === '$DEACT_EMAIL').id")

# Login first to confirm they CAN before being deactivated.
code=$(req POST /auth/login "{\"email\":\"$DEACT_EMAIL\",\"password\":\"$DEACT_PASS\"}")
# 200 (fresh) or 423 (locked from a re-run) both acceptable here — the meat is the deactivate guard below.
if [[ "$code" == "200" ]]; then
    DEACT_REFRESH=$(jq1 .data.refresh_token)
    printf "  pre-deact login %s\n" "$code"
elif [[ "$code" == "423" ]]; then
    DEACT_REFRESH=""
    printf "  pre-deact login locked from prior run (skipping refresh-after-deact assertion)\n"
else
    DEACT_REFRESH=""
    printf "  pre-deact login unexpected %s\n" "$code"
fi

# Now deactivate.
code=$(req POST "/users/$DEACT_ID/deactivate" '{"reason":"smoke"}' "$ADMIN_ACCESS")
check "deactivate 200" 200 "$code"

echo ""
echo "── Login as deactivated → 403 ACCOUNT_DEACTIVATED ────────────"
code=$(req POST /auth/login "{\"email\":\"$DEACT_EMAIL\",\"password\":\"$DEACT_PASS\"}")
check "deactivated login 403" 403 "$code"
err=$(jq1 .error.code)
check "ACCOUNT_DEACTIVATED" "ACCOUNT_DEACTIVATED" "$err"

if [[ -n "$DEACT_REFRESH" ]]; then
    echo ""
    echo "── Pre-deact refresh now also rejected (post-deact) ───────────"
    code=$(req POST /auth/refresh "{\"refresh_token\":\"$DEACT_REFRESH\"}")
    # Either 401 (token revoked by admin deactivate) or 403 (account check on refresh)
    if [[ "$code" == "401" || "$code" == "403" ]]; then
        printf "  \e[32mPASS\e[0m post-deact refresh blocked (%s)\n" "$code"
        pass=$((pass + 1))
    else
        printf "  \e[31mFAIL\e[0m post-deact refresh unexpectedly %s\n" "$code"
        fail=$((fail + 1))
    fi
fi

# ─── 10. /auth/logout body validation ───────────────────────────────────

echo ""
echo "── /auth/logout body validation ──────────────────────────────"
code=$(req POST /auth/logout '{}')
check "missing refresh_token 400" 400 "$code"

echo ""
echo "────────────────────────────────────────────────────────────────"
printf "  \e[1m%d passed, %d failed\e[0m\n" "$pass" "$fail"
echo "────────────────────────────────────────────────────────────────"
exit $fail
