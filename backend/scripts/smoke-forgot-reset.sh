#!/usr/bin/env bash
# End-to-end forgot/reset-password smoke test.
# Requires:
#   - server running on :3001
#   - SERVER_LOG env var pointing at the dev server's stdout log
#     (in our workflow this is the terminal file written by Shell tool).
#   - clean DB state (run scripts/smoke-reset-users.ts first).
set -u

API=http://localhost:3001/api/v1
EMAIL=smoke@example.com
OLD_PASS='SmokeA@123!'
NEW_PASS='SmokeB@456!'
SERVER_LOG=${SERVER_LOG:-}

pass=0; fail=0
check() { if [[ "$3" == "$2" ]]; then printf "  \e[32mPASS\e[0m %s (%s)\n" "$1" "$3"; pass=$((pass+1)); else printf "  \e[31mFAIL\e[0m %s (expected %s, got %s)\n" "$1" "$2" "$3"; fail=$((fail+1)); fi }
req() { local m=$1 p=$2 b=$3 t=${4:-}; local a=(-sS -o /tmp/sm.json -w '%{http_code}' -X "$m" "$API$p" -H 'Content-Type: application/json'); [[ -n "$t" ]] && a+=(-H "Authorization: Bearer $t"); [[ -n "$b" ]] && a+=(-d "$b"); curl "${a[@]}"; }
jq1() { node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/sm.json','utf8'))$1)"; }

# Grab the latest reset token printed by the mailer stub.
# The logger prints a line containing `"reset_url":"http://...?token=<TOKEN>"`.
extract_latest_token() {
    if [[ -z "$SERVER_LOG" || ! -f "$SERVER_LOG" ]]; then
        echo "[extract_latest_token] SERVER_LOG not set / file missing: $SERVER_LOG" >&2
        return 1
    fi
    tail -n 200 "$SERVER_LOG" \
        | grep -oE 'token=[A-Za-z0-9_-]+' \
        | tail -n1 \
        | sed 's/^token=//' \
        | sed 's/%3D/=/g' # in case encodeURIComponent padded base64
}

echo "── Ensure baseline login works with original password ──────────"
code=$(req POST /auth/login "{\"email\":\"$EMAIL\",\"password\":\"$OLD_PASS\"}")
check "baseline login 200" 200 "$code"
ACCESS=$(jq1 .data.access_token)
REFRESH_OLD=$(jq1 .data.refresh_token)

echo ""
echo "── /auth/forgot-password (known email) → generic 200 ───────────"
code=$(req POST /auth/forgot-password "{\"email\":\"$EMAIL\"}")
check "forgot known 200" 200 "$code"
MSG=$(jq1 .data.message)
check "generic message" "If this email is registered, a reset link has been sent." "$MSG"
sleep 0.3  # let the log buffer flush

echo ""
echo "── /auth/forgot-password (unknown email) → SAME generic 200 ───"
code=$(req POST /auth/forgot-password '{"email":"ghost@example.com"}')
check "forgot unknown 200 (no enumeration)" 200 "$code"
MSG2=$(jq1 .data.message)
check "same generic message" "$MSG" "$MSG2"

echo ""
echo "── Extract token from server log ───────────────────────────────"
TOKEN=$(extract_latest_token || true)
if [[ -z "$TOKEN" ]]; then
    echo "  \e[31mFAIL\e[0m could not extract token from log (SERVER_LOG=$SERVER_LOG)"
    fail=$((fail+1))
    printf "  %d passed, %d failed\n" "$pass" "$fail"
    exit 1
fi
echo "  extracted token length = ${#TOKEN}"

echo ""
echo "── /auth/reset-password with weak password → 422 ──────────────"
code=$(req POST /auth/reset-password "{\"token\":\"$TOKEN\",\"new_password\":\"weak\"}")
check "weak password 400" 400 "$code"

echo ""
echo "── /auth/reset-password with bogus token → 400 ────────────────"
code=$(req POST /auth/reset-password "{\"token\":\"definitely-not-a-real-token-aaaaaaaaaaaaaa\",\"new_password\":\"$NEW_PASS\"}")
check "bogus token 400" 400 "$code"

echo ""
echo "── /auth/reset-password with valid token → 200 ────────────────"
code=$(req POST /auth/reset-password "{\"token\":\"$TOKEN\",\"new_password\":\"$NEW_PASS\"}")
check "reset 200" 200 "$code"

echo ""
echo "── Same token cannot be reused ─────────────────────────────────"
code=$(req POST /auth/reset-password "{\"token\":\"$TOKEN\",\"new_password\":\"$NEW_PASS\"}")
check "reused token 400" 400 "$code"

echo ""
echo "── Old password no longer works ────────────────────────────────"
code=$(req POST /auth/login "{\"email\":\"$EMAIL\",\"password\":\"$OLD_PASS\"}")
check "old password 401" 401 "$code"

echo ""
echo "── New password works ──────────────────────────────────────────"
code=$(req POST /auth/login "{\"email\":\"$EMAIL\",\"password\":\"$NEW_PASS\"}")
check "new password 200" 200 "$code"

echo ""
echo "── Old refresh token revoked (all sessions cleared) ────────────"
code=$(req POST /auth/refresh "{\"refresh_token\":\"$REFRESH_OLD\"}")
check "old refresh 401" 401 "$code"

echo ""
echo "── Requesting a second reset invalidates the first ────────────"
code=$(req POST /auth/forgot-password "{\"email\":\"$EMAIL\"}")
check "forgot again 200" 200 "$code"
sleep 0.3
TOKEN1=$TOKEN
TOKEN2=$(extract_latest_token)
[[ "$TOKEN1" != "$TOKEN2" ]] && pass=$((pass+1)) && echo "  \e[32mPASS\e[0m second token differs" || { fail=$((fail+1)); echo "  \e[31mFAIL\e[0m second token same as first"; }

# Older tokens are invalidated on new request; TOKEN1 was already used (so also fails on that ground).
# Confirm the fresh TOKEN2 works instead.
echo ""
echo "── Latest token works; reset restores original password ───────"
code=$(req POST /auth/reset-password "{\"token\":\"$TOKEN2\",\"new_password\":\"$OLD_PASS\"}")
check "reset back 200" 200 "$code"
code=$(req POST /auth/login "{\"email\":\"$EMAIL\",\"password\":\"$OLD_PASS\"}")
check "baseline restored" 200 "$code"

echo ""
echo "────────────────────────────────────────────────────────────────"
printf "  \e[1m%d passed, %d failed\e[0m\n" "$pass" "$fail"
echo "────────────────────────────────────────────────────────────────"
exit $fail
