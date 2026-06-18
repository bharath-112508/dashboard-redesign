#!/usr/bin/env bash
# Master smoke runner — resets users, re-seeds the admin, then runs every
# smoke in dependency order and reports a summary.
#
# Requires:
#   - dev server running on :3001 (npm run dev)
#   - SERVER_LOG env var pointing at the dev server's stdout log
#     (only smoke-forgot-reset.sh actually reads it)
#
# Usage:
#   bash scripts/smoke-all.sh                   # full reset + run
#   bash scripts/smoke-all.sh --no-reset        # skip the user-table reset
#   SKIP_RESET=1 bash scripts/smoke-all.sh      # same, env form
#   bash scripts/smoke-all.sh smoke-auth.sh     # run only specific smokes
#
# Exit code is the sum of failures across all smokes (0 = all green).
# Compatible with bash 3.2 (macOS default) — uses parallel indexed arrays
# instead of associative arrays.

set -u

cd "$(dirname "$0")/.."

DO_RESET=1
ARGS=()
for arg in "$@"; do
    case "$arg" in
        --no-reset) DO_RESET=0 ;;
        --reset) DO_RESET=1 ;;
        *) ARGS+=("$arg") ;;
    esac
done
[[ -n "${SKIP_RESET:-}" ]] && DO_RESET=0

DEFAULT_SMOKES=(
    smoke-auth.sh
    smoke-users.sh
    smoke-mfa.sh
    smoke-forgot-reset.sh
    smoke-settings.sh
    smoke-office-locations.sh
    smoke-attendance.sh
    smoke-holidays.sh
    smoke-leaves.sh
    smoke-notifications.sh
    # Phase-2 surfaces (Step 26 exit criterion). Covers projects + sprints
    # + stories + tasks + comments AND the cross-project @mention scope.
    smoke-projects.sh
    # Phase-4 Step 47 RBAC surface — /roles CRUD + user role assignment
    # + Pattern B extra_permissions. Last in the order so it can mutate
    # the employee's role assignment without affecting earlier smokes.
    smoke-roles.sh
    # Phase-4 Step 49 — Cmd-K command-palette action catalog.
    # Read-only; no state mutation, safe to run anywhere in the order.
    smoke-command-palette.sh
    # Task 10 — dashboard analytics endpoints (admin/employee RBAC + validator).
    smoke-dashboard-analytics.sh
    # Task 8 — attendance break endpoints (break/start, break/end, error codes).
    smoke-attendance-breaks.sh
)

if [[ ${#ARGS[@]} -gt 0 ]]; then
    SMOKES=("${ARGS[@]}")
else
    SMOKES=("${DEFAULT_SMOKES[@]}")
fi

# Parallel array — RESULTS[i] holds the outcome label for SMOKES[i].
RESULTS=()

API=http://localhost:3001/api/v1

echo "════════════════════════════════════════════════════════════════"
echo "  Viljetech backend smoke runner"
echo "════════════════════════════════════════════════════════════════"
echo "  smokes: ${SMOKES[*]}"
echo "  reset?  $([[ $DO_RESET == 1 ]] && echo yes || echo no)"
echo ""

if ! curl -fsS -o /dev/null "http://localhost:3001/health" 2>/dev/null; then
    printf "  \033[31mERROR\033[0m dev server not responding on http://localhost:3001/health\n"
    printf "          Run: cd viljetech-platform-backend && npm run dev\n"
    exit 2
fi

# Decide up front whether smoke-forgot-reset.sh can run in this environment.
# It needs to scrape the dev-server log for the reset URL printed by the
# mailer stub. If SERVER_LOG isn't set, isn't readable, or doesn't contain
# any recent /auth activity, mark the smoke as SKIP rather than letting it
# fail noisily on every CI run with a misconfigured log path.
FORGOT_RESET_RUNNABLE=1
FORGOT_RESET_SKIP_REASON=""
if [[ -z "${SERVER_LOG:-}" ]]; then
    FORGOT_RESET_RUNNABLE=0
    FORGOT_RESET_SKIP_REASON="SERVER_LOG not set"
elif [[ ! -r "${SERVER_LOG}" ]]; then
    FORGOT_RESET_RUNNABLE=0
    FORGOT_RESET_SKIP_REASON="SERVER_LOG '${SERVER_LOG}' not readable"
elif ! tail -n 4000 "${SERVER_LOG}" 2>/dev/null | grep -q '/auth/'; then
    FORGOT_RESET_RUNNABLE=0
    FORGOT_RESET_SKIP_REASON="SERVER_LOG has no recent /auth/ activity (orphaned dev server?)"
else
    # Canary probe: fire one /auth/forgot-password and wait briefly; if the
    # dev server doesn't append a fresh "Reset URL" to SERVER_LOG, the env var
    # is pointing at a stale/unrelated file and the smoke can't extract a
    # token from it. Skip cleanly instead of failing the master suite.
    canary_before=$(wc -l <"${SERVER_LOG}" 2>/dev/null || echo 0)
    curl -fsS -o /dev/null -X POST "${API}/auth/forgot-password" \
        -H 'Content-Type: application/json' \
        -d '{"email":"smoke-canary@example.com"}' >/dev/null 2>&1 || true
    sleep 1
    canary_after=$(wc -l <"${SERVER_LOG}" 2>/dev/null || echo 0)
    if ! tail -n $(( canary_after - canary_before + 5 )) "${SERVER_LOG}" 2>/dev/null \
        | grep -qE 'Reset URL|reset_url|smoke-canary'; then
        FORGOT_RESET_RUNNABLE=0
        FORGOT_RESET_SKIP_REASON="canary forgot-password didn't appear in SERVER_LOG (dev server logging elsewhere?)"
    fi
fi

if [[ $DO_RESET == 1 ]]; then
    echo "── Resetting users + tokens ──────────────────────────────────"
    npx tsx scripts/smoke-reset-users.ts || { printf "  \033[31mreset failed\033[0m\n"; exit 2; }
    echo "── Re-seeding admin ──────────────────────────────────────────"
    npx tsx scripts/smoke-seed-user.ts || { printf "  \033[31mseed failed\033[0m\n"; exit 2; }
    echo ""
fi

total_fail=0

for smoke in "${SMOKES[@]}"; do
    if [[ ! -x "scripts/$smoke" ]]; then
        printf "\033[33mSKIP\033[0m %s — not executable / not found\n" "$smoke"
        RESULTS+=("SKIP")
        continue
    fi

    if [[ "$smoke" == "smoke-forgot-reset.sh" && $FORGOT_RESET_RUNNABLE -eq 0 ]]; then
        echo ""
        echo "════════════════════════════════════════════════════════════════"
        printf "  Skipping %s\n" "$smoke"
        printf "    reason: %s\n" "$FORGOT_RESET_SKIP_REASON"
        printf "    fix:    export SERVER_LOG=/path/to/dev-server.log and rerun\n"
        echo "════════════════════════════════════════════════════════════════"
        RESULTS+=("SKIP")
        continue
    fi

    echo ""
    echo "════════════════════════════════════════════════════════════════"
    printf "  Running %s\n" "$smoke"
    echo "════════════════════════════════════════════════════════════════"

    # Run, capture exit code (suite-level fail count).
    bash "scripts/$smoke"
    rc=$?

    if [[ $rc -eq 0 ]]; then
        RESULTS+=("PASS")
    else
        RESULTS+=("FAIL($rc)")
        total_fail=$((total_fail + rc))
    fi
done

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Summary"
echo "════════════════════════════════════════════════════════════════"
i=0
while [[ $i -lt ${#SMOKES[@]} ]]; do
    smoke="${SMOKES[$i]}"
    result="${RESULTS[$i]}"
    case "$result" in
        PASS)    printf "  \033[32m%-8s\033[0m %s\n" "$result" "$smoke" ;;
        SKIP)    printf "  \033[33m%-8s\033[0m %s\n" "$result" "$smoke" ;;
        *)       printf "  \033[31m%-8s\033[0m %s\n" "$result" "$smoke" ;;
    esac
    i=$((i + 1))
done
echo "════════════════════════════════════════════════════════════════"

if [[ $total_fail -eq 0 ]]; then
    printf "  \033[32m\033[1mALL GREEN\033[0m\n"
else
    printf "  \033[31m\033[1m%d total assertion failures across smokes\033[0m\n" "$total_fail"
fi
echo ""

exit $total_fail
