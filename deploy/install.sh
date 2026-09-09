#!/usr/bin/env bash
#
# Interactive installer for a Pombo storage node: a single node, or one member
# of a multi-machine cluster. Run it from this directory after Docker is
# installed (HOW_TO_INSTALL.md steps 0-2):
#
#   ./install.sh
#
# It asks for what only you can provide (a key, a hostname, the cluster shape),
# does the rest (config, image, on-chain preparation, bring-up, HTTPS), and
# pauses for the steps that live outside the machine: funding the node with POL,
# pointing DNS at it, and opening the firewall ports. It pulls the prebuilt
# image, falling back to building from source only when a full source tree is
# present next to this script.
set -euo pipefail
cd "$(dirname "$0")"

RPCS='[ { "url": "https://polygon.drpc.org" }, { "url": "https://polygon-bor-rpc.publicnode.com" }, { "url": "https://rpc.ankr.com/polygon" } ]'
CONFIG_IN_CONTAINER="/home/streamr/.streamr/config/pombo-node.json"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask() { local prompt="$1" default="${2:-}" reply; read -rp "$prompt " reply; echo "${reply:-$default}"; }
# Re-prompt until the answer is valid instead of aborting the install. The prompt
# and any error go to stderr (read -p already does), so $(...) captures only the value.
ask_int() {
    local prompt="$1" min="$2" max="$3" default="${4:-}" reply
    while true; do
        read -rp "$prompt " reply; reply="${reply:-$default}"
        if [[ "$reply" =~ ^[0-9]+$ ]] && (( reply >= min && reply <= max )); then echo "$reply"; return 0; fi
        echo "Please enter a whole number between $min and $max." >&2
    done
}
ask_ip() {
    local prompt="$1" default="${2:-}" reply
    while true; do
        read -rp "$prompt " reply; reply="${reply:-$default}"
        if [[ "$reply" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then echo "$reply"; return 0; fi
        echo "Please enter a valid IPv4 address (e.g. 203.0.113.10)." >&2
    done
}

command -v docker >/dev/null || { echo "Docker is not installed. See HOW_TO_INSTALL.md step 1."; exit 1; }
# Fall back to sudo when the user is not yet in the docker group (fresh install, group not applied to this shell).
DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sudo docker"
$DOCKER compose version >/dev/null 2>&1 || { echo "The docker compose plugin is missing. See HOW_TO_INSTALL.md step 1."; exit 1; }

say "Pombo storage node installer"

# --- the key ---
if [[ "$(ask 'Do you already have a node private key? [y/N]' n)" =~ ^[Yy] ]]; then
    while true; do
        read -rsp "Paste the private key (0x + 64 hex): " PRIVATE_KEY; echo
        [[ "$PRIVATE_KEY" =~ ^0x[0-9a-fA-F]{64}$ ]] && break
        echo "That is not a valid private key (need 0x followed by 64 hex characters). Try again."
    done
else
    PRIVATE_KEY="0x$(openssl rand -hex 32)"
    say "Generated a new private key for this node. It is written into the config; back it up."
fi

# --- the hostname ---
say "The Pombo web app only reads from an https:// endpoint on a real hostname."
HOSTNAME_PUBLIC="$(ask 'Public hostname for this node (e.g. node.example.org; blank = local test only):')"

# --- signed reads ---
SIGNED_READS=true
[[ "$(ask 'Require signed reads on gated channels? [Y/n]' y)" =~ ^[Nn] ]] && SIGNED_READS=false

# --- cluster shape ---
# A cluster is N machines sharing one key and one replicated Cassandra. Each node
# has a distinct index and stores only its share of stream-partitions (splitting
# overlay/CPU load), but every node keeps a full Cassandra copy so any node can
# serve any read. The overlay node id derives from the IP, so sharing one key
# across machines is safe.
CLUSTER=false
CLUSTER_SIZE=1
NODE_INDEX=0
IS_SEED=true
SEED_IP=""
THIS_PUBLIC_IP=""
if [[ "$(ask 'Is this node part of a MULTI-MACHINE cluster? [y/N]' n)" =~ ^[Yy] ]]; then
    CLUSTER=true
    CLUSTER_SIZE="$(ask_int 'How many nodes in the cluster (total machines)?' 2 64 2)"
    if [[ "$(ask 'Is this the FIRST node (the seed, index 0)? [Y/n]' y)" =~ ^[Nn] ]]; then
        IS_SEED=false
        if (( CLUSTER_SIZE == 2 )); then
            NODE_INDEX=1
            say "A 2-node cluster has one joining node, so this node's index is 1."
        else
            NODE_INDEX="$(ask_int "This node's index (1..$((CLUSTER_SIZE-1))):" 1 "$((CLUSTER_SIZE-1))")"
        fi
        SEED_IP="$(ask_ip 'Public IP of the first node (the Cassandra seed):')"
    fi
    DETECTED_IP="$(curl -fsSL https://api.ipify.org 2>/dev/null || true)"
    THIS_PUBLIC_IP="$(ask_ip "This machine's public IP:" "$DETECTED_IP")"
    [[ "$IS_SEED" == true ]] && SEED_IP="$THIS_PUBLIC_IP"
fi

# --- the network block (public node advertises its hostname; a local one asks for no public port) ---
if [[ -n "$HOSTNAME_PUBLIC" ]]; then
    NETWORK="\"network\": { \"controlLayer\": { \"websocketHost\": \"$HOSTNAME_PUBLIC\", \"websocketPortRange\": { \"min\": 32200, \"max\": 32200 } } }"
else
    NETWORK="\"network\": { \"controlLayer\": { \"websocketPortRange\": null } }"
fi

# --- write the config ---
mkdir -p config
cat > config/pombo-node.json <<EOF
{
    "client": {
        "auth": { "privateKey": "$PRIVATE_KEY" },
        "environment": "polygon",
        "contracts": { "rpcs": $RPCS, "rpcQuorum": 1 },
        "cache": { "maxAge": 600000 },
        $NETWORK
    },
    "httpServer": { "port": 8002 },
    "plugins": {
        "storage": {
            "cassandra": { "hosts": ["cassandra"], "username": "", "password": "", "keyspace": "streamr", "datacenter": "datacenter1" },
            "storageConfig": { "refreshInterval": 600000 },
            "cluster": { "clusterSize": $CLUSTER_SIZE, "myIndexInCluster": $NODE_INDEX },
            "signedReads": { "enabled": $SIGNED_READS }
        }
    }
}
EOF
chmod 600 config/pombo-node.json
say "Wrote config/pombo-node.json (clusterSize=$CLUSTER_SIZE, myIndexInCluster=$NODE_INDEX)"

# --- compose files and .env ---
COMPOSE="-f docker-compose.yml"
[[ "$CLUSTER" == true ]] && COMPOSE="$COMPOSE -f docker-compose.cluster.yml"
{
    [[ -n "$HOSTNAME_PUBLIC" ]] && echo "POMBO_NODE_DOMAIN=$HOSTNAME_PUBLIC"
    if [[ "$CLUSTER" == true ]]; then
        echo "THIS_PUBLIC_IP=$THIS_PUBLIC_IP"
        echo "CASSANDRA_SEEDS=$SEED_IP"
    fi
} > .env

# --- get the node image: pull the published one, else build only if source is present ---
if $DOCKER compose $COMPOSE -f docker-compose.image.yml pull node >/dev/null 2>&1; then
    COMPOSE="$COMPOSE -f docker-compose.image.yml"
    say "Pulled the prebuilt node image."
elif [[ -f ../Dockerfile.node ]]; then
    say "Prebuilt image not available; building from source (several minutes)..."
    $DOCKER compose $COMPOSE build node
else
    echo "Could not pull the prebuilt image, and there is no source tree here to build from."
    echo "Check your network, or clone the full repository and run deploy/install.sh from there:"
    echo "  git clone --branch pombo/103.3.1 https://github.com/Pombo-app/pombo-storage-node.git"
    echo "  cd pombo-storage-node/deploy && ./install.sh"
    exit 1
fi

# --- cluster: the ports the peers use must be open before Cassandra can form a ring ---
if [[ "$CLUSTER" == true ]]; then
    say "Cluster networking: Cassandra ports 7000 and 9042 must be reachable between the cluster"
    say "machines, each allowed only from the other machines' IPs (a /32 rule per peer), NEVER from"
    say "0.0.0.0/0 (Cassandra has no authentication here). Open them now if you have not."
    [[ "$IS_SEED" == true ]] || say "Start the FIRST node (the seed) before this one; this node waits for the ring to form."
    read -rp "Press Enter once 7000 and 9042 are open between the cluster machines... " _
fi

# --- derive the node address from the key (a local operation, no funds needed) ---
say "Reading the node address from the key..."
ADDRESS="$($DOCKER compose $COMPOSE run --rm --no-deps -T node node dist/bin/streamr-storage-node-register.js --print-address --config "$CONFIG_IN_CONTAINER" 2>/dev/null | tr -d '[:space:]')"
[[ "$ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]] || {
    echo "Could not derive the node address. Run without hiding errors to see why:"
    echo "  $DOCKER compose $COMPOSE run --rm --no-deps node node dist/bin/streamr-storage-node-register.js --print-address --config $CONFIG_IN_CONTAINER"
    exit 1
}
say "This node's address is: $ADDRESS"

wait_for_cassandra() {
    say "Waiting for Cassandra to answer..."
    for _ in $(seq 1 30); do
        $DOCKER compose $COMPOSE exec -T cassandra cqlsh -e "DESCRIBE KEYSPACES" >/dev/null 2>&1 && return 0
        sleep 5
    done
    echo "Cassandra did not become ready in time. Check: $DOCKER compose logs cassandra"; exit 1
}

register_urls() {
    # $1 = comma-separated URLs. Creates the assignment stream and registers the URLs.
    say "Fund this address with about 1 POL from any wallet: $ADDRESS"
    say "It pays once for creating the node's assignment stream and registering it. If the key"
    say "already has POL, just continue."
    read -rp "Press Enter once the address has POL... " _
    say "Creating the assignment stream and registering: $1"
    $DOCKER compose $COMPOSE run --rm --no-deps node node dist/bin/streamr-storage-node-register.js "$1" --config "$CONFIG_IN_CONTAINER"
}

if [[ "$CLUSTER" == true ]]; then
    # Bring up Cassandra on its own first, so the ring and schema settle before the node starts.
    say "Starting Cassandra..."
    $DOCKER compose $COMPOSE up -d cassandra
    wait_for_cassandra

    if [[ "$IS_SEED" == true ]]; then
        say "Creating the replicated keyspace (replication factor $CLUSTER_SIZE, every node a full copy)..."
        sed "s/'datacenter1': 2/'datacenter1': $CLUSTER_SIZE/" cassandra/init-cluster.cql > /tmp/pombo-init-cluster.cql
        $DOCKER compose $COMPOSE cp /tmp/pombo-init-cluster.cql cassandra:/tmp/init-cluster.cql
        $DOCKER compose $COMPOSE exec -T cassandra cqlsh -f /tmp/init-cluster.cql
        rm -f /tmp/pombo-init-cluster.cql
    else
        say "Waiting for the Cassandra ring to reach $CLUSTER_SIZE nodes Up/Normal..."
        RING=""
        for _ in $(seq 1 60); do
            UN="$($DOCKER compose $COMPOSE exec -T cassandra nodetool status 2>/dev/null | grep -cE '^UN[[:space:]]' || true)"
            if [[ "${UN:-0}" -ge "$CLUSTER_SIZE" ]]; then RING=1; break; fi
            sleep 5
        done
        [[ -n "$RING" ]] || {
            echo "The ring did not reach $CLUSTER_SIZE Up/Normal nodes. Check that 7000/9042 are open"
            echo "between the machines, the seed IP is correct, and the seed is running, then:"
            echo "  $DOCKER compose $COMPOSE exec cassandra nodetool status"
            exit 1
        }
        say "The Cassandra ring is up. Waiting for the keyspace to replicate here..."
        for _ in $(seq 1 30); do
            $DOCKER compose $COMPOSE exec -T cassandra cqlsh -e "USE streamr" >/dev/null 2>&1 && break
            sleep 5
        done
    fi

    if [[ "$IS_SEED" == true ]]; then
        say "A cluster registers every node's URL under the one shared key, once, from the seed."
        DEFAULT_URL=""; [[ -n "$HOSTNAME_PUBLIC" ]] && DEFAULT_URL="https://$HOSTNAME_PUBLIC"
        URLS="$(ask 'Every node URL, comma-separated (e.g. https://node1.example.org,https://node2.example.org):' "$DEFAULT_URL")"
        [[ -n "$URLS" ]] || { echo "At least the seed's URL is required to register the cluster."; exit 1; }
        register_urls "$URLS"
    else
        say "This joining node shares the seed's key, so the seed already created the assignment stream"
        say "and registered the URLs. No funding or registration is needed here."
    fi

    say "Starting the node..."
    $DOCKER compose $COMPOSE up -d
else
    # Single node: the assignment stream must exist before the node starts, and creating it
    # (and registering the URL) spends POL, so this comes before bring-up.
    if [[ -n "$HOSTNAME_PUBLIC" ]]; then
        register_urls "https://$HOSTNAME_PUBLIC"
    else
        say "Creating the assignment stream (no hostname given, so no URL is registered yet)..."
        say "Fund this address with about 1 POL first: $ADDRESS"
        read -rp "Press Enter once the address has POL... " _
        $DOCKER compose $COMPOSE run --rm --no-deps node node dist/bin/streamr-storage-node-register.js --config "$CONFIG_IN_CONTAINER"
    fi
    say "Starting the node and Cassandra..."
    $DOCKER compose $COMPOSE up -d
fi

# --- wait until the node reports its address (now that the assignment stream exists) ---
say "Waiting for the node to come up..."
UP=""
for _ in $(seq 1 60); do
    if $DOCKER compose $COMPOSE logs node 2>/dev/null | grep -qi "Node address $ADDRESS"; then
        UP=1
        break
    fi
    sleep 5
done
if [[ -z "$UP" ]]; then
    echo "The node did not report its address in time. It may still be indexing the new"
    echo "assignment stream; give it a minute, then check: $DOCKER compose logs node"
else
    say "The node is up: $ADDRESS"
fi

# --- HTTPS in front (only with a hostname) ---
if [[ -n "$HOSTNAME_PUBLIC" ]]; then
    say "Starting Caddy for HTTPS on $HOSTNAME_PUBLIC (needs ports 80 and 443 open, and DNS pointing here)..."
    [[ -f Caddyfile ]] || cp Caddyfile.example Caddyfile
    $DOCKER compose $COMPOSE -f docker-compose.caddy.yml up -d
    say "Done. From another machine, check:  curl https://$HOSTNAME_PUBLIC/capabilities"
    say "If the certificate is still being issued, wait a minute and retry."
else
    say "No hostname was given, so there is no HTTPS yet. When you have one, put it in the"
    say "config, register the URL, and start Caddy (see HOW_TO_INSTALL.md)."
fi

say "Retention runs automatically. See POMBO.md to tune it."
