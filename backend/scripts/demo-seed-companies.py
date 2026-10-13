#!/usr/bin/env python3
"""
Add demo projects + representatives and cross-assign them.

Everything goes through the HTTP API rather than direct Mongo writes, so the
roster invariant (a representative must be an ACTIVE client-side user of THIS
project's company) is genuinely exercised — that rule is the interesting part
of the model, and a direct DB insert would bypass it.

Re-runnable: existing project codes / emails are skipped rather than failing.
"""
import json
import urllib.request
import urllib.error

BASE = "http://localhost:3001/api/v1"
ADMIN = {"email": "admin@viljetech.com", "password": "Vilje@1234"}
PW = "Vilje@1234"


def call(method, path, token=None, body=None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data) as r:
            return r.status, json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or "{}")
        except Exception:
            return e.code, {"raw": raw.decode()[:200]}


status, res = call("POST", "/auth/login", body=ADMIN)
assert status == 200, (status, res)
tok = res["data"]["access_token"]

_, res = call("GET", "/companies?limit=50", tok)
companies = {c["name"]: c["id"] for c in res["data"]}
print("companies:", ", ".join(companies))

NORD = companies["Nordmark Logistics AS"]
AURO = companies["Aurora Foods AB"]

# ── Projects ────────────────────────────────────────────────────────────
PROJECTS = [
    ("Depot Rollout 2026",        "DEP",  NORD, "Phased rollout of depot scanning hardware across 14 sites."),
    ("Driver Mobile App",         "DRV",  NORD, "Native companion app for drivers — routes, PODs, breaks."),
    ("Cold Chain Telemetry",      "COLD", NORD, "Temperature telemetry and breach alerting for reefer units."),
    ("Supplier Portal v2",        "SUP2", AURO, "Refresh of the supplier onboarding and invoicing portal."),
    ("Retail Demand Forecasting", "FCST", AURO, "Weekly SKU-level demand forecasts for retail partners."),
]

_, res = call("GET", "/projects?limit=100", tok)
have = {p["code"] for p in res["data"]}
project_ids = {p["code"]: p["id"] for p in res["data"]}

for name, code, company, desc in PROJECTS:
    if code in have:
        print(f"  = project {code} exists")
        continue
    st, r = call("POST", "/projects", tok, {
        "name": name, "code": code, "description": desc,
        "start_date": "2026-02-02", "company_id": company,
    })
    if st == 201:
        project_ids[code] = r["data"]["id"]
        print(f"  + project {code:5} {name}")
    else:
        print(f"  ! project {code}: {st} {r}")

# ── Representatives ─────────────────────────────────────────────────────
REPS = [
    ("Ingrid Solberg",  "ingrid@nordmark.example",  NORD),
    ("Lars Vestby",     "lars@nordmark.example",    NORD),
    ("Marit Haugen",    "marit@nordmark.example",   NORD),
    ("Johan Lindqvist", "johan@aurorafoods.example", AURO),
    ("Elin Sandberg",   "elin@aurorafoods.example",  AURO),
]

people = {}
for company in (NORD, AURO):
    _, r = call("GET", f"/companies/{company}/representatives", tok)
    for p in r["data"]:
        people[p["email"]] = p["id"]

for full_name, email, company in REPS:
    if email in people:
        print(f"  = rep {email} exists")
        continue
    st, r = call("POST", f"/companies/{company}/representatives", tok, {
        "full_name": full_name, "email": email, "initial_password": PW,
    })
    if st == 201:
        people[email] = r["data"]["id"]
        print(f"  + rep {full_name} <{email}>")
    else:
        print(f"  ! rep {email}: {st} {r}")

# ── Assignments — deliberately uneven ───────────────────────────────────
# Ingrid spans 3 projects, Lars 2, Marit 1, Elin 0 (never assigned) so the
# UI is exercised across the whole range including the empty case.
ASSIGN = {
    "NFD":  ["ingrid@nordmark.example", "lars@nordmark.example"],
    "DEP":  ["ingrid@nordmark.example", "lars@nordmark.example", "marit@nordmark.example"],
    "DRV":  ["ingrid@nordmark.example"],
    "COLD": [],
    "AFS":  ["johan@aurorafoods.example"],
    "SUP2": ["johan@aurorafoods.example"],
}

print("\nassignments:")
for code, emails in ASSIGN.items():
    pid = project_ids.get(code)
    if not pid or not emails:
        continue
    ids = [people[e] for e in emails if e in people]
    st, r = call("POST", f"/projects/{pid}/representatives", tok, {"add": ids})
    print(f"  {'+' if st in (200, 201) else '!'} {code:5} <- {len(ids)} rep(s) [{st}]")
    if st not in (200, 201):
        print("     ", r)

# ── Negative check: the roster invariant must still hold ────────────────
# Aurora's Johan onto a Nordmark project should be REFUSED. If this ever
# succeeds, company isolation is broken.
cross = call("POST", f"/projects/{project_ids['NFD']}/representatives", tok,
             {"add": [people["johan@aurorafoods.example"]]})
print(f"\ncross-company roster attempt (Aurora rep -> Nordmark project): HTTP {cross[0]}")
print("  ", json.dumps(cross[1])[:180])
