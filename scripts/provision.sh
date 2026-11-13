#!/usr/bin/env bash
# Creates the Cloudflare resources and the GitHub environment for one deployment in
# deployments/<id>.jsonc, and records its D1 id there. Safe to re-run: existing resources, and
# secrets already set, are kept. See docs/operations.md.
#
#   ./scripts/provision.sh <id>
#
# A deployment with `"content": true` in its registry entry also gets the content stack's own
# resources (its D1 database, KV namespace, assets bucket, vector index and queues), and its D1 and
# KV ids are recorded as contentD1Id and contentKvId. A commerce-only deployment gets none of them.
#
# Needs `wrangler login` (or CLOUDFLARE_API_TOKEN) and `gh auth login`. The AI Gateway, the
# Turnstile widget and the Logpush job are created through the API, so they also need
# CLOUDFLARE_API_TOKEN (for the widget, with Turnstile Sites Write) and CLOUDFLARE_ACCOUNT_ID;
# without them it prints what to create instead, or says what it skipped.
#
# With `redundancy.alerts` in the registry it also creates the account's notification policies, a
# webhook destination from ALERT_WEBHOOK_URL (exported in this shell) and a Health Check on each
# app's /health/deep; the API token then needs Notifications Write, Health Checks Write and Zone
# Read. PagerDuty is connected in the dashboard. See docs/operations.md, "Alerting".
set -euo pipefail
id="${1:?usage: scripts/provision.sh <id>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

eval "$(node scripts/fleet.ts names "$id")"
wrangler() { pnpm --filter @commerceworker/engine exec wrangler "$@"; }
j=()
[ -n "$JURISDICTION" ] && j=(--jurisdiction "$JURISDICTION")

echo "== $id: D1 $D1, R2 $R2 and $CATALOG_R2, KV $CATALOG_KV, gateway $AI_GATEWAY, index ${PRODUCT_INDEX:-none}, https://$DOMAIN, environment $ENVIRONMENT"
if [ "$CONTENT" = true ]; then
  echo "   content: D1 $CONTENT_D1, KV $CONTENT_KV, R2 $CONTENT_MEDIA, index ${CONTENT_VECTORS:-none}"
  echo "   https://$STUDIO_DOMAIN (studio), https://$API_DOMAIN (api), https://$CDN_DOMAIN (delivery), https://$MEDIA_DOMAIN (media)"
fi

wrangler d1 create "$D1" ${j[@]+"${j[@]}"} || echo "D1 database $D1 already exists"
uuid=$(wrangler d1 info "$D1" --json | jq -er .uuid)
node scripts/fleet.ts set-d1 "$id" "$uuid"
echo "Recorded d1Id $uuid in deployments/$id.jsonc"

wrangler r2 bucket create "$R2" ${j[@]+"${j[@]}"} || echo "R2 bucket $R2 already exists"

# The product index ai.extract reads (Vectorize): bge-base-en-v1.5 embeddings, so 768 dimensions
# and cosine, fixed at creation. A deploy fails if the binding names an index that doesn't exist.
# The engine's hourly cron fills it. A demo (mock AI) has none.
if [ -n "$PRODUCT_INDEX" ]; then
  if wrangler vectorize get "$PRODUCT_INDEX" >/dev/null 2>&1; then
    echo "Vectorize index $PRODUCT_INDEX already exists"
  else
    wrangler vectorize create "$PRODUCT_INDEX" --dimensions 768 --metric cosine
  fi
fi

# Each installed plugin's own D1 database (docs/plugins.md), named like its Worker.
for p in $PLUGINS; do
  pdb="commerceworker-plugin-$p$SUFFIX"
  wrangler d1 create "$pdb" ${j[@]+"${j[@]}"} || echo "D1 database $pdb already exists"
  puuid=$(wrangler d1 info "$pdb" --json | jq -er .uuid)
  node scripts/fleet.ts set-plugin-d1 "$id" "$p" "$puuid"
  echo "Recorded plugins.$p.d1Id $puuid in deployments/$id.jsonc"
done
# A deployment on its own Cloudflare account keeps plugin secrets in that account's Secrets Store
# (docs/plugins.md, "Secrets"): one store an account, made in the dashboard or with
# `wrangler secrets-store store create <name> --remote`; its id goes in the registry's secretsStore.
if [ -n "$SECRETS_STORE" ]; then
  if wrangler secrets-store store list --remote 2>/dev/null | grep -q "$SECRETS_STORE"; then
    echo "Secrets Store $SECRETS_STORE found; add each plugin's PLUGIN_<ID>_<NAME> to it"
  else
    echo "Secrets Store $SECRETS_STORE not found in this account: create it, or fix secretsStore.storeId" >&2
    exit 1
  fi
fi
for p in $SANDBOXED_PLUGINS; do
  echo "Plugin $p is sandboxed: nothing to create (the deploy publishes its bundle)"
done

# The catalog: published documents in R2, listing cards in KV (KV has no jurisdictions).
wrangler r2 bucket create "$CATALOG_R2" ${j[@]+"${j[@]}"} || echo "R2 bucket $CATALOG_R2 already exists"
kv_id() { wrangler kv namespace list | jq -er --arg t "$CATALOG_KV" '.[] | select(.title == $t) | .id'; }
kv=$(kv_id 2>/dev/null) || { wrangler kv namespace create "$CATALOG_KV" >/dev/null; kv=$(kv_id); }
node scripts/fleet.ts set-catalog-kv "$id" "$kv"
echo "Recorded catalogKvId $kv in deployments/$id.jsonc"
# Feed files and their parts are only needed while a feed imports. Replaced on each run, like the
# audit rule above.
wrangler r2 bucket lifecycle remove "$CATALOG_R2" --name feeds ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
wrangler r2 bucket lifecycle add "$CATALOG_R2" feeds feeds/ --expire-days 30 --force ${j[@]+"${j[@]}"}
# Dead letters the catalog keeps (dlq/<queue>/<date>/<id>.json) are for inspection and replay
# (docs/operations.md, "Dead letters"); a month is long enough to act on one. Replaced each run.
wrangler r2 bucket lifecycle remove "$CATALOG_R2" --name dlq ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
wrangler r2 bucket lifecycle add "$CATALOG_R2" dlq dlq/ --expire-days 30 --force ${j[@]+"${j[@]}"}
# The catalog's daily backups (backups/<date>/, docs/operations.md "Catalog backups") expire after
# catalogBackupDays, and the copies a point-in-time restore keeps of what was published
# (restores/<instance>/) after 30 days. Replaced each run, so a changed number takes effect.
wrangler r2 bucket lifecycle remove "$CATALOG_R2" --name backups ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
wrangler r2 bucket lifecycle add "$CATALOG_R2" backups backups/ --expire-days "$CATALOG_BACKUP_DAYS" \
  --force ${j[@]+"${j[@]}"}
wrangler r2 bucket lifecycle remove "$CATALOG_R2" --name restores ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
wrangler r2 bucket lifecycle add "$CATALOG_R2" restores restores/ --expire-days 30 --force ${j[@]+"${j[@]}"}
# The deploy smoke test's write check deletes its health/ object as it ends; one whose check was
# cut off (a timeout) is gone a day later. Replaced each run, on both buckets.
wrangler r2 bucket lifecycle remove "$CATALOG_R2" --name health ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
wrangler r2 bucket lifecycle add "$CATALOG_R2" health health/ --expire-days 1 --force ${j[@]+"${j[@]}"}
# And nothing deletes or overwrites a backup before then: a lock of the same age, so the lifecycle
# rule and the lock never disagree. The backup Workflow skips a key that exists, as the lock needs.
# `lock set` replaces the bucket's whole lock configuration: this is the catalog bucket's only rule.
catalog_locks=$(mktemp)
jq -n --argjson d "$CATALOG_BACKUP_DAYS" '{rules: [
  {id: "catalog-backups", enabled: true, prefix: "backups/", condition: {type: "Age", maxAgeSeconds: ($d * 86400)}}
]}' >"$catalog_locks"
wrangler r2 bucket lock set "$CATALOG_R2" --file "$catalog_locks" --force ${j[@]+"${j[@]}"}
rm -f "$catalog_locks"
echo "Catalog backups in $CATALOG_R2 kept and locked $CATALOG_BACKUP_DAYS days"
# The queues feed parts, urgent purges and listing changes go through, and their dead-letter queues. A deploy fails if
# the consumer's queue is missing, so a queue that can't be created or found stops provisioning.
# Each keeps messages 14 days (the most Queues allows), set on existing queues too, so a consumer
# that is down over a long weekend loses nothing.
for q in "$CATALOG_FEED_PARTS" "$CATALOG_FEED_PARTS_DLQ" "$CATALOG_PURGE" "$CATALOG_PURGE_DLQ" \
  "$CATALOG_CHANGES" "$CATALOG_CHANGES_DLQ"; do
  if wrangler queues info "$q" >/dev/null 2>&1; then echo "Queue $q already exists"
  else wrangler queues create "$q"; fi
  wrangler queues update "$q" --message-retention-period-secs 1209600 >/dev/null
  echo "Queue $q keeps messages 14 days"
done

# ---- The content stack (registry `content`) -------------------------------------------------------
# Published content and the assets service: a database of its own (migrated from
# packages/store/migrations; the commerce database keeps packages/db/migrations), the cache KV the
# api, pipeline, delivery and media share, the assets bucket, the vector index and the queues. The
# AI Gateway is the deployment's one above. Every step finds or creates, so a re-run changes nothing.
if [ "$CONTENT" = true ]; then
  # D1, with read replication on: delivery and admin reads go to the nearest replica (the Workers
  # open Sessions API sessions; writes always go to the primary). Looked up by name in the account's
  # list: `d1 info <name>` resolves the name against the engine's own config first.
  wrangler d1 create "$CONTENT_D1" ${j[@]+"${j[@]}"} || echo "D1 database $CONTENT_D1 already exists"
  content_uuid=$(wrangler d1 list --json | jq -er --arg n "$CONTENT_D1" '.[] | select(.name == $n) | .uuid')
  node scripts/fleet.ts set-content-d1 "$id" "$content_uuid"
  echo "Recorded contentD1Id $content_uuid in deployments/$id.jsonc"
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] &&
    curl -fsS -X PUT "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database/$content_uuid" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' \
      --data '{"read_replication":{"mode":"auto"}}' >/dev/null; then
    echo "D1 read replication for $CONTENT_D1: auto"
  else
    echo "Turn on read replication for $CONTENT_D1 (dashboard: D1 > $CONTENT_D1 > Settings)."
  fi

  # The KV namespace the api, pipeline, delivery and media share (delivery cache, cached principals,
  # the published-asset gate). KV has no jurisdictions.
  content_kv_id() { wrangler kv namespace list | jq -er --arg t "$CONTENT_KV" '.[] | select(.title == $t) | .id'; }
  content_kv=$(content_kv_id 2>/dev/null) || { wrangler kv namespace create "$CONTENT_KV" >/dev/null; content_kv=$(content_kv_id); }
  node scripts/fleet.ts set-content-kv "$id" "$content_kv"
  echo "Recorded contentKvId $content_kv in deployments/$id.jsonc"

  # The assets bucket: originals, import staging, dead letters and zip downloads. Staged imports,
  # dead letters and zips expire (a zip is kept a day; the pipeline's sweep removes it, this is the
  # backstop). The rules are replaced on each run.
  wrangler r2 bucket create "$CONTENT_MEDIA" ${j[@]+"${j[@]}"} || echo "R2 bucket $CONTENT_MEDIA already exists"
  for rule in "imports imports/ 7" "dlq dlq/ 30" "zips zips/ 2"; do
    set -- $rule
    wrangler r2 bucket lifecycle remove "$CONTENT_MEDIA" --name "$1" ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
    wrangler r2 bucket lifecycle add "$CONTENT_MEDIA" "$1" "$2" --expire-days "$3" --force ${j[@]+"${j[@]}"}
  done
  # Multipart uploads nobody finished (an abandoned large upload, a zip whose build died): aborted
  # after 2 days anywhere in the bucket, so R2 stops keeping their parts. The pipeline's hourly
  # sweep aborts an abandoned upload after one day; this is the backstop.
  wrangler r2 bucket lifecycle remove "$CONTENT_MEDIA" --name abort-multipart ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
  wrangler r2 bucket lifecycle add "$CONTENT_MEDIA" abort-multipart "" --abort-multipart-days 2 --force ${j[@]+"${j[@]}"}

  # Embeddings for semantic and hybrid search (Workers AI bge-base-en-v1.5: 768 dimensions, cosine,
  # fixed at creation), filtered by space and environment, so both are metadata indexes. A demo
  # mocks every model and has no index.
  if [ -n "$CONTENT_VECTORS" ]; then
    if wrangler vectorize get "$CONTENT_VECTORS" >/dev/null 2>&1; then
      echo "Vectorize index $CONTENT_VECTORS already exists"
    else
      wrangler vectorize create "$CONTENT_VECTORS" --dimensions 768 --metric cosine
    fi
    for prop in spaceId environmentId; do
      wrangler vectorize create-metadata-index "$CONTENT_VECTORS" --property-name "$prop" --type string \
        >/dev/null 2>&1 || true
    done
  fi

  # Queues: domain events (+ dead letters), bulk chunks, agent jobs, delivery purges, media purges
  # and asset events (each + dead letters). A deploy fails if a consumer's queue is missing, so a
  # queue that can't be created or found stops provisioning. Each keeps messages 14 days.
  for q in $CONTENT_QUEUES; do
    if wrangler queues info "$q" >/dev/null 2>&1; then echo "Queue $q already exists"
    else wrangler queues create "$q"; fi
    wrangler queues update "$q" --message-retention-period-secs 1209600 >/dev/null
  done

  # Asset ingest: every object written to the assets bucket is announced on the asset-events queue.
  # Asset keys (`space/environment/asset/file`) share no prefix, so the rule has none; the pipeline
  # ignores keys that aren't an asset's current file (extracted text, version bodies, staged jobs).
  if wrangler r2 bucket notification list "$CONTENT_MEDIA" ${j[@]+"${j[@]}"} 2>/dev/null | grep -q "$ASSET_EVENTS"; then
    echo "R2 notification $CONTENT_MEDIA -> $ASSET_EVENTS already exists"
  else
    wrangler r2 bucket notification create "$CONTENT_MEDIA" --event-type object-create \
      --queue "$ASSET_EVENTS" --description "commerceworker asset ingest" ${j[@]+"${j[@]}"}
  fi
fi

# How long the R2 archive keeps audit events (auditArchiveDays): the rule is replaced on each run,
# so a changed number takes effect; without one, archived events are kept.
wrangler r2 bucket lifecycle remove "$R2" --name audit-archive ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
if [ -n "$AUDIT_ARCHIVE_DAYS" ]; then
  wrangler r2 bucket lifecycle add "$R2" audit-archive audit/ --expire-days "$AUDIT_ARCHIVE_DAYS" \
    --force ${j[@]+"${j[@]}"}
  echo "Archived audit events in $R2 expire after $AUDIT_ARCHIVE_DAYS days"
fi

# The write check's leftovers in the docs bucket, as in the catalog's above.
wrangler r2 bucket lifecycle remove "$R2" --name health ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
wrangler r2 bucket lifecycle add "$R2" health health/ --expire-days 1 --force ${j[@]+"${j[@]}"}

# Bucket locks on the same bucket: nothing deletes the audit archive before the lifecycle rule
# above expires it (the same number of days, so the two never disagree; kept indefinitely when
# auditArchiveDays is unset), nor a pinned sandboxed-plugin bundle, which a rollback reloads.
# `lock set` replaces the bucket's whole lock configuration in one call, so a re-run changes the
# audit retention without a moment unlocked; a lock added to this bucket by hand is replaced too.
if [ -n "$AUDIT_ARCHIVE_DAYS" ]; then
  audit_lock=$(jq -n --argjson d "$AUDIT_ARCHIVE_DAYS" '{type: "Age", maxAgeSeconds: ($d * 86400)}')
else
  audit_lock='{"type":"Indefinite"}'
fi
locks=$(mktemp)
trap 'rm -f "$locks"' EXIT
jq -n --argjson audit "$audit_lock" '{rules: [
  {id: "audit-archive", enabled: true, prefix: "audit/", condition: $audit},
  {id: "plugin-bundles", enabled: true, prefix: "plugins/", condition: {type: "Indefinite"}}
]}' >"$locks"
wrangler r2 bucket lock set "$R2" --file "$locks" --force ${j[@]+"${j[@]}"}
echo "Locked audit/ (${AUDIT_ARCHIVE_DAYS:-indefinitely}${AUDIT_ARCHIVE_DAYS:+ days}) and plugins/ (indefinitely) in $R2"

# The docs replica (docs/operations.md, "Redundancy"): a second bucket for the order documents, and
# the queue R2 announces every object create and delete on, with its dead-letter queue. The engine
# consumes the queue and copies (a delete moves the copy to deleted/). Everything is read before it
# is created, so a re-run changes nothing but the retention. Empty without `redundancy` (or with
# `r2Replica` an exception).
# docs-replica:begin
if [ -n "${DOCS_REPLICA_R2:-}" ]; then
  if wrangler r2 bucket info "$DOCS_REPLICA_R2" ${j[@]+"${j[@]}"} >/dev/null 2>&1; then
    echo "R2 bucket $DOCS_REPLICA_R2 already exists"
  else
    wrangler r2 bucket create "$DOCS_REPLICA_R2" ${j[@]+"${j[@]}"}
  fi
  # A moved copy (deleted/<date>/<key>) is kept 30 days, so an erasure in the primary completes in
  # the replica within 30 days; the dead letters the consumer keeps (dlq/) likewise. The audit
  # archive expires as the primary's does. Replaced each run.
  for rule in "deleted-copies deleted/ 30" "dlq dlq/ 30"; do
    read -r rule_name rule_prefix rule_days <<<"$rule"
    wrangler r2 bucket lifecycle remove "$DOCS_REPLICA_R2" --name "$rule_name" ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
    wrangler r2 bucket lifecycle add "$DOCS_REPLICA_R2" "$rule_name" "$rule_prefix" --expire-days "$rule_days" \
      --force ${j[@]+"${j[@]}"}
  done
  wrangler r2 bucket lifecycle remove "$DOCS_REPLICA_R2" --name audit-archive ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
  if [ -n "$AUDIT_ARCHIVE_DAYS" ]; then
    wrangler r2 bucket lifecycle add "$DOCS_REPLICA_R2" audit-archive audit/ --expire-days "$AUDIT_ARCHIVE_DAYS" \
      --force ${j[@]+"${j[@]}"}
    replica_audit_lock=$(jq -n --argjson d "$AUDIT_ARCHIVE_DAYS" '{type: "Age", maxAgeSeconds: ($d * 86400)}')
  else
    replica_audit_lock='{"type":"Indefinite"}'
  fi
  # The same locks as the primary's: a copy of the audit archive or a plugin bundle can't be
  # deleted or overwritten any sooner than the original. The consumer copies these keys once and
  # never moves them (a lock would refuse), so the lifecycle rule above expires them.
  replica_locks=$(mktemp)
  jq -n --argjson audit "$replica_audit_lock" '{rules: [
    {id: "audit-archive", enabled: true, prefix: "audit/", condition: $audit},
    {id: "plugin-bundles", enabled: true, prefix: "plugins/", condition: {type: "Indefinite"}}
  ]}' >"$replica_locks"
  wrangler r2 bucket lock set "$DOCS_REPLICA_R2" --file "$replica_locks" --force ${j[@]+"${j[@]}"}
  rm -f "$replica_locks"

  # The queue and its dead-letter queue: the same account-level queues as every other here, so they
  # share a jurisdiction (a dead-letter queue must share its queue's). The engine's consumers
  # (wrangler.jsonc) name both, so a deploy fails if either is missing. 14-day retention.
  for q in "$DOCS_REPLICA_QUEUE" "$DOCS_REPLICA_DLQ"; do
    if wrangler queues info "$q" >/dev/null 2>&1; then echo "Queue $q already exists"
    else wrangler queues create "$q"; fi
    wrangler queues update "$q" --message-retention-period-secs 1209600 >/dev/null
  done

  # R2 announces creates and deletes of DOCS on the queue: one rule for both, as overlapping rules
  # aren't allowed. Read first: a second `create` for the same queue would be refused.
  if wrangler r2 bucket notification list "$R2" ${j[@]+"${j[@]}"} 2>/dev/null | grep -q "$DOCS_REPLICA_QUEUE"; then
    echo "R2 notification $R2 -> $DOCS_REPLICA_QUEUE already exists"
  else
    wrangler r2 bucket notification create "$R2" --event-type object-create --event-type object-delete \
      --queue "$DOCS_REPLICA_QUEUE" --description "commerceworker docs replica" ${j[@]+"${j[@]}"}
  fi
  echo "Order documents in $R2 replicated to $DOCS_REPLICA_R2"
fi
# docs-replica:end

# Redundancy (docs/operations.md, "Redundancy"): the backups bucket (the commerce D1's daily backups
# under d1/, the Durable Object copies and restore reports under objects/), and the standby database
# the D1 restore drill rebuilds the newest backup in. Each part is read before it is created, so a
# re-run changes nothing but the retention. Empty without `redundancy`; BACKUP_D1 and BACKUP_OBJECTS
# say which prefixes are kept (a deployment may except either part).
# redundancy:begin
if [ -n "${BACKUPS_R2:-}" ]; then
  if wrangler r2 bucket info "$BACKUPS_R2" ${j[@]+"${j[@]}"} >/dev/null 2>&1; then
    echo "R2 bucket $BACKUPS_R2 already exists"
  else
    wrangler r2 bucket create "$BACKUPS_R2" ${j[@]+"${j[@]}"}
  fi
  # Backups expire after backupDays, and nothing deletes or overwrites one before then: a lock of
  # the same age on each prefix, so a lifecycle rule and its lock never disagree (the catalog's
  # backups work the same way). d1/ holds the D1 backups; objects/ the Durable Object copies and the
  # restore reports (whose undo bookmarks reach only 30 days anyway). The drills' evidence under
  # drills/ is kept. `lock set` replaces the bucket's whole lock configuration: the rules below are
  # all of it.
  locks='[]'
  if [ -n "${BACKUP_D1:-}" ]; then
    wrangler r2 bucket lifecycle remove "$BACKUPS_R2" --name d1-backups ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
    wrangler r2 bucket lifecycle add "$BACKUPS_R2" d1-backups d1/ --expire-days "$BACKUP_DAYS" \
      --force ${j[@]+"${j[@]}"}
    locks=$(jq -c --argjson d "$BACKUP_DAYS" '. + [{id: "d1-backups", enabled: true, prefix: "d1/", condition: {type: "Age", maxAgeSeconds: ($d * 86400)}}]' <<<"$locks")
    echo "D1 backups in $BACKUPS_R2 kept and locked $BACKUP_DAYS days"
  fi
  if [ -n "${BACKUP_OBJECTS:-}" ]; then
    wrangler r2 bucket lifecycle remove "$BACKUPS_R2" --name object-backups ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
    wrangler r2 bucket lifecycle add "$BACKUPS_R2" object-backups objects/ --expire-days "$BACKUP_DAYS" \
      --force ${j[@]+"${j[@]}"}
    locks=$(jq -c --argjson d "$BACKUP_DAYS" '. + [{id: "object-backups", enabled: true, prefix: "objects/", condition: {type: "Age", maxAgeSeconds: ($d * 86400)}}]' <<<"$locks")
    echo "Durable Object copies in $BACKUPS_R2 kept and locked $BACKUP_DAYS days"
  fi
  backup_locks=$(mktemp)
  jq -n --argjson r "$locks" '{rules: $r}' >"$backup_locks"
  wrangler r2 bucket lock set "$BACKUPS_R2" --file "$backup_locks" --force ${j[@]+"${j[@]}"}
  rm -f "$backup_locks"
fi

if [ -n "${STANDBY_D1:-}" ]; then
  # Looked up by name in the account's list: `d1 info <name>` resolves the name against the
  # engine's own config first, whose STANDBY_DB would answer with its placeholder id.
  standby_id() { wrangler d1 list --json | jq -er --arg n "$STANDBY_D1" '.[] | select(.name == $n) | .uuid'; }
  if standby=$(standby_id 2>/dev/null); then
    echo "D1 database $STANDBY_D1 already exists"
  else
    wrangler d1 create "$STANDBY_D1" ${j[@]+"${j[@]}"}
    standby=$(standby_id)
  fi
  # A restore wipes this database: it must never be the live one.
  if [ "$standby" = "$uuid" ]; then
    echo "$STANDBY_D1 is the live database ($uuid): a restore would wipe it" >&2
    exit 1
  fi
  node scripts/fleet.ts set-standby-d1 "$id" "$standby"
  echo "Recorded standbyD1Id $standby in deployments/$id.jsonc"
fi
# redundancy:end

# The AI Gateway every model call goes through: the same settings as commerceworker's own
# (docs/deploy.md, "Settings for production").
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  api="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai-gateway/gateways"
  if existing_gw=$(curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$api/$AI_GATEWAY" 2>/dev/null); then
    echo "AI Gateway $AI_GATEWAY already exists"
    if [ "$(jq -r '.result.collect_logs' <<<"$existing_gw")" != "$AI_GATEWAY_LOGS" ]; then
      echo "  Its default for request logs differs from aiGatewayLogs ($AI_GATEWAY_LOGS). The engine"
      echo "  sends aiGatewayLogs on every call, so this only matters for calls made outside it; match"
      echo "  it in the dashboard (AI > AI Gateway > $AI_GATEWAY > Settings), and delete logs kept so far."
    fi
    if [ "$(jq -r '[.result.retry_max_attempts, .result.retry_delay, .result.retry_backoff] | map(tostring) | join(" ")' <<<"$existing_gw")" != "3 500 exponential" ]; then
      echo "  Its retries aren't commerceworker's (3 attempts, 500 ms, exponential): set them in the"
      echo "  dashboard (AI > AI Gateway > $AI_GATEWAY > Settings > Retry Requests)."
    fi
  else
    curl -fsS -X POST "$api" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H 'Content-Type: application/json' \
      --data "$(jq -n --arg id "$AI_GATEWAY" --argjson logs "$AI_GATEWAY_LOGS" '{
        id: $id, authentication: true, collect_logs: $logs,
        log_management: 100000, log_management_strategy: "DELETE_OLDEST",
        cache_ttl: 0, cache_invalidate_on_update: false,
        rate_limiting_limit: 120, rate_limiting_interval: 60, rate_limiting_technique: "sliding",
        retry_max_attempts: 3, retry_delay: 500, retry_backoff: "exponential"
      }')" >/dev/null
    echo "Created AI Gateway $AI_GATEWAY"
  fi
else
  echo "Skipped the AI Gateway: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or create"
  echo "\"$AI_GATEWAY\" in the dashboard (AI > AI Gateway) with commerceworker's settings."
fi

# The logs bucket: Logpush writes the deployment's Workers' trace events there, under workers/<date>/
# (docs/operations.md, "Logs"). A bucket of its own, so the R2 token Logpush holds can write nothing
# else of the deployment's. They expire after logRetentionDays: the rule is replaced on each run, so
# a changed number takes effect.
logpush_spec=$(node scripts/fleet.ts logpush "$id")
alert_spec=$(node scripts/fleet.ts alerts "$id")
logs_prefix=$(jq -er .prefix <<<"$logpush_spec")
wrangler r2 bucket create "$LOGS_R2" ${j[@]+"${j[@]}"} || echo "R2 bucket $LOGS_R2 already exists"
wrangler r2 bucket lifecycle remove "$LOGS_R2" --name logs ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
wrangler r2 bucket lifecycle add "$LOGS_R2" logs "$logs_prefix" --expire-days "$LOG_RETENTION_DAYS" \
  --force ${j[@]+"${j[@]}"}
echo "Logs in $LOGS_R2 expire after $LOG_RETENTION_DAYS days"

# The Logpush job that fills it: workers_trace_events from this deployment's Workers only (a filter
# by script name; every Worker on the account that sets `logpush` would reach it otherwise), with
# the fields `fleet.ts logpush` lists. Found by name and updated in place on a re-run, its key kept.
# Creating one also makes its key, so CLOUDFLARE_API_TOKEN then needs Account API Tokens Write as
# well as Logs Write. ROTATE_LOGPUSH_KEY=1 rolls the key and gives the job the new one. Tracing is
# off throughout (and restored after), since the key passes through this shell.
case $- in *x*) logpush_xtrace=1 ;; *) logpush_xtrace="" ;; esac
set +x
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  acct="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"
  # Whatever the API says back, minus any key it quotes from a destination.
  redact() { sed -E 's/(secret-access-key|access-key-id)=[^&"[:space:]]*/\1=REDACTED/g'; }
  # One Cloudflare API call, its response on stdout; stops provisioning on a failure, naming it.
  # The API token reaches curl through a pipe and a body through stdin, never its arguments.
  cf() {
    local out
    if [ "$1" = GET ]; then
      out=$(curl -sS "$acct$2" -H @<(printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN"))
    else
      out=$(curl -sS -X "$1" "$acct$2" -H @<(printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN") \
        -H 'Content-Type: application/json' --data-binary @-)
    fi
    if ! jq -e .success >/dev/null 2>&1 <<<"$out"; then
      echo "Cloudflare API $1 ${2%%\?*}: $(jq -r '[.errors[]?.message] | join("; ")' <<<"$out" 2>/dev/null | redact)" >&2
      return 1
    fi
    printf '%s' "$out"
  }
  # Logpush signs its writes to R2 as an S3 client: the access key id is an API token's id, the
  # secret the SHA-256 of its value. The token is the account's, named for the deployment, and may
  # only write objects in the logs bucket (`logpushToken` in fleet.ts builds it). Its value stays in
  # this shell and in the job's destination: never printed, never on disk. An existing token is
  # rolled rather than duplicated, and only once it holds exactly that policy. It runs in a command
  # substitution, where bash drops `set -e`, so each step returns on failure.
  logpush_destination() {
    local tid="" page=1 listed body pg made value secret
    body=$(cf GET "/tokens/permission_groups?name=Workers%20R2%20Storage%20Bucket%20Item%20Write" |
      node scripts/fleet.ts logpush-token "$id" "$CLOUDFLARE_ACCOUNT_ID") || return 1
    pg=$(jq -er '.policies[0].permission_groups[0].id' <<<"$body") || return 1
    while :; do
      listed=$(cf GET "/tokens?per_page=50&page=$page") || return 1
      [ "$(jq '.result | length' <<<"$listed")" = 0 ] && break
      tid=$(jq -r --arg n "$LOGPUSH_TOKEN" '[.result[] | select(.name == $n)][0].id // empty' <<<"$listed")
      [ -n "$tid" ] && break
      page=$((page + 1))
    done
    if [ -n "$tid" ]; then
      cf GET "/tokens/$tid" | node scripts/fleet.ts logpush-token "$id" "$CLOUDFLARE_ACCOUNT_ID" check "$pg" ||
        return 1
      value=$(cf PUT "/tokens/$tid/value" <<<'{}' | jq -er .result) || return 1
    else
      made=$(cf POST /tokens <<<"$body") || return 1
      tid=$(jq -er .result.id <<<"$made") || return 1
      value=$(jq -er .result.value <<<"$made") || return 1
    fi
    secret=$(printf '%s' "$value" | openssl dgst -sha256 -r | cut -d' ' -f1) || return 1
    # A bucket in a jurisdiction is reached through its S3 endpoint; the r2:// form is for the default.
    if [ -n "$JURISDICTION" ]; then
      printf 's3://%s/%s{DATE}?region=auto&endpoint=%s.%s.r2.cloudflarestorage.com&access-key-id=%s&secret-access-key=%s' \
        "$LOGS_R2" "$logs_prefix" "$CLOUDFLARE_ACCOUNT_ID" "$JURISDICTION" "$tid" "$secret"
    else
      printf 'r2://%s/%s{DATE}?account-id=%s&access-key-id=%s&secret-access-key=%s' \
        "$LOGS_R2" "$logs_prefix" "$CLOUDFLARE_ACCOUNT_ID" "$tid" "$secret"
    fi
  }
  jobs=$(cf GET /logpush/datasets/workers_trace_events/jobs)
  # `logpush` puts these Workers in every workers_trace_events job on the account: refuse while one
  # that isn't this deployment's (an unfiltered one, say) would take their logs too.
  node scripts/fleet.ts logpush-foreign "$id" <<<"$jobs"
  job_id=$(jq -r --arg n "$LOGPUSH_JOB" '[.result[] | select(.name == $n)][0].id // empty' <<<"$jobs")
  job=$(jq '{enabled: true, filter, output_options}' <<<"$logpush_spec")
  if [ -n "$job_id" ]; then
    if [ "${ROTATE_LOGPUSH_KEY:-}" = 1 ]; then
      dest=$(logpush_destination)
      job=$(jq --rawfile d <(printf '%s' "$dest") '. + {destination_conf: $d}' <<<"$job")
    fi
    updated=$(cf PUT "/logpush/jobs/$job_id" <<<"$job")
    echo "Logpush job $LOGPUSH_JOB updated: $(jq -r '.scripts | join(", ")' <<<"$logpush_spec") to $LOGS_R2${ROTATE_LOGPUSH_KEY:+ (new key)}"
    last_error=$(jq -r '.result.error_message // empty' <<<"$updated" | redact)
    if [ -n "$last_error" ]; then
      echo "  Its last push failed: $last_error (ROTATE_LOGPUSH_KEY=1 gives it a new key)"
    fi
  else
    dest=$(logpush_destination)
    job=$(jq --arg n "$LOGPUSH_JOB" --rawfile d <(printf '%s' "$dest") \
      '. + {name: $n, dataset: "workers_trace_events", destination_conf: $d}' <<<"$job")
    if ! created=$(cf POST /logpush/jobs <<<"$job" 2>&1); then
      echo "$created" >&2
      if grep -qi 'max jobs' <<<"$created"; then
        echo "The account has as many workers_trace_events jobs as Logpush allows: ask Cloudflare to" >&2
        echo "raise it, or give $id its own account (docs/operations.md, \"Logs\")." >&2
      fi
      exit 1
    fi
    echo "Created Logpush job $LOGPUSH_JOB: $(jq -r '.scripts | join(", ")' <<<"$logpush_spec") to $LOGS_R2"
  fi
else
  echo "Skipped the Logpush job: set CLOUDFLARE_API_TOKEN (Logs Write, and Account API Tokens Write"
  echo "to create it) and CLOUDFLARE_ACCOUNT_ID, and run this again. Until then nothing is pushed."
fi
if [ -n "$logpush_xtrace" ]; then set -x; fi

# Detection (registry `redundancy.alerts`, docs/operations.md, "Alerting"): the account's four
# notification policies, a webhook destination from ALERT_WEBHOOK_URL (a secret: set in this shell,
# never printed, never on disk), PagerDuty when `alerts.pagerduty` is set (connected in the
# dashboard: the API can only list a connected service), and a Health Check a minute on each app's
# /health/deep with a policy of its own. Everything is found by name first and made only when
# missing; a policy that exists gains this deployment's destinations and loses none, since one set
# serves every deployment on a shared account. Needs Notifications Write, Health Checks Write and
# Zone Read on CLOUDFLARE_API_TOKEN. Off without `alerts` (or with `alerts` an exception).
case $- in *x*) alerts_xtrace=1 ;; *) alerts_xtrace="" ;; esac
set +x
# alerts:begin
if [ "$ALERTS" = true ]; then
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    echo "Skipped the alerts: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, and run this again."
  else
    cf_base=https://api.cloudflare.com/client/v4
    notif="/accounts/$CLOUDFLARE_ACCOUNT_ID/alerting/v3"
    # One API call, its response on stdout; a failure stops provisioning, naming the call. The token
    # reaches curl through a pipe and a body through stdin, never its arguments.
    cfa() {
      local out
      if [ "$1" = GET ]; then
        out=$(curl -sS "$cf_base$2" -H @<(printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN"))
      else
        out=$(curl -sS -X "$1" "$cf_base$2" -H @<(printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN") \
          -H 'Content-Type: application/json' --data-binary @-)
      fi
      if ! jq -e .success >/dev/null 2>&1 <<<"$out"; then
        echo "Cloudflare API $1 ${2%%\?*}: $(jq -r '[.errors[]?.message] | join("; ")' <<<"$out" 2>/dev/null)" >&2
        return 1
      fi
      printf '%s' "$out"
    }

    # Destinations: the webhook (updated in place when it exists, so a rotated URL takes effect),
    # PagerDuty (only if already connected) and an optional email address.
    webhook_url="${ALERT_WEBHOOK_URL:-$ALERT_WEBHOOK_FALLBACK}"
    webhook_id=""
    if [ -n "$webhook_url" ]; then
      hooks=$(cfa GET "$notif/destinations/webhooks")
      webhook_id=$(jq -r --arg n "$(jq -r .webhookName <<<"$alert_spec")" \
        '[.result[]? | select(.name == $n)][0].id // empty' <<<"$hooks")
      hook_body=$(CW_URL="$webhook_url" jq -n --arg n "$(jq -r .webhookName <<<"$alert_spec")" '{name: $n, url: env.CW_URL}')
      if [ -n "$webhook_id" ]; then
        cfa PUT "$notif/destinations/webhooks/$webhook_id" <<<"$hook_body" >/dev/null
        echo "Alert webhook $(jq -r .webhookName <<<"$alert_spec") updated"
      else
        webhook_id=$(cfa POST "$notif/destinations/webhooks" <<<"$hook_body" | jq -er .result.id)
        echo "Created alert webhook $(jq -r .webhookName <<<"$alert_spec")"
      fi
    fi
    pagerduty_id=""
    if [ "$(jq -r .pagerduty <<<"$alert_spec")" = true ]; then
      pagerduty_id=$(cfa GET "$notif/destinations/pagerduty" | jq -r '.result[0].id // empty')
      if [ -z "$pagerduty_id" ]; then
        echo "PagerDuty isn't connected to this account: connect it in the dashboard (Notifications >"
        echo "Destinations > PagerDuty > Connect) and run this again; until then it pages nobody."
      else
        echo "Alert destination: PagerDuty (connected)"
      fi
    fi
    mechanisms=$(jq -n --arg wh "$webhook_id" --arg pd "$pagerduty_id" --arg em "${ALERT_EMAIL:-}" '
      {} | (if $wh != "" then .webhooks = [{id: $wh}] else . end)
         | (if $pd != "" then .pagerduty = [{id: $pd}] else . end)
         | (if $em != "" then .email = [{id: $em}] else . end)')
    if [ "$mechanisms" = '{}' ]; then
      echo "The alerts have nowhere to go: set ALERT_WEBHOOK_URL, connect PagerDuty, or set ALERT_EMAIL." >&2
      exit 1
    fi

    # A policy by name: made if missing, and otherwise given any destination it lacks.
    policies=$(cfa GET "$notif/policies")
    ensure_policy() { # name alert_type description filters-json
      local have body merged
      have=$(jq -c --arg n "$1" '[.result[]? | select(.name == $n)][0] // empty' <<<"$policies")
      if [ -z "$have" ]; then
        body=$(jq -n --arg n "$1" --arg t "$2" --arg d "$3" --argjson f "$4" --argjson m "$mechanisms" \
          '{name: $n, description: $d, alert_type: $t, enabled: true, mechanisms: $m}
           + (if $f == {} then {} else {filters: $f} end)')
        cfa POST "$notif/policies" <<<"$body" >/dev/null
        echo "Created notification policy $1"
        return
      fi
      merged=$(jq -c --argjson m "$mechanisms" '
        .mechanisms as $h | reduce ("email", "pagerduty", "webhooks") as $k ({};
          .[$k] = ((($h[$k] // []) + ($m[$k] // [])) | map({id}) | unique_by(.id)))
        | with_entries(select(.value | length > 0))' <<<"$have")
      if [ "$merged" = "$(jq -c '.mechanisms | with_entries(.value |= (map({id}) | unique_by(.id))) | with_entries(select(.value | length > 0))' <<<"$have")" ]; then
        echo "Notification policy $1 already sends to these destinations"
        return
      fi
      body=$(jq --argjson m "$merged" '{name, description, alert_type, enabled, mechanisms: $m}
        + (if (.filters // {}) == {} then {} else {filters} end)' <<<"$have")
      cfa PUT "$notif/policies/$(jq -r .id <<<"$have")" <<<"$body" >/dev/null
      echo "Notification policy $1 now also sends to these destinations"
    }
    while IFS= read -r p; do
      ensure_policy "$(jq -r .name <<<"$p")" "$(jq -r .alert_type <<<"$p")" "$(jq -r .description <<<"$p")" '{}'
    done < <(jq -c '.policies[]' <<<"$alert_spec")

    # The zone a host is in: its own name, then each parent, until the account has one.
    zone_of() {
      local h="$1" z
      while [[ "$h" == *.* ]]; do
        z=$(cfa GET "/zones?name=$h&account.id=$CLOUDFLARE_ACCOUNT_ID" | jq -r '.result[0].id // empty') || return 1
        if [ -n "$z" ]; then printf '%s' "$z"; return 0; fi
        h="${h#*.}"
      done
      return 1
    }
    while IFS= read -r c; do
      host=$(jq -r .host <<<"$c")
      zone=$(zone_of "$host") || { echo "No zone in this account holds $host: its Health Check can't be made" >&2; exit 1; }
      checks=$(cfa GET "/zones/$zone/healthchecks")
      check_id=$(jq -r --arg n "$(jq -r .name <<<"$c")" '[.result[]? | select(.name == $n)][0].id // empty' <<<"$checks")
      if [ -n "$check_id" ]; then
        cfa PUT "/zones/$zone/healthchecks/$check_id" <<<"$(jq -c .body <<<"$c")" >/dev/null
        echo "Health Check $(jq -r .name <<<"$c") updated: https://$host/health/deep every minute"
      else
        check_id=$(cfa POST "/zones/$zone/healthchecks" <<<"$(jq -c .body <<<"$c")" | jq -er .result.id)
        echo "Created Health Check $(jq -r .name <<<"$c"): https://$host/health/deep every minute"
      fi
      ensure_policy "$(jq -r .policy <<<"$c")" health_check_status_notification \
        "$(jq -r .name <<<"$c") went unhealthy or recovered" "$(jq -nc --arg i "$check_id" '{health_check_id: [$i]}')"
    done < <(jq -c '.healthChecks[]' <<<"$alert_spec")
  fi
fi
# alerts:end
if [ -n "$alerts_xtrace" ]; then set -x; fi

# The GitHub environment the deploy job runs in, and its secrets. A secret already set is left
# alone; the setup code is generated and kept in .secrets/<id>/ (gitignored) for the first admin.
#
# Only main may deploy to the environment, and so read its secrets: a workflow on any other branch
# would hold every one. A PUT replaces the environment's protection rules, so the environment is
# read first: one already limited to its own branches is left as it is, and otherwise the PUT
# carries the wait timer, the required reviewers and the self-review setting it already has.
# github-environment:begin
environment="repos/{owner}/{repo}/environments/$ENVIRONMENT"
if current=$(gh api "$environment" 2>&1); then
  :
elif grep -q 'HTTP 404' <<<"$current"; then
  current='{}'
else
  # Not "it doesn't exist": a token without the scope reads nothing, and a PUT would then drop
  # reviewers it couldn't see.
  echo "Could not read the GitHub environment $ENVIRONMENT (needs a token with admin access): $current" >&2
  exit 1
fi
if [ "$(jq -r '.deployment_branch_policy.custom_branch_policies // false' <<<"$current")" != true ]; then
  jq '{
    wait_timer: ([.protection_rules[]? | select(.type == "wait_timer") | .wait_timer] | first // 0),
    prevent_self_review: ([.protection_rules[]? | select(.type == "required_reviewers") | .prevent_self_review] | first // false),
    reviewers: [.protection_rules[]? | select(.type == "required_reviewers") | .reviewers[]? | {type: .type, id: .reviewer.id}],
    deployment_branch_policy: {protected_branches: false, custom_branch_policies: true}
  }' <<<"$current" | gh api --method PUT "$environment" --input - >/dev/null
  echo "Limited $ENVIRONMENT to its own branch policies"
fi
if ! gh api "$environment/deployment-branch-policies" | jq -e '.branch_policies[]? | select(.name == "main" and (.type // "branch") == "branch")' >/dev/null; then
  gh api --method POST "$environment/deployment-branch-policies" -f name=main -f type=branch >/dev/null
  echo "Allowed main to deploy to $ENVIRONMENT"
fi
# github-environment:end
# The keys both Workers share: PRINCIPAL_KEY signs the requests the web Worker forwards and the
# engine checks; DATA_KEY encrypts the secrets they store. CI sets them on both Workers and won't
# deploy without them, so a deployment that already runs gets them here too. PASSWORD_PEPPER is
# mixed into the web Worker's password hashes; a deployment that adds it later keeps working
# (older hashes are stored again with it at each sign-in), but once set it must never change or
# go: every password hashed with it would stop verifying. The same holds for DATA_KEY, which
# sealed every stored secret, so neither is generated while the web Worker already holds one: a
# new value would replace it on the next deploy. None is ever written to disk.
EXISTING=$(gh secret list --env "$ENVIRONMENT" --json name -q '.[].name')
RUNNING=false
WORKER_SECRETS=""
if WORKER_SECRETS=$(wrangler secret list --name "$WEB" 2>/dev/null); then
  RUNNING=true
  WORKER_SECRETS=$(jq -r '.[].name' <<<"$WORKER_SECRETS" 2>/dev/null || true)
fi
# A content deployment also needs TOKEN_PEPPER (in every API key hash: it never changes once the api
# holds one, so the api's secrets are read as the web Worker's are) and MEDIA_SIGNING_SECRET (signs
# media URLs, so a lost one only invalidates URLs already handed out). The studio's PRINCIPAL_KEY,
# DATA_KEY, PASSWORD_PEPPER and SETUP_TOKEN are the ones above: one environment holds them all. The
# pipeline's assistant keys aren't generated: every deploy derives them from PRINCIPAL_KEY.
KEYS="PRINCIPAL_KEY DATA_KEY PASSWORD_PEPPER"
if [ "$CONTENT" = true ]; then
  KEYS="$KEYS TOKEN_PEPPER MEDIA_SIGNING_SECRET"
  if API_HELD=$(wrangler secret list --name "$API" 2>/dev/null); then
    WORKER_SECRETS+=$'\n'$(jq -r '.[].name' <<<"$API_HELD" 2>/dev/null || true)
  fi
fi
for KEY in $KEYS; do
  if grep -qx "$KEY" <<<"$EXISTING"; then
    echo "$ENVIRONMENT already has $KEY"
  elif [ "$KEY" != PRINCIPAL_KEY ] && [ "$KEY" != MEDIA_SIGNING_SECRET ] && grep -qx "$KEY" <<<"$WORKER_SECRETS"; then
    echo "$ENVIRONMENT has no $KEY, but a Worker already holds one. Set the deployment's own value on"
    echo "$ENVIRONMENT from its escrowed copy; a new one would make what it protects unreadable."
    exit 1
  else
    openssl rand -hex 32 | tr -d '\n' | gh secret set "$KEY" --env "$ENVIRONMENT"
    echo "Set $KEY on $ENVIRONMENT"
  fi
done
# The Turnstile widget on password sign-in, /setup and the storefront's card payment
# (docs/operations.md, "Turnstile"): managed, for the deployment's domain alone (its subdomains,
# `shop.` included, are covered), and named like its web Worker, so each deployment on a shared
# account finds its own. Its site key is public: it goes in the registry, which turns the check on.
# Its secret goes from the API straight into the environment, as TURNSTILE_SECRET_KEY, and nowhere
# else: never printed, never on disk. Set it before the registry has the key, or the deploy stops.
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  widgets="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/challenges/widgets"
  cf() { curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$@"; }
  # Every widget in the account, one JSON object a line, page by page.
  list_widgets() {
    local page=1 pages=1 body
    while [ "$page" -le "$pages" ]; do
      body=$(cf "$widgets?per_page=1000&page=$page")
      jq -c '.result[] | {sitekey, name, domains}' <<<"$body"
      pages=$(jq -r '.result_info.total_pages // 1' <<<"$body")
      page=$((page + 1))
    done
  }
  all_widgets=$(list_widgets)
  # The registry's key names the widget when it has one; otherwise the name does.
  if [ -n "$TURNSTILE_SITE_KEY" ]; then
    sitekey=$(jq -rs --arg k "$TURNSTILE_SITE_KEY" 'map(select(.sitekey == $k))[0].sitekey // empty' <<<"$all_widgets")
    if [ -z "$sitekey" ]; then
      echo "turnstileSiteKey in deployments/$id.jsonc is no widget in this account: fix it, or remove" >&2
      echo "it to find or create $WEB" >&2
      exit 1
    fi
  else
    named=$(jq -s --arg n "$WEB" 'map(select(.name == $n)) | length' <<<"$all_widgets")
    [ "$named" -gt 1 ] && echo "WARNING: $named Turnstile widgets are named $WEB; using the first" >&2
    sitekey=$(jq -rs --arg n "$WEB" 'map(select(.name == $n))[0].sitekey // empty' <<<"$all_widgets")
  fi
  if [ -n "$sitekey" ]; then
    echo "Turnstile widget $WEB already exists"
    # Its domains are where its tokens can be solved: anything besides this deployment's is a
    # widget shared with, or left over from, something else.
    domains=$(jq -cs --arg k "$sitekey" 'map(select(.sitekey == $k))[0].domains | sort' <<<"$all_widgets")
    if [ "$domains" != "$(jq -cn --arg d "$DOMAIN" '[$d]')" ]; then
      echo "WARNING: Turnstile widget $sitekey has domains $domains, not [\"$DOMAIN\"]." >&2
      echo "WARNING: give it exactly $DOMAIN in the dashboard (Turnstile > the widget > Hostnames)." >&2
    fi
  else
    # Only the site key is read from the answer; the secret is fetched below, if it's needed.
    sitekey=$(cf -X POST "$widgets" -H 'Content-Type: application/json' \
      --data "$(jq -n --arg n "$WEB" --arg d "$DOMAIN" '{name: $n, domains: [$d], mode: "managed"}')" |
      jq -er .result.sitekey)
    echo "Created Turnstile widget $WEB for $DOMAIN"
  fi
  if grep -qx TURNSTILE_SECRET_KEY <<<"$EXISTING"; then
    echo "$ENVIRONMENT already has TURNSTILE_SECRET_KEY"
  else
    (
      set +x
      secret=$(cf "$widgets/$sitekey" | jq -jer .result.secret)
      [ -n "$secret" ] || { echo "Turnstile widget $WEB returned no secret" >&2; exit 1; }
      printf '%s' "$secret" | gh secret set TURNSTILE_SECRET_KEY --env "$ENVIRONMENT"
    )
    echo "Set TURNSTILE_SECRET_KEY on $ENVIRONMENT"
  fi
  if [ "$TURNSTILE_SITE_KEY" = "$sitekey" ]; then
    echo "deployments/$id.jsonc has the widget's turnstileSiteKey"
  else
    echo "To turn on Turnstile, set \"turnstileSiteKey\": \"$sitekey\" in deployments/$id.jsonc"
  fi
else
  echo "Skipped the Turnstile widget: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or create"
  echo "\"$WEB\" in the dashboard (Turnstile > Add widget: managed, domain $DOMAIN), set its secret as"
  echo "TURNSTILE_SECRET_KEY on $ENVIRONMENT, and its site key as turnstileSiteKey in the registry."
fi

# A Worker that already runs has its own secrets, set by hand or by an earlier deploy: a new
# generated one would replace them on the next deploy, so only a new deployment gets them.
if $RUNNING; then
  echo "$WEB already exists: set its secrets on $ENVIRONMENT by hand if CI should manage them."
  exit 0
fi
existing=$(gh secret list --env "$ENVIRONMENT" --json name -q '.[].name')
mkdir -p ".secrets/$id"
chmod 700 ".secrets/$id"
file=".secrets/$id/setup-code"
if grep -qx SETUP_TOKEN <<<"$existing"; then
  echo "$ENVIRONMENT already has SETUP_TOKEN"
else
  [ -s "$file" ] || (umask 077 && openssl rand -hex 16 | tr -d '\n' >"$file")
  gh secret set SETUP_TOKEN --env "$ENVIRONMENT" <"$file"
  echo "Set SETUP_TOKEN on $ENVIRONMENT (value in $file)"
fi

echo
echo "Next: add CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to $ENVIRONMENT if they aren't"
echo "repository secrets, commit deployments/$id.jsonc, and merge: CI deploys it in its ring."
echo "Then send the customer's first admin https://$DOMAIN/setup and the setup code in $file."
if [ "$CONTENT" = true ]; then
  echo "The content stack's first admin signs up at https://$STUDIO_DOMAIN/setup with the same code. Once the"
  echo "deployment is merged and deployed, register https://$STUDIO_DOMAIN/login/sso/callback with the identity"
  echo "provider too, if the registry has sso."
fi
