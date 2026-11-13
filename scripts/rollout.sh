#!/usr/bin/env bash
# The wrangler side of a gradual rollout (scripts/rollout.ts decides; .github/workflows/deploy.yml
# calls this). Runs in CI only, after `rollout.ts plan` wrote ROLLOUT_PLAN, with `retry` on PATH.
#
#   rollout.sh ship <key> <pnpm filter> <config|redirect> [secrets file]
#       a `full` Worker: `wrangler deploy`, as it always was. Otherwise upload a version and put it
#       beside the one serving traffic at 0%. `config` passes --config "$CONFIG"; `redirect` is a
#       built app, whose config the build wrote.
#   rollout.sh stage      gradual Workers to the canary share; staged ones stay at 0%
#   rollout.sh promote    gradual Workers to 100%
#   rollout.sh promote-staged   staged Workers to 100% (after every gradual one); versions only
#   rollout.sh settle     watch every rolled-out Worker at full traffic, then (only if that passes)
#                         apply every rolled-out Worker's triggers
#   rollout.sh triggers   `wrangler triggers deploy` for every rolled-out Worker
#   rollout.sh rollback <key> <message>   one attempt at putting <key> back on its earlier version
set -eo pipefail

plan() { node scripts/rollout.ts "$@"; }
dir="$RUNNER_TEMP/rollout"
mkdir -p "$dir"
slug() { printf '%s' "${1//[^A-Za-z0-9]/_}"; }

# The wrangler arguments naming the config, as `ship` was told, into the array `cfg`.
cfg_of() {
  cfg=()
  if [ "$(cat "$dir/$(slug "$1").cfg")" = config ]; then cfg=(--config "$CONFIG"); fi
}

# set_versions <key> <message> <spec>...: one deployment of the Worker's versions.
set_versions() {
  local key=$1 message=$2 filter
  shift 2
  filter=$(plan get "$key" filter)
  cfg_of "$key"
  retry pnpm --filter "$filter" exec wrangler versions deploy "$@" -y --message "$message" "${cfg[@]}"
}

case "${1:-}" in
  ship)
    key=$2 filter=$3 kind=$4 secrets_file=${5:-}
    printf '%s' "$kind" > "$dir/$(slug "$key").cfg"
    cfg=() secrets=()
    [ "$kind" = config ] && cfg=(--config "$CONFIG")
    if [ -n "$secrets_file" ] && [ "$(cat "$secrets_file")" != "{}" ]; then secrets=(--secrets-file "$secrets_file"); fi
    mode=$(plan get "$key" mode)
    if [ "$mode" = full ]; then
      retry pnpm --filter "$filter" exec wrangler deploy "${cfg[@]}" "${secrets[@]}"
      exit 0
    fi
    out="$dir/$(slug "$key").upload"
    : > "$out"
    retry env WRANGLER_OUTPUT_FILE_PATH="$out" \
      pnpm --filter "$filter" exec wrangler versions upload "${cfg[@]}" "${secrets[@]}" --message "Deploy ${GITHUB_SHA::7}"
    version=$(jq -rs '[.[] | select(.type == "version-upload")] | last | .version_id // empty' "$out")
    [ -n "$version" ] || { echo "::error::wrangler printed no version id for $key"; exit 1; }
    plan record "$key" "$version"
    echo "$key: uploaded $(plan get "$key" name) version $version; $(plan get "$key" oldVersion) keeps serving"
    read -ra specs <<<"$(plan specs "$key" 0)"
    set_versions "$key" "Deploy ${GITHUB_SHA::7} at 0%" "${specs[@]}"
    ;;
  stage)
    keys=$(plan keys gradual)
    [ -n "$keys" ] || exit 0
    canary=$(plan get "$(head -n 1 <<<"$keys")" canary)
    for key in $keys; do
      read -ra specs <<<"$(plan specs "$key" "$canary")"
      set_versions "$key" "Deploy ${GITHUB_SHA::7} at $canary%" "${specs[@]}"
    done
    ;;
  promote)
    # The post-promotion watch counts invocations from here.
    date -u +%Y-%m-%dT%H:%M:%SZ > "$dir/promoted"
    keys=$(plan keys gradual)
    for key in $keys; do
      read -ra specs <<<"$(plan specs "$key" 100)"
      set_versions "$key" "Deploy ${GITHUB_SHA::7} at 100%" "${specs[@]}"
    done
    ;;
  promote-staged)
    # In deploy order: each is bound by the ones after it, and the callees went first.
    keys=$(plan keys staged)
    for key in $keys; do
      read -ra specs <<<"$(plan specs "$key" 100)"
      set_versions "$key" "Deploy ${GITHUB_SHA::7} at 100%" "${specs[@]}"
    done
    ;;
  settle)
    # Watched first, so a bad version is rolled back (versions only) before its triggers are applied.
    since=$(cat "$dir/promoted" 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)
    plan watch-promoted "$since"
    "$0" triggers
    ;;
  triggers)
    # Routes, custom domains, workers.dev, cron schedules, queue consumers and Workflows (their
    # limits and schedules) aren't part of a version: `versions upload` leaves them as they were, and
    # a rollback to an earlier version can't put them back. So they go live last, once the new
    # versions have served all traffic for the watch window without raising their error rate.
    keys=$(plan keys gradual staged)
    for key in $keys; do
      cfg_of "$key"
      retry pnpm --filter "$(plan get "$key" filter)" exec wrangler triggers deploy "${cfg[@]}"
    done
    ;;
  rollback)
    key=$2 message=$3
    read -ra specs <<<"$(plan rollback-specs "$key")"
    filter=$(plan get "$key" filter)
    cfg_of "$key"
    pnpm --filter "$filter" exec wrangler versions deploy "${specs[@]}" -y --message "$message" "${cfg[@]}"
    ;;
  *)
    echo "usage: rollout.sh ship|stage|promote|promote-staged|settle|triggers|rollback (see the header)" >&2
    exit 2
    ;;
esac
