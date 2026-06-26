#!/usr/bin/env bash
#
# Slackbot integration tests — sends signed Slack webhook payloads to the
# running slackbot service and verifies responses.
#
# Usage:
#   ./integration-slackbot.sh                          # defaults: slackbot at localhost:3001
#   SLACKBOT_URL=http://slackbot:3001 ./integration-slackbot.sh  # inside docker network
#   SMOKE_CHART_UPLOAD=1 ./integration-slackbot.sh      # opt into live LLM/tool chart smoke
#   SMOKE_GENERATED_MEDIA_UPLOAD=1 ./integration-slackbot.sh  # opt into live generated MP4 smoke
#
# Live upload smokes are skipped by default. They require live Slack credentials,
# a bot-accessible Slack channel, and a local stack that can run sandbox turns.
# The generated-media smoke additionally needs a freshly built sandbox image with
# ffmpeg and the slack-upload helper installed.
#
# Requires:  SLACK_SIGNING_SECRET in env (or sourced from .env).
#            A bot-accessible Slack channel for live smoke replies.
#            jq, curl, and openssl on PATH.
#            The slackbot service must be running.

set -euo pipefail

SLACKBOT_URL="${SLACKBOT_URL:-http://localhost:3001}"
ENDPOINT="${SLACKBOT_URL}/api/slack/events"
API_URL="${API_URL:-http://localhost:8000}"
ENV_FILE="${ENV_FILE:-.env}"
SLACK_SMOKE_CHANNEL="${SLACK_SMOKE_CHANNEL:-}"
SLACK_SMOKE_CHANNEL_NAME="${SLACK_SMOKE_CHANNEL_NAME:-eng-testing}"
SLACK_SMOKE_USER_ID="${SLACK_SMOKE_USER_ID:-}"
SLACK_SMOKE_TEAM_ID="${SLACK_SMOKE_TEAM_ID:-}"
SMOKE_POLL_ATTEMPTS="${SMOKE_POLL_ATTEMPTS:-30}"
SMOKE_POLL_SLEEP_SECONDS="${SMOKE_POLL_SLEEP_SECONDS:-2}"
EVENT_STREAM_TIMEOUT_SECONDS="${EVENT_STREAM_TIMEOUT_SECONDS:-120}"
SMOKE_CHART_UPLOAD="${SMOKE_CHART_UPLOAD:-0}"
SMOKE_GENERATED_MEDIA_UPLOAD="${SMOKE_GENERATED_MEDIA_UPLOAD:-0}"

# ── Load .env values when present ────────────────────────────────────────────

load_env_value() {
  local key="$1"
  if [[ -n "${!key:-}" || ! -f "$ENV_FILE" ]]; then
    return
  fi

  local value
  value=$(grep -E "^${key}=" "$ENV_FILE" | head -1 | cut -d= -f2- || true)
  if [[ -n "$value" ]]; then
    printf -v "$key" '%s' "$value"
  fi
}

load_env_value "SLACK_SIGNING_SECRET"
load_env_value "SLACKBOT_API_KEY"
load_env_value "API_SECRET_KEY"
load_env_value "SLACK_SMOKE_CHANNEL"
load_env_value "SLACK_SMOKE_CHANNEL_NAME"
load_env_value "SLACK_SMOKE_USER_ID"
load_env_value "SLACK_SMOKE_TEAM_ID"

if [[ -z "${SLACK_SIGNING_SECRET:-}" ]]; then
  echo "FATAL: SLACK_SIGNING_SECRET not set. Export it or add to .env."
  exit 1
fi

API_KEY="${CENTAUR_API_KEY:-${SLACKBOT_API_KEY:-${API_SECRET_KEY:-}}}"
AUTH_ARGS=()
if [[ -n "$API_KEY" ]]; then
  AUTH_ARGS=(-H "Authorization: Bearer ${API_KEY}")
fi

# ── Helpers ──────────────────────────────────────────────────────────────────

passed=0
failed=0
total=0

run_check() {
  local desc="$1"
  shift

  total=$((total + 1))
  if "$@"; then
    passed=$((passed + 1))
    echo "  ✓ ${desc}"
  else
    failed=$((failed + 1))
    echo "  ✗ ${desc}"
  fi
}

slack_ts() {
  local raw
  raw=$(date +%s.%N)
  printf '%s\n' "${raw:0:17}"
}

urlencode() {
  jq -rn --arg value "$1" '$value|@uri'
}

api_request() {
  local method="$1"
  local url="$2"
  local body="${3:-}"
  local response_file
  response_file=$(mktemp)

  local http_code
  if [[ -n "$body" ]]; then
    http_code=$(curl -sS -o "$response_file" -w "%{http_code}" \
      -X "$method" "$url" \
      "${AUTH_ARGS[@]}" \
      -H "Content-Type: application/json" \
      -d "$body")
  else
    http_code=$(curl -sS -o "$response_file" -w "%{http_code}" \
      -X "$method" "$url" \
      "${AUTH_ARGS[@]}" \
      -H "Content-Type: application/json")
  fi

  if [[ "${http_code:0:1}" != "2" ]]; then
    echo "    API request failed (${http_code}) → ${url}"
    sed -n '1,8p' "$response_file" | sed 's/^/    /'
    rm -f "$response_file"
    return 1
  fi

  cat "$response_file"
  rm -f "$response_file"
}

slack_tool_json() {
  local method="$1"
  local body="${2:-{}}"
  api_request POST "${API_URL}/tools/slack/${method}" "$body" | jq -c '.result'
}

resolve_smoke_channel() {
  if [[ -n "$SLACK_SMOKE_CHANNEL" ]]; then
    printf '%s\n' "$SLACK_SMOKE_CHANNEL"
    return 0
  fi

  local channels_json
  channels_json=$(slack_tool_json list_bot_channels '{"include_private":true,"limit":200}') || return 1

  local channel_id
  channel_id=$(jq -r --arg channel_name "$SLACK_SMOKE_CHANNEL_NAME" '
    map(select(.name == $channel_name)) | .[0].id // empty
  ' <<<"$channels_json")

  if [[ -z "$channel_id" ]]; then
    echo "    Could not find a bot-accessible smoke channel named '${SLACK_SMOKE_CHANNEL_NAME}'."
    echo "    Set SLACK_SMOKE_CHANNEL=<channel-id-or-name> to override."
    return 1
  fi

  printf '%s\n' "$channel_id"
}

resolve_smoke_user() {
  local channel="$1"

  if [[ -n "$SLACK_SMOKE_USER_ID" ]]; then
    printf '%s\n' "$SLACK_SMOKE_USER_ID"
    return 0
  fi

  local members_json
  local users_json
  members_json=$(slack_tool_json get_channel_members "$(jq -nc --arg channel "$channel" '{channel:$channel}')") || return 1
  users_json=$(slack_tool_json list_users '{"limit":500}') || return 1

  local user_id
  user_id=$(jq -r --argjson members "$members_json" --argjson users "$users_json" '
    [ $members[]
      | .id as $member_id
      | select(any($users[]; .id == $member_id and .is_bot == false))
      | $member_id
    ][0] // empty
  ' <<<"null")

  if [[ -z "$user_id" ]]; then
    echo "    Could not find a non-bot member for smoke replies in ${channel}."
    echo "    Set SLACK_SMOKE_USER_ID=<real-user-id> to override."
    return 1
  fi

  printf '%s\n' "$user_id"
}

build_event_body() {
  local event_type="$1"
  local text="$2"
  local channel="$3"
  local thread_ts="$4"
  local event_ts="$5"
  local files_json="${6:-[]}"

  jq -nc \
    --arg event_type "$event_type" \
    --arg user "$SMOKE_USER_ID" \
    --arg text "$text" \
    --arg channel "$channel" \
    --arg thread_ts "$thread_ts" \
    --arg ts "$event_ts" \
    --arg team_id "$SLACK_SMOKE_TEAM_ID" \
    --argjson files "$files_json" '
      {
        type: "event_callback"
      }
      + (if $team_id != "" then {team_id: $team_id} else {} end)
      + {
        event: (
          {
            type: $event_type,
            user: $user,
            text: $text,
            ts: $ts,
            channel: $channel,
            thread_ts: $thread_ts
          }
          + (if $team_id != "" then {team_id: $team_id} else {} end)
          + (if ($files | length) > 0 then {files: $files} else {} end)
        )
      }
    '
}

send_signed_event() {
  local body="$1"
  local expect_status="${2:-200}"

  local ts
  ts=$(date +%s)
  local sig_base="v0:${ts}:${body}"
  local hmac
  hmac=$(printf '%s' "$sig_base" | openssl dgst -sha256 -hmac "$SLACK_SIGNING_SECRET" | awk '{print $NF}')
  local signature="v0=${hmac}"

  local response_file
  response_file=$(mktemp)
  local http_code
  http_code=$(curl -sS -o "$response_file" -w "%{http_code}" \
    -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -H "x-slack-signature: $signature" \
    -H "x-slack-request-timestamp: $ts" \
    -d "$body")

  if [[ "$http_code" == "$expect_status" ]]; then
    rm -f "$response_file"
    return 0
  fi

  echo "    webhook expected ${expect_status}, got ${http_code}"
  sed -n '1,8p' "$response_file" | sed 's/^/    /'
  rm -f "$response_file"
  return 1
}

send_bad_sig() {
  local body="$1"
  local expect_status="${2:-401}"

  local ts
  ts=$(date +%s)

  local response_file
  response_file=$(mktemp)
  local http_code
  http_code=$(curl -sS -o "$response_file" -w "%{http_code}" \
    -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -H "x-slack-signature: v0=deadbeef" \
    -H "x-slack-request-timestamp: $ts" \
    -d "$body")

  if [[ "$http_code" == "$expect_status" ]]; then
    rm -f "$response_file"
    return 0
  fi

  echo "    bad signature expected ${expect_status}, got ${http_code}"
  sed -n '1,8p' "$response_file" | sed 's/^/    /'
  rm -f "$response_file"
  return 1
}

create_seed_thread() {
  local label="$1"
  slack_tool_json send_message "$(jq -nc \
    --arg channel "$SMOKE_CHANNEL_ID" \
    --arg text "[slackbot smoke] ${label} ($(date -u +%Y-%m-%dT%H:%M:%SZ))" \
    '{channel:$channel,text:$text,no_attribution:true}')"
}

wait_for_thread_reply() {
  local channel="$1"
  local thread_ts="$2"

  for _ in $(seq 1 "$SMOKE_POLL_ATTEMPTS"); do
    local replies_json
    replies_json=$(slack_tool_json get_thread_replies "$(jq -nc \
      --arg channel "$channel" \
      --arg thread_ts "$thread_ts" \
      '{channel_id:$channel,thread_ts:$thread_ts,limit:50}')") || return 1

    local reply_count
    reply_count=$(jq 'length - 1' <<<"$replies_json")
    if (( reply_count > 0 )); then
      local reply_text
      reply_text=$(jq -r '.[1:] | map(.text // "") | join("\n")' <<<"$replies_json")
      if grep -Fq 'Unauthorized Check your access token.' <<<"$reply_text"; then
        echo "    thread reply contained raw unauthorized text"
        return 1
      fi
      printf '%s\n' "$replies_json"
      return 0
    fi

    sleep "$SMOKE_POLL_SLEEP_SECONDS"
  done

  echo "    timed out waiting for a persisted Slack reply in ${channel}:${thread_ts}"
  return 1
}

wait_for_execution_id() {
  local thread_key="$1"
  local encoded_thread
  encoded_thread=$(urlencode "$thread_key")

  for _ in $(seq 1 "$SMOKE_POLL_ATTEMPTS"); do
    local executions_json
    executions_json=$(api_request GET "${API_URL}/agent/threads/${encoded_thread}/executions?limit=1") || return 1

    local execution_id
    execution_id=$(jq -r '.executions[0].execution_id // empty' <<<"$executions_json")
    if [[ -n "$execution_id" ]]; then
      printf '%s\n' "$execution_id"
      return 0
    fi

    sleep "$SMOKE_POLL_SLEEP_SECONDS"
  done

  echo "    timed out waiting for an execution for ${thread_key}"
  return 1
}

capture_execution_events() {
  local thread_key="$1"
  local execution_id="$2"
  local out_file="$3"
  local encoded_thread
  encoded_thread=$(urlencode "$thread_key")

  local curl_status
  set +e
  curl -sS -N --max-time "$EVENT_STREAM_TIMEOUT_SECONDS" \
    "${AUTH_ARGS[@]}" \
    "${API_URL}/agent/threads/${encoded_thread}/events?execution_id=${execution_id}&poll_ms=1000" \
    > "$out_file"
  curl_status=$?
  set -e

  # curl exits 28 when --max-time closes an otherwise healthy SSE stream.
  if [[ "$curl_status" -ne 0 && "$curl_status" -ne 28 ]]; then
    echo "    execution event stream failed with curl status ${curl_status}"
    return 1
  fi
  if [[ ! -s "$out_file" ]]; then
    echo "    execution event stream produced no events"
    return 1
  fi
}

sse_data_json() {
  local events_file="$1"
  jq -Rrc '
    select(startswith("data:"))
    | sub("^data:[[:space:]]*"; "")
    | fromjson?
    | select(type == "object")
  ' "$events_file"
}

execution_terminal_text() {
  local events_file="$1"
  sse_data_json "$events_file" | jq -s -r '
    [
      .[]
      | if .type == "turn.done" then
          (.result?, .error?)
        elif .type == "execution.state" then
          (.result_text?, .error_text?)
        elif .type == "result" then
          (.result?, .text?)
        elif .type == "assistant" and (.message.content? | type) == "array" then
          (.message.content[]? | select(.type == "text") | .text?)
        else
          empty
        end
      | strings
    ]
    | join("\n")
  '
}

assert_execution_upload_stream() {
  local thread_key="$1"
  local require_permalink="${2:-1}"

  local execution_id
  execution_id=$(wait_for_execution_id "$thread_key") || return 1

  local events_file
  events_file=$(mktemp)
  capture_execution_events "$thread_key" "$execution_id" "$events_file" || {
    echo "    failed to capture execution events for ${execution_id}"
    rm -f "$events_file"
    return 1
  }

  local auth_error
  auth_error=$(sse_data_json "$events_file" | jq -s -r '
    [
      .[]
      | .. | strings
      | select(test("HTTP Error 401: Unauthorized|Unauthorized Check your access token\\."; "i"))
    ][0] // empty
  ')
  if [[ -n "$auth_error" ]]; then
    echo "    execution stream recorded an auth error during slack.upload_file: ${auth_error}"
    rm -f "$events_file"
    return 1
  fi

  local terminal_text
  terminal_text=$(execution_terminal_text "$events_file")
  if jq -en --arg text "$terminal_text" '$text | test("file:///")' >/dev/null; then
    echo "    terminal assistant output fell back to file:/// output instead of a Slack upload"
    rm -f "$events_file"
    return 1
  fi

  if [[ "$require_permalink" == "1" ]]; then
    if ! sse_data_json "$events_file" | jq -es --arg terminal_text "$terminal_text" '
      any(.[]; [.. | strings | select(test("https://slack\\.com/"))] | length > 0)
      or ($terminal_text | test("https://slack\\.com/"))
    ' >/dev/null; then
      echo "    execution stream never recorded a successful Slack upload permalink"
      rm -f "$events_file"
      return 1
    fi
  fi

  rm -f "$events_file"
}

wait_for_uploaded_reply() {
  local channel="$1"
  local thread_ts="$2"
  local filename_regex="${3:-.*}"
  local mimetype_regex="${4:-.*}"

  for _ in $(seq 1 "$SMOKE_POLL_ATTEMPTS"); do
    local replies_json
    replies_json=$(slack_tool_json get_thread_replies "$(jq -nc \
      --arg channel "$channel" \
      --arg thread_ts "$thread_ts" \
      '{channel_id:$channel,thread_ts:$thread_ts,limit:50}')") || return 1

    while IFS=$'\t' read -r reply_ts reply_permalink; do
      [[ -z "$reply_ts" ]] && continue
      [[ "$reply_permalink" != https://slack.com/archives/* ]] && continue
      local files_json
      files_json=$(slack_tool_json get_message_files "$(jq -nc \
        --arg channel "$channel" \
        --arg message_ts "$reply_ts" \
        '{channel_id:$channel,message_ts:$message_ts}')") || return 1

      if jq -e \
        --arg filename_regex "$filename_regex" \
        --arg mimetype_regex "$mimetype_regex" '
          length > 0
          and all(.[]; (.url_private // "") | startswith("https://"))
          and any(.[];
            ((.name // "") | test($filename_regex))
            and ((.mimetype // "") | test($mimetype_regex))
          )
        ' <<<"$files_json" >/dev/null; then
        printf '%s\n' "$reply_permalink"
        return 0
      fi
    done < <(jq -r '.[1:][] | [.timestamp,.permalink] | @tsv' <<<"$replies_json")

    sleep "$SMOKE_POLL_SLEEP_SECONDS"
  done

  echo "    timed out waiting for a Slack reply with an uploaded file matching ${filename_regex} ${mimetype_regex} in ${channel}:${thread_ts}"
  return 1
}

smoke_app_mention_case() {
  local label="$1"
  local text="$2"
  local files_json="${3:-[]}"

  local seed_json
  seed_json=$(create_seed_thread "$label") || return 1

  local channel
  local thread_ts
  channel=$(jq -r '.channel' <<<"$seed_json")
  thread_ts=$(jq -r '.ts' <<<"$seed_json")

  local body
  body=$(build_event_body "app_mention" "$text" "$channel" "$thread_ts" "$(slack_ts)" "$files_json")
  send_signed_event "$body" 200 || return 1

  wait_for_thread_reply "$channel" "$thread_ts" >/dev/null
}

smoke_subscribed_thread_case() {
  local seed_json
  seed_json=$(create_seed_thread "subscribed-thread") || return 1

  local channel
  local thread_ts
  channel=$(jq -r '.channel' <<<"$seed_json")
  thread_ts=$(jq -r '.ts' <<<"$seed_json")

  local mention_body
  mention_body=$(build_event_body "app_mention" "prime this thread for follow-ups" "$channel" "$thread_ts" "$(slack_ts)")
  send_signed_event "$mention_body" 200 || return 1
  wait_for_thread_reply "$channel" "$thread_ts" >/dev/null || return 1

  local followup_body
  followup_body=$(build_event_body "message" "here is more context" "$channel" "$thread_ts" "$(slack_ts)")
  send_signed_event "$followup_body" 200 || return 1

  local followup_file_body
  followup_file_body=$(build_event_body "message" "" "$channel" "$thread_ts" "$(slack_ts)" '[
    {
      "id": "F_THREAD_IMG",
      "name": "followup.png",
      "mimetype": "image/png",
      "url_private": "https://files.slack.com/test/followup.png",
      "size": 30000
    }
  ]')
  send_signed_event "$followup_file_body" 200 || return 1
}

smoke_chart_case() {
  local seed_json
  seed_json=$(create_seed_thread "inline-chart") || return 1

  local channel
  local thread_ts
  channel=$(jq -r '.channel' <<<"$seed_json")
  thread_ts=$(jq -r '.ts' <<<"$seed_json")
  local thread_key="${channel}:${thread_ts}"

  local chart_body
  chart_body=$(build_event_body \
    "app_mention" \
    "Create a simple PNG line chart from these values and upload it inline in this thread: 2026-01-01=1, 2026-01-02=2, 2026-01-03=3." \
    "$channel" \
    "$thread_ts" \
    "$(slack_ts)")
  send_signed_event "$chart_body" 200 || return 1

  wait_for_thread_reply "$channel" "$thread_ts" >/dev/null || return 1

  assert_execution_upload_stream "$thread_key" 1 || return 1

  wait_for_uploaded_reply "$channel" "$thread_ts" >/dev/null
}

smoke_generated_media_case() {
  local seed_json
  seed_json=$(create_seed_thread "generated-media") || return 1

  local channel
  local thread_ts
  channel=$(jq -r '.channel' <<<"$seed_json")
  thread_ts=$(jq -r '.ts' <<<"$seed_json")
  local thread_key="${channel}:${thread_ts}"

  local media_body
  media_body=$(build_event_body \
    "app_mention" \
    "Create a 1-second silent MP4 named generated-media-smoke.mp4 in the sandbox using ffmpeg, then upload it back into this thread with the slack-upload helper. Use this command if helpful: ffmpeg -y -f lavfi -i color=c=black:s=320x240:d=1 -f lavfi -i anullsrc=r=44100:cl=stereo -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac generated-media-smoke.mp4. Reply only after the upload succeeds and include the Slack permalink." \
    "$channel" \
    "$thread_ts" \
    "$(slack_ts)")
  send_signed_event "$media_body" 200 || return 1

  wait_for_thread_reply "$channel" "$thread_ts" >/dev/null || return 1

  assert_execution_upload_stream "$thread_key" 0 || return 1

  wait_for_uploaded_reply "$channel" "$thread_ts" '^generated-media-smoke\.mp4$' '^video/mp4$' >/dev/null
}

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Slackbot Integration Tests"
echo "  endpoint: ${ENDPOINT}"
echo "═══════════════════════════════════════════════════"

SMOKE_CHANNEL_ID=$(resolve_smoke_channel)
SMOKE_USER_ID=$(resolve_smoke_user "$SMOKE_CHANNEL_ID")

echo "  smoke channel: ${SMOKE_CHANNEL_ID}"
echo "  smoke user:    ${SMOKE_USER_ID}"
if [[ -n "$SLACK_SMOKE_TEAM_ID" ]]; then
  echo "  smoke team:    ${SLACK_SMOKE_TEAM_ID}"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 1. URL verification challenge
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "── URL Verification ──"

run_check \
  "url_verification returns challenge" \
  send_signed_event '{"type":"url_verification","challenge":"test-challenge-integration"}' 200

# ─────────────────────────────────────────────────────────────────────────────
# 2. Signature rejection
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "── Signature Rejection ──"

run_check \
  "bad signature → 401" \
  send_bad_sig '{"type":"url_verification","challenge":"should-fail"}' 401

# ─────────────────────────────────────────────────────────────────────────────
# 3. Event callback — app_mention with no files (smoke test)
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "── Event Callbacks ──"

run_check \
  "app_mention (no files) → 200 + persisted threaded reply" \
  smoke_app_mention_case \
  "app-mention-no-files" \
  "integration smoke ping"

# ─────────────────────────────────────────────────────────────────────────────
# 4. Event callback — app_mention WITH image attachment
# ─────────────────────────────────────────────────────────────────────────────

run_check \
  "app_mention with image attachment → 200 + persisted threaded reply" \
  smoke_app_mention_case \
  "app-mention-image" \
  "what is in this image?" \
  '[
    {
      "id": "F_TEST_IMG",
      "name": "screenshot.png",
      "mimetype": "image/png",
      "url_private": "https://files.slack.com/test/screenshot.png",
      "size": 45000,
      "original_w": 1920,
      "original_h": 1080
    }
  ]'

# ─────────────────────────────────────────────────────────────────────────────
# 5. Event callback — app_mention with PDF attachment
# ─────────────────────────────────────────────────────────────────────────────

run_check \
  "app_mention with PDF attachment → 200 + persisted threaded reply" \
  smoke_app_mention_case \
  "app-mention-pdf" \
  "summarize this doc" \
  '[
    {
      "id": "F_TEST_PDF",
      "name": "report.pdf",
      "mimetype": "application/pdf",
      "url_private": "https://files.slack.com/test/report.pdf",
      "size": 120000
    }
  ]'

# ─────────────────────────────────────────────────────────────────────────────
# 6. Event callback — app_mention with mixed attachments
# ─────────────────────────────────────────────────────────────────────────────

run_check \
  "app_mention with mixed attachments → 200 + persisted threaded reply" \
  smoke_app_mention_case \
  "app-mention-mixed" \
  "analyze these files" \
  '[
    {
      "id": "F_TEST_IMG2",
      "name": "chart.jpg",
      "mimetype": "image/jpeg",
      "url_private": "https://files.slack.com/test/chart.jpg",
      "size": 80000,
      "original_w": 800,
      "original_h": 600
    },
    {
      "id": "F_TEST_CSV",
      "name": "data.csv",
      "mimetype": "text/csv",
      "url_private": "https://files.slack.com/test/data.csv",
      "size": 5000
    }
  ]'

# ─────────────────────────────────────────────────────────────────────────────
# 7. Event callback — message in subscribed thread (no mention)
# ─────────────────────────────────────────────────────────────────────────────

run_check \
  "subscribed thread follow-ups → 200" \
  smoke_subscribed_thread_case

# ─────────────────────────────────────────────────────────────────────────────
# 8. Event callback — app_mention that must inline-upload a chart
# ─────────────────────────────────────────────────────────────────────────────

if [[ "$SMOKE_CHART_UPLOAD" == "1" ]]; then
  run_check \
    "chart request → inline upload permalink + uploaded Slack file" \
    smoke_chart_case
else
  echo "  - chart request → inline upload permalink + uploaded Slack file (skipped; set SMOKE_CHART_UPLOAD=1)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 9. Event callback — app_mention that must upload sandbox-generated MP4 media
# ─────────────────────────────────────────────────────────────────────────────

if [[ "$SMOKE_GENERATED_MEDIA_UPLOAD" == "1" ]]; then
  run_check \
    "generated media request → sandbox-local MP4 upload permalink + uploaded Slack file" \
    smoke_generated_media_case
else
  echo "  - generated media request → sandbox-local MP4 upload permalink + uploaded Slack file (skipped; set SMOKE_GENERATED_MEDIA_UPLOAD=1)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 10. Invalid JSON body
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "── Edge Cases ──"

run_check \
  "invalid JSON body → 400" \
  send_signed_event "not-json" 400

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Results: ${passed} passed, ${failed} failed (${total} total)"
echo "═══════════════════════════════════════════════════"
echo ""

if [[ $failed -gt 0 ]]; then
  exit 1
fi
