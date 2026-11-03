#!/usr/bin/env bash
# End-to-end smoke test against an API that is already running (npm run dev, or docker compose up).
# Creates a snippet, reviews it with whatever LLM_PROVIDER the API uses, prints the findings,
# accepts the first one and checks the decision survives a fresh fetch.
#
#   scripts/smoke.sh                                  # http://localhost:4000/api/v1
#   API_URL=http://localhost:4001/api/v1 scripts/smoke.sh
#   POLL_TIMEOUT_SECONDS=300 scripts/smoke.sh         # a slow model
#
# Needs curl and node. Exits non-zero, with the reason, on the first thing that goes wrong.
set -euo pipefail

API_URL="${API_URL:-http://localhost:4000/api/v1}"
API_URL="${API_URL%/}"
POLL_TIMEOUT_SECONDS="${POLL_TIMEOUT_SECONDS:-180}"
POLL_INTERVAL_SECONDS=2

TMP_BODY="$(mktemp)"
trap 'rm -f "$TMP_BODY"' EXIT

fail() {
  echo "SMOKE FAILED: $*" >&2
  exit 1
}

command -v curl >/dev/null || fail "curl is not installed"
command -v node >/dev/null || fail "node is not installed"

# request METHOD PATH [JSON_BODY] -> sets STATUS and BODY
request() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-sS -X "$method" -o "$TMP_BODY" -w '%{http_code}' -H 'Accept: application/json' --max-time 30)
  if [[ -n "$data" ]]; then
    args+=(-H 'Content-Type: application/json' --data "$data")
  fi
  if ! STATUS="$(curl "${args[@]}" "$API_URL$path")"; then
    fail "could not reach $API_URL$path. Is the API running? (override the address with API_URL)"
  fi
  BODY="$(cat "$TMP_BODY")"
}

# expect_status CODE WHAT -> fails with the response body unless STATUS is CODE
expect_status() {
  [[ "$STATUS" == "$1" ]] || fail "$2: expected HTTP $1, got $STATUS. Body: $BODY"
}

# json EXPR -> evaluates a JS expression over the parsed BODY (as `j`) and prints the result.
# Strings print bare, everything else as JSON; undefined/null print as an empty line.
json() {
  printf '%s' "$BODY" | node -e '
    let s = "";
    process.stdin.on("data", (c) => (s += c)).on("end", () => {
      let j;
      try { j = JSON.parse(s); } catch (e) { console.error("response is not JSON: " + s.slice(0, 300)); process.exit(2); }
      const v = new Function("j", "return (" + process.argv[1] + ");")(j);
      if (v === undefined || v === null) console.log("");
      else console.log(typeof v === "string" ? v : JSON.stringify(v));
    });
  ' "$1"
}

echo "API: $API_URL"

request GET /health
expect_status 200 "health check"
echo "health: $(json 'j.message') (db $(json 'j.data && j.data.db'))"

# 1. Create a snippet with a couple of real problems in it.
SNIPPET_JSON="$(node -e '
  const code = [
    "function findUser(db, name) {",
    "  const sql = \"SELECT * FROM users WHERE name = '\''\" + name + \"'\''\";",
    "  const rows = db.query(sql);",
    "  for (var i = 0; i <= rows.length; i++) {",
    "    if (rows[i].name == name) return rows[i];",
    "  }",
    "}",
  ].join("\n");
  console.log(JSON.stringify({ title: "Smoke test " + new Date().toISOString(), language: "javascript", code }));
')"
request POST /snippets "$SNIPPET_JSON"
expect_status 201 "create snippet"
SNIPPET_ID="$(json 'j.data.id')"
[[ -n "$SNIPPET_ID" ]] || fail "create snippet: no id in $BODY"
echo "created snippet $SNIPPET_ID"

# 2. Start a review.
request POST "/snippets/$SNIPPET_ID/reviews"
expect_status 202 "start review"
REVIEW_ID="$(json 'j.data.id')"
[[ -n "$REVIEW_ID" ]] || fail "start review: no id in $BODY"
echo "started review $REVIEW_ID (provider: $(json 'j.data.provider'))"

# 3. Poll until done or failed, like the web client does.
deadline=$(( $(date +%s) + POLL_TIMEOUT_SECONDS ))
while :; do
  request GET "/reviews/$REVIEW_ID"
  expect_status 200 "get review"
  REVIEW_STATUS="$(json 'j.data.status')"
  case "$REVIEW_STATUS" in
    done) break ;;
    failed) fail "review $REVIEW_ID failed: $(json 'j.data.error')" ;;
    pending|running) ;;
    *) fail "review $REVIEW_ID has unexpected status '$REVIEW_STATUS'" ;;
  esac
  if (( $(date +%s) >= deadline )); then
    fail "review $REVIEW_ID still $REVIEW_STATUS after ${POLL_TIMEOUT_SECONDS}s"
  fi
  echo "  review is $REVIEW_STATUS..."
  sleep "$POLL_INTERVAL_SECONDS"
done

# 4. Print the findings.
COUNT="$(json 'j.data.findings.length')"
echo "review done: $COUNT finding(s), $(json 'j.data.rejectedCount') rejected"
json 'j.data.findings.map((f) => `  [${f.severity}/${f.category}] lines ${f.lineStart}-${f.lineEnd}: ${f.description}` + (f.suggestedFix ? `\n      fix: ${f.suggestedFix}` : "")).join("\n")'

# 5. Accept the first finding and confirm it stuck.
if [[ "$COUNT" == "0" ]]; then
  echo "no findings to accept; skipping the accept check"
else
  FINDING_ID="$(json 'j.data.findings[0].id')"
  request PATCH "/findings/$FINDING_ID" '{"status":"accepted"}'
  expect_status 200 "accept finding $FINDING_ID"
  [[ "$(json 'j.data.status')" == "accepted" ]] || fail "accept finding $FINDING_ID: response says $(json 'j.data.status')"
  echo "accepted finding $FINDING_ID"
fi

request GET "/snippets/$SNIPPET_ID"
expect_status 200 "fetch snippet again"
[[ "$(json 'j.data.reviewStatus')" == "reviewed" ]] || fail "snippet $SNIPPET_ID reviewStatus is $(json 'j.data.reviewStatus'), expected reviewed"
[[ "$(json 'j.data.latestReview && j.data.latestReview.id')" == "$REVIEW_ID" ]] || fail "snippet $SNIPPET_ID latestReview is not review $REVIEW_ID"
if [[ "$COUNT" != "0" ]]; then
  STORED="$(json "(j.data.latestReview.findings.find((f) => f.id === $FINDING_ID) || {}).status")"
  [[ "$STORED" == "accepted" ]] || fail "finding $FINDING_ID reads back as '$STORED' after a fresh fetch, expected accepted"
  echo "finding $FINDING_ID is still accepted after a fresh fetch"
fi

echo "SMOKE OK: snippet $SNIPPET_ID, review $REVIEW_ID"
