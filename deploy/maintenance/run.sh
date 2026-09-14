#!/usr/bin/env bash
#
# Periodic Cassandra maintenance for a cluster node, in place of host timers:
#   repair -full -pr   daily,  at 16:00 UTC + 12 h per ordinal
#   garbagecollect     weekly, Sunday 03:00 UTC + 6 h per ordinal
# With -pr each node repairs only its own primary ranges, so every node runs
# this, staggered by POMBO_NODE_ORDINAL. A single node has no replicas and
# does not need it.
#
#   run.sh            loop forever (the sidecar's entrypoint)
#   run.sh repair     run one repair now and exit
#   run.sh gc         run one garbagecollect now and exit
set -u
ORDINAL="${POMBO_NODE_ORDINAL:-0}"
KEYSPACE="${KEYSPACE:-pombo_storage}"
REPAIR_HOUR=$(( (16 + 12 * ORDINAL) % 24 ))
GC_HOUR=$(( (3 + 6 * ORDINAL) % 24 ))

log() { printf '%s maintenance: %s\n' "$(date -u +%FT%TZ)" "$*"; }
repair() { timeout 4h nodetool repair -full -pr "$KEYSPACE"; }
gc() { timeout 6h nodetool garbagecollect "$KEYSPACE" stream_data bucket; }

case "${1:-}" in
    repair) exec nodetool repair -full -pr "$KEYSPACE" ;;
    gc)     exec nodetool garbagecollect "$KEYSPACE" stream_data bucket ;;
    "")     ;;
    *)      echo "usage: run.sh [repair|gc]" >&2; exit 2 ;;
esac

log "ordinal $ORDINAL: repair daily at ${REPAIR_HOUR}:00 UTC, garbagecollect Sundays at ${GC_HOUR}:00 UTC"
last_repair=""
last_gc=""
while true; do
    day="$(date -u +%F)"
    hour=$((10#$(date -u +%H)))
    dow="$(date -u +%u)"
    if (( hour == REPAIR_HOUR )) && [[ "$last_repair" != "$day" ]]; then
        last_repair="$day"
        log "repair -full -pr $KEYSPACE starting"
        if repair; then log "repair done"; else log "repair FAILED (exit $?)"; fi
    fi
    if (( dow == 7 && hour == GC_HOUR )) && [[ "$last_gc" != "$day" ]]; then
        last_gc="$day"
        log "garbagecollect $KEYSPACE starting"
        if gc; then log "garbagecollect done"; else log "garbagecollect FAILED (exit $?)"; fi
    fi
    sleep 60
done
