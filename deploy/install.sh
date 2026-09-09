#!/usr/bin/env bash
#
# Interactive installer for a single Pombo storage node. Run it from this
# directory after Docker is installed (HOW_TO_INSTALL.md steps 0-2):
#
#   ./install.sh
#
# It asks for what only you can provide (a key, a hostname), does the rest
# (config, build, on-chain preparation, bring-up, HTTPS), and pauses for the
# steps that live outside the machine: funding the node with POL, pointing DNS
# at it, and opening the firewall ports.
set -euo pipefail
cd "$(dirname "$0")"

RPCS='[ { "url": "https://polygon.drpc.org" }, { "url": "https://polygon-bor-rpc.publicnode.com" }, { "url": "https://rpc.ankr.com/polygon" } ]'
CONFIG_IN_CONTAINER="/home/streamr/.streamr/config/pombo-node.json"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask() { local prompt="$1" default="${2:-}" reply; read -rp "$prompt " reply; echo "${reply:-$default}"; }

command -v docker >/dev/null || { echo "Docker is not installed. See HOW_TO_INSTALL.md step 1."; exit 1; }
# Fall back to sudo when the user is not yet in the docker group (fresh install, group not applied to this shell).
DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sudo docker"
$DOCKER compose version >/dev/null 2>&1 || { echo "The docker compose plugin is missing. See HOW_TO_INSTALL.md step 1."; exit 1; }

say "Pombo storage node installer"

# --- the key ---
if [[ "$(ask 'Do you already have a node private key? [y/N]' n)" =~ ^[Yy] ]]; then
    read -rsp "Paste the private key (0x + 64 hex): " PRIVATE_KEY; echo
else
    PRIVATE_KEY="0x$(openssl rand -hex 32)"
    say "Generated a new private key for this node. It is written into the config; back it up."
fi
[[ "$PRIVATE_KEY" =~ ^0x[0-9a-fA-F]{64}$ ]] || { echo "That is not a valid private key (need 0x followed by 64 hex characters)."; exit 1; }

# --- the hostname ---
say "The Pombo web app only reads from an https:// endpoint on a real hostname."
HOSTNAME_PUBLIC="$(ask 'Public hostname for this node (e.g. node.example.org; blank = local test only):')"

# --- signed reads ---
SIGNED_READS=true
[[ "$(ask 'Require signed reads on gated channels? [Y/n]' y)" =~ ^[Nn] ]] && SIGNED_READS=false

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
            "cluster": { "clusterSize": 1, "myIndexInCluster": 0 },
            "signedReads": { "enabled": $SIGNED_READS }
        }
    }
}
EOF
chmod 600 config/pombo-node.json
say "Wrote config/pombo-node.json"

# --- build the image (needed for the register one-offs below and for the node) ---
say "Building the node image (the first build takes several minutes)..."
$DOCKER compose build node

# --- derive the node address from the key (a local operation, no funds needed) ---
say "Reading the node address from the key..."
ADDRESS="$($DOCKER compose run --rm --no-deps -T node node dist/bin/streamr-storage-node-register.js --print-address --config "$CONFIG_IN_CONTAINER" 2>/dev/null | tr -d '[:space:]')"
[[ "$ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]] || {
    echo "Could not derive the node address. Run without hiding errors to see why:"
    echo "  $DOCKER compose run --rm --no-deps node node dist/bin/streamr-storage-node-register.js --print-address --config $CONFIG_IN_CONTAINER"
    exit 1
}
say "This node's address is: $ADDRESS"

# --- fund, outside the machine ---
# The node cannot start until its assignment stream exists on-chain, and creating
# that stream (and registering the URL) spends POL. So funding comes before bring-up.
say "Fund this address with about 1 POL from any wallet. It pays for creating the node's"
say "assignment stream and registering it. If the key you pasted already has POL, just continue."
read -rp "Press Enter once the address has POL... " _

# --- prepare the node on-chain: create the assignment stream (and register the URL if given) ---
if [[ -n "$HOSTNAME_PUBLIC" ]]; then
    say "Creating the assignment stream and registering https://$HOSTNAME_PUBLIC ..."
    $DOCKER compose run --rm --no-deps node node dist/bin/streamr-storage-node-register.js "https://$HOSTNAME_PUBLIC" --config "$CONFIG_IN_CONTAINER"
else
    say "Creating the assignment stream (no hostname given, so the URL is not registered yet)..."
    $DOCKER compose run --rm --no-deps node node dist/bin/streamr-storage-node-register.js --config "$CONFIG_IN_CONTAINER"
fi

# --- start the node and its database ---
say "Starting the node and Cassandra..."
$DOCKER compose up -d

# --- wait until the node reports its address (now that the assignment stream exists) ---
say "Waiting for the node to come up..."
UP=""
for _ in $(seq 1 60); do
    if $DOCKER compose logs node 2>/dev/null | grep -qi "Node address $ADDRESS"; then
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
    echo "POMBO_NODE_DOMAIN=$HOSTNAME_PUBLIC" > .env
    $DOCKER compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
    say "Done. From another machine, check:  curl https://$HOSTNAME_PUBLIC/capabilities"
    say "If the certificate is still being issued, wait a minute and retry."
else
    say "No hostname was given, so there is no HTTPS yet. When you have one, put it in the"
    say "config, register the URL, and start Caddy:"
    echo "  docker compose run --rm node node dist/bin/streamr-storage-node-register.js https://YOUR_HOST --config $CONFIG_IN_CONTAINER"
    echo "  cp Caddyfile.example Caddyfile && echo POMBO_NODE_DOMAIN=YOUR_HOST > .env"
    echo "  docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d"
fi

say "Retention runs automatically. See POMBO.md to tune it."
