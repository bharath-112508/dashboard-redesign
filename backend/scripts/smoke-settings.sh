#!/usr/bin/env bash
# End-to-end smoke test for /settings (System Settings — Step 6).
#
# Runs against a server already listening on http://localhost:3001.
# Uses the seed admin (smoke@example.com / SmokeA@123!).
# Lazily creates a smoke employee for the redaction test.
#
# To get a fresh DB state first, run `npx tsx scripts/smoke-reset-users.ts`
# (note: that script does NOT touch system_settings — this smoke captures
# any pre-existing values up front and restores them at the end so it is
# safe to re-run repeatedly).
set -u

API=http://localhost:3001/api/v1
ADMIN_EMAIL=smoke@example.com
ADMIN_PASS='SmokeA@123!'

EMP_EMAIL=smoke-emp@example.com
EMP_PASS='SmokeE@123!'

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
    # usage: req METHOD PATH BODY [TOKEN]
    local method=$1 path=$2 body=$3 token=${4:-}
    local args=(-sS -o /tmp/sm.json -w '%{http_code}' -X "$method" "$API$path" -H 'Content-Type: application/json')
    [[ -n "$token" ]] && args+=(-H "Authorization: Bearer $token")
    [[ -n "$body" ]] && args+=(-d "$body")
    curl "${args[@]}"
}

jq1() {
    # Read /tmp/sm.json and APPEND the given JS expression to the parsed body.
    # Useful for property chains that begin with `.`, e.g.
    #   jq1 .data.access_token       → JSON.parse(...).data.access_token
    #   jq1 ".data.foo !== undefined"
    node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/sm.json','utf8'))$1)"
}

jqx() {
    # Read /tmp/sm.json and bind it to `b`, then evaluate an arbitrary JS expression.
    # Use this when the expression isn't a simple member chain off the body
    # (e.g. needs `typeof`, `Object.keys`, boolean composition, etc.).
    #   jqx "typeof b.data.company.name === 'string'"
    #   jqx "Object.keys(b.data).sort().join(',')"
    node -e "const b=JSON.parse(require('fs').readFileSync('/tmp/sm.json','utf8')); console.log($1)"
}

# Login helper that exits the script if login fails.
login_get_token() {
    local email=$1 password=$2
    req POST /auth/login "{\"email\":\"$email\",\"password\":\"$password\"}" >/dev/null
    jq1 .data.access_token
}

# ─── 0. Login as admin & capture original settings ─────────────────────────

echo "── Login as admin ──────────────────────────────────────────────"
code=$(req POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
check "admin login 200" 200 "$code"
ADMIN_ACCESS=$(jq1 .data.access_token)

echo ""
echo "── Capture originals (so we can restore at the end) ────────────"
req GET /settings '' "$ADMIN_ACCESS" >/dev/null
ORIG_CL_NOTICE=$(jq1 .data.leave_policy.cl_advance_notice_days)
ORIG_PRIMARY_COLOR=$(jq1 .data.company.primary_color)
ORIG_WORKING_DAYS=$(jq1 ".data.work_schedule.working_days.join(',')")
ORIG_TIMESHEET_WIN=$(jq1 .data.timesheet.self_edit_window_days)
echo "    cl_advance_notice_days = $ORIG_CL_NOTICE"
echo "    primary_color          = $ORIG_PRIMARY_COLOR"
echo "    working_days           = $ORIG_WORKING_DAYS"
echo "    self_edit_window_days  = $ORIG_TIMESHEET_WIN"

# ─── 1. /settings/public ───────────────────────────────────────────────────

echo ""
echo "── GET /settings/public (no auth) ──────────────────────────────"
code=$(req GET /settings/public '')
check "public 200" 200 "$code"
HAS_COMPANY=$(jq1 ".data.company !== undefined")
check "data.company present" "true" "$HAS_COMPANY"
HAS_NAME=$(jqx "typeof b.data.company.name === 'string'")
check "company.name present" "true" "$HAS_NAME"
HAS_LEAK_SECURITY=$(jq1 ".data.security !== undefined")
check "no security leak" "false" "$HAS_LEAK_SECURITY"
HAS_LEAK_EMAIL=$(jq1 ".data.email !== undefined")
check "no email leak" "false" "$HAS_LEAK_EMAIL"
HAS_LEAK_SLACK=$(jq1 ".data.slack !== undefined")
check "no slack leak" "false" "$HAS_LEAK_SLACK"
ONLY_COMPANY=$(jqx "Object.keys(b.data).sort().join(',')")
check "public payload exposes only {company}" "company" "$ONLY_COMPANY"

# ─── 2. GET /settings without auth ─────────────────────────────────────────

echo ""
echo "── GET /settings without auth → 401 ───────────────────────────"
code=$(req GET /settings '')
check "no-token 401" 401 "$code"

# ─── 3. GET /settings as admin → full doc ──────────────────────────────────

echo ""
echo "── GET /settings as admin → full doc ──────────────────────────"
code=$(req GET /settings '' "$ADMIN_ACCESS")
check "admin GET 200" 200 "$code"
HAS_SECURITY=$(jq1 ".data.security !== undefined")
check "admin sees .security" "true" "$HAS_SECURITY"
HAS_EMAIL=$(jq1 ".data.email !== undefined")
check "admin sees .email" "true" "$HAS_EMAIL"
HAS_SLACK=$(jq1 ".data.slack !== undefined")
check "admin sees .slack" "true" "$HAS_SLACK"
HAS_SINGLETON=$(jq1 ".data.singleton_key !== undefined")
check "singleton_key stripped from response" "false" "$HAS_SINGLETON"

# ─── 4. PATCH /settings — auth & rbac ──────────────────────────────────────

echo ""
echo "── PATCH /settings without auth → 401 ─────────────────────────"
code=$(req PATCH /settings '{"leave_policy":{"cl_advance_notice_days":7}}')
check "no-token PATCH 401" 401 "$code"

# ─── 5. PATCH /settings — empty body rejected ──────────────────────────────

echo ""
echo "── PATCH /settings with empty body → 400 ──────────────────────"
code=$(req PATCH /settings '{}' "$ADMIN_ACCESS")
check "empty patch 400" 400 "$code"
err_code=$(jq1 .error.code)
check "VALIDATION_ERROR" "VALIDATION_ERROR" "$err_code"

# ─── 6. PATCH /settings — valid single-field update ────────────────────────

echo ""
echo "── PATCH /settings { leave_policy: { cl_advance_notice_days } } ─"
code=$(req PATCH /settings '{"leave_policy":{"cl_advance_notice_days":21}}' "$ADMIN_ACCESS")
check "patch 200" 200 "$code"
NEW_NOTICE=$(jq1 .data.leave_policy.cl_advance_notice_days)
check "value reflected" "21" "$NEW_NOTICE"

# Sibling fields in the same section must not have been wiped.
ORIG_COMP_OFF_HRS=$(jq1 .data.leave_policy.comp_off_hours_per_day)
[[ "$ORIG_COMP_OFF_HRS" == "8" ]] && pass=$((pass+1)) && echo "  \e[32mPASS\e[0m sibling leave_policy.comp_off_hours_per_day untouched (=8)" || { fail=$((fail+1)); echo "  \e[31mFAIL\e[0m sibling wiped (got $ORIG_COMP_OFF_HRS)"; }

# updated_by stamped to the admin user.
HAS_UPDATED_BY=$(jqx "typeof b.data.updated_by === 'string' && b.data.updated_by.length === 24")
check "updated_by stamped (24-char hex)" "true" "$HAS_UPDATED_BY"

# ─── 7. PATCH /settings — deep merge across nested sub-doc ────────────────

echo ""
echo "── PATCH attendance.geofence.enabled (deep merge) ─────────────"
code=$(req PATCH /settings '{"attendance":{"geofence":{"enabled":true,"center_latitude":12.97,"center_longitude":77.59}}}' "$ADMIN_ACCESS")
check "patch geofence 200" 200 "$code"
ENABLED=$(jq1 .data.attendance.geofence.enabled)
check "geofence.enabled=true" "true" "$ENABLED"
LAT=$(jq1 .data.attendance.geofence.center_latitude)
check "lat=12.97" "12.97" "$LAT"
RADIUS_UNTOUCHED=$(jq1 .data.attendance.geofence.radius_meters)
check "radius_meters preserved (=100)" "100" "$RADIUS_UNTOUCHED"
WIFI_UNTOUCHED=$(jq1 .data.attendance.wifi_restriction.enabled)
check "wifi_restriction sibling preserved (=false)" "false" "$WIFI_UNTOUCHED"

# ─── 8. PATCH /settings — arrays REPLACE, do not concatenate ───────────────

echo ""
echo "── PATCH work_schedule.working_days (array replace) ───────────"
code=$(req PATCH /settings '{"work_schedule":{"working_days":[1,2,3]}}' "$ADMIN_ACCESS")
check "patch working_days 200" 200 "$code"
LEN=$(jq1 .data.work_schedule.working_days.length)
check "working_days length=3 (replaced, not merged)" "3" "$LEN"
DAYS_CSV=$(jq1 ".data.work_schedule.working_days.join(',')")
check "working_days = 1,2,3" "1,2,3" "$DAYS_CSV"

# ─── 9. PATCH validation — bad HH:MM ───────────────────────────────────────

echo ""
echo "── PATCH bad HH:MM → 400 VALIDATION_ERROR ─────────────────────"
code=$(req PATCH /settings '{"work_schedule":{"start_time":"25:99"}}' "$ADMIN_ACCESS")
check "bad HH:MM 400" 400 "$code"
err_code=$(jq1 .error.code)
check "VALIDATION_ERROR" "VALIDATION_ERROR" "$err_code"

# ─── 10. PATCH validation — bad hex colour ─────────────────────────────────

echo ""
echo "── PATCH bad hex colour → 400 ─────────────────────────────────"
code=$(req PATCH /settings '{"company":{"primary_color":"red"}}' "$ADMIN_ACCESS")
check "bad hex 400" 400 "$code"

# ─── 11. PATCH validation — security min > max refine ──────────────────────

echo ""
echo "── PATCH security min>max → 400 (refine) ──────────────────────"
code=$(req PATCH /settings '{"security":{"password_min_length":20,"password_max_length":12}}' "$ADMIN_ACCESS")
check "min>max 400" 400 "$code"

# ─── 12. PATCH validation — bad CIDR ───────────────────────────────────────

echo ""
echo "── PATCH bad allowed_ip_ranges → 400 ──────────────────────────"
code=$(req PATCH /settings '{"attendance":{"wifi_restriction":{"allowed_ip_ranges":["not-a-cidr"]}}}' "$ADMIN_ACCESS")
check "bad CIDR 400" 400 "$code"

# ─── 13. Non-admin GET → security/email/slack redacted ─────────────────────

echo ""
echo "── Lazily create smoke employee (ignore 409 if exists) ─────────"
EMP_BODY="{\"email\":\"$EMP_EMAIL\",\"full_name\":\"Smoke Employee\",\"role\":\"employee\",\"initial_password\":\"$EMP_PASS\",\"internal_profile\":{\"employee_id\":\"SMOKE-EMP-001\",\"job_title\":\"Engineer\",\"department\":\"Eng\",\"date_of_joining\":\"2025-01-01\"}}"
code=$(req POST /users "$EMP_BODY" "$ADMIN_ACCESS")
if [[ "$code" == "201" ]]; then
    echo "  created smoke employee"
elif [[ "$code" == "409" ]]; then
    echo "  smoke employee already exists (reusing)"
else
    echo "  \e[31mFAIL\e[0m create employee unexpected code $code"
    fail=$((fail+1))
fi

EMP_ACCESS=$(login_get_token "$EMP_EMAIL" "$EMP_PASS")
[[ -n "$EMP_ACCESS" && "$EMP_ACCESS" != "undefined" ]] \
    && pass=$((pass+1)) && echo "  \e[32mPASS\e[0m employee login OK" \
    || { fail=$((fail+1)); echo "  \e[31mFAIL\e[0m employee login failed"; }

echo ""
echo "── GET /settings as employee → redacted ───────────────────────"
code=$(req GET /settings '' "$EMP_ACCESS")
check "employee GET 200" 200 "$code"
HAS_SECURITY=$(jq1 ".data.security !== undefined")
check "security HIDDEN for employee" "false" "$HAS_SECURITY"
HAS_EMAIL=$(jq1 ".data.email !== undefined")
check "email HIDDEN for employee" "false" "$HAS_EMAIL"
HAS_SLACK=$(jq1 ".data.slack !== undefined")
check "slack HIDDEN for employee" "false" "$HAS_SLACK"
# Sections employees DO need still present.
HAS_LEAVE_POLICY=$(jq1 ".data.leave_policy !== undefined")
check "leave_policy visible to employee" "true" "$HAS_LEAVE_POLICY"
HAS_WORK_SCHEDULE=$(jq1 ".data.work_schedule !== undefined")
check "work_schedule visible to employee" "true" "$HAS_WORK_SCHEDULE"
HAS_COMPANY=$(jq1 ".data.company !== undefined")
check "company visible to employee" "true" "$HAS_COMPANY"

# ─── 14. PATCH /settings as employee → 403 ─────────────────────────────────

echo ""
echo "── PATCH /settings as employee → 403 FORBIDDEN ────────────────"
code=$(req PATCH /settings '{"leave_policy":{"cl_advance_notice_days":7}}' "$EMP_ACCESS")
check "non-admin PATCH 403" 403 "$code"
err_code=$(jq1 .error.code)
check "FORBIDDEN" "FORBIDDEN" "$err_code"

# ─── 15. Restore originals so the script is idempotent ─────────────────────

echo ""
echo "── Restore originals ───────────────────────────────────────────"
RESTORE_BODY=$(node -e "
const orig = {
  leave_policy: { cl_advance_notice_days: $ORIG_CL_NOTICE },
  company:      { primary_color: '$ORIG_PRIMARY_COLOR' },
  work_schedule:{ working_days: [$ORIG_WORKING_DAYS] },
  timesheet:    { self_edit_window_days: $ORIG_TIMESHEET_WIN },
  attendance:   { geofence: { enabled: false, center_latitude: null, center_longitude: null, radius_meters: 100 } }
};
console.log(JSON.stringify(orig));
")
code=$(req PATCH /settings "$RESTORE_BODY" "$ADMIN_ACCESS")
check "restore 200" 200 "$code"
RESTORED_NOTICE=$(jq1 .data.leave_policy.cl_advance_notice_days)
check "cl_advance_notice_days restored" "$ORIG_CL_NOTICE" "$RESTORED_NOTICE"
RESTORED_DAYS=$(jq1 ".data.work_schedule.working_days.join(',')")
check "working_days restored" "$ORIG_WORKING_DAYS" "$RESTORED_DAYS"

echo ""
echo "────────────────────────────────────────────────────────────────"
printf "  \e[1m%d passed, %d failed\e[0m\n" "$pass" "$fail"
echo "────────────────────────────────────────────────────────────────"
exit $fail
