#!/usr/bin/env bash
#
# Interactive installer for a Pombo storage node: a single node, or one member
# of a multi-machine cluster. Run it from this directory after Docker is
# installed (HOW_TO_INSTALL.md steps 0-2):
#
#   ./install.sh
#
# It asks for what only you can provide (a key, a hostname, the cluster shape),
# validates each answer, does the rest (config, image, tunnel, on-chain
# preparation, bring-up, HTTPS), and only continues past funding and the
# cross-machine tunnel once it has verified them on-chain / on the wire. It
# pulls the prebuilt image, falling back to building from source only when a
# full source tree is present.
set -euo pipefail
cd "$(dirname "$0")"

RPCS='[ { "url": "https://polygon.drpc.org" }, { "url": "https://polygon-bor-rpc.publicnode.com" }, { "url": "https://rpc.ankr.com/polygon" } ]'
RPC0="https://polygon.drpc.org"
MIN_WEI="20000000000000000"   # 0.02 POL: enough for the assignment stream + registration on Polygon
CONFIG_IN_CONTAINER="/home/streamr/.streamr/config/pombo-node.json"
# Cassandra names; set them in the environment to join an existing database under other names.
KEYSPACE="${CASSANDRA_KEYSPACE:-pombo_storage}"
CLUSTER_NAME="${CASSANDRA_CLUSTER_NAME:-pombo-storage}"
WG_PREFIX="10.10.0"           # machine i is $WG_PREFIX.(i+1) on the tunnel

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask() { local prompt="$1" default="${2:-}" reply; read -rp "$prompt " reply; echo "${reply:-$default}"; }
# All ask_* re-prompt until the answer is valid instead of aborting the install.
# The prompt and any error go to stderr, so $(...) captures only the value.
ask_yn() {
    local prompt="$1" default="${2:-}" hint reply
    case "$default" in y) hint='[Y/n]' ;; n) hint='[y/N]' ;; *) hint='[y/n]' ;; esac
    while true; do
        read -rp "$prompt $hint " reply; reply="${reply:-$default}"
        case "${reply,,}" in
            y|yes) return 0 ;;
            n|no)  return 1 ;;
            *) echo "Please answer y or n." >&2 ;;
        esac
    done
}
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
ask_wgkey() {
    local prompt="$1" reply
    while true; do
        read -rp "$prompt " reply
        if [[ "$reply" =~ ^[A-Za-z0-9+/]{43}=$ ]]; then echo "$reply"; return 0; fi
        echo "That is not a WireGuard public key (44 base64 characters ending in '=')." >&2
    done
}
# TCP reachability without extra tools: bash's /dev/tcp, guarded so a closed port never aborts the script.
tcp_open() { timeout 5 bash -c "cat < /dev/null > /dev/tcp/$1/$2" 2>/dev/null; }

command -v docker >/dev/null || { echo "Docker is not installed. See HOW_TO_INSTALL.md step 1."; exit 1; }
# Fall back to sudo when the user is not yet in the docker group (fresh install, group not applied to this shell).
DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sudo docker"
$DOCKER compose version >/dev/null 2>&1 || { echo "The docker compose plugin is missing. See HOW_TO_INSTALL.md step 1."; exit 1; }

say "Pombo storage node installer"

# This machine's public IP, used to sanity-check DNS.
DETECTED_IP="$(curl -fsSL --max-time 8 https://api.ipify.org 2>/dev/null || true)"

# --- the key ---
if ask_yn 'Do you already have a node private key?' n; then
    while true; do
        read -rsp "Paste the private key (0x + 64 hex): " PRIVATE_KEY; echo
        [[ "$PRIVATE_KEY" =~ ^0x[0-9a-fA-F]{64}$ ]] && break
        echo "That is not a valid private key (need 0x followed by 64 hex characters). Try again."
    done
else
    PRIVATE_KEY="0x$(openssl rand -hex 32)"
    say "Generated a new private key for this node. It is written into the config; back it up."
fi

# --- the hostname (validated, and checked against DNS when it resolves) ---
say "The Pombo web app only reads from an https:// endpoint on a real hostname."
while true; do
    HOSTNAME_PUBLIC="$(ask 'Public hostname for this node (e.g. node.example.org; blank = local test only):')"
    # Tolerate a pasted scheme or trailing path: we want the bare hostname.
    HOSTNAME_PUBLIC="${HOSTNAME_PUBLIC#http://}"; HOSTNAME_PUBLIC="${HOSTNAME_PUBLIC#https://}"; HOSTNAME_PUBLIC="${HOSTNAME_PUBLIC%%/*}"
    [[ -z "$HOSTNAME_PUBLIC" ]] && break
    if [[ ! "$HOSTNAME_PUBLIC" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$ ]]; then
        echo "That does not look like a hostname (e.g. node.example.org)." >&2; continue
    fi
    resolved="$(getent ahostsv4 "$HOSTNAME_PUBLIC" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
    if [[ -z "$resolved" ]]; then
        say "Warning: $HOSTNAME_PUBLIC does not resolve yet (DNS may still be propagating)."
        ask_yn 'Use it anyway?' y && break || continue
    elif [[ -n "$DETECTED_IP" ]] && ! grep -qw "$DETECTED_IP" <<<"$resolved"; then
        say "Warning: $HOSTNAME_PUBLIC resolves to ${resolved% }, not this machine ($DETECTED_IP)."
        say "HTTPS and the overlay will not work until it points here."
        ask_yn 'Use it anyway?' n && break || continue
    else
        break
    fi
done

# --- signed reads ---
SIGNED_READS=true
ask_yn 'Require signed reads on gated channels?' y || SIGNED_READS=false

# --- overlay port: 32200 unless another process on this machine already holds it ---
# The port the node listens on inside the container is the one published on the
# host and the one it advertises to the overlay, so all three must be the same.
WS_PORT="${POMBO_WS_PORT:-32200}"
if [[ -z "${POMBO_WS_PORT:-}" ]] && ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE ':32200$'; then
    say "Port 32200 is already in use on this machine (another Streamr node?)."
    WS_PORT="$(ask_int 'Overlay port for this node instead:' 1024 65535 32201)"
fi

# --- cluster shape ---
# A cluster is N machines sharing one key and one Cassandra ring replicated to
# every machine over a WireGuard tunnel. By default every node stores every
# stream (full redundancy: a machine being down loses nothing). The advanced
# split mode gives each node a distinct index so it stores only its share of
# stream-partitions (less overlay load per node, but a partition's history is
# not captured while its node is down). The overlay node id derives from the
# IP, so sharing one key across machines is safe.
CLUSTER=false
CLUSTER_SIZE=1
ORDINAL=0
IS_SEED=true
NODE_CLUSTER_SIZE=1
NODE_INDEX=0
WG_IP=""
WG_MTU=1280
PEERS=()          # <peer-wg-ip>,<peer-public-ip>,<peer-public-key>
if ask_yn 'Is this node part of a MULTI-MACHINE cluster?' n; then
    CLUSTER=true
    CLUSTER_SIZE="$(ask_int 'How many machines in the cluster?' 2 64 2)"
    ORDINAL="$(ask_int "This machine's number (0 = the first machine; 1..$((CLUSTER_SIZE-1)) = the others):" 0 "$((CLUSTER_SIZE-1))" 0)"
    (( ORDINAL == 0 )) || IS_SEED=false
    say "By default every node stores every stream, so any machine being down loses nothing."
    say "Advanced: split the stream-partitions between the nodes instead (each captures 1/$CLUSTER_SIZE,"
    say "less overlay load per node, but a partition's history is lost while its node is down)."
    if ask_yn 'Split the partitions between the nodes (advanced)?' n; then
        NODE_CLUSTER_SIZE="$CLUSTER_SIZE"
        NODE_INDEX="$ORDINAL"
    fi
    WG_IP="$WG_PREFIX.$((ORDINAL+1))"

    # --- the tunnel: keys first, so every machine can be asked for its peers' keys ---
    say "The machines talk over a WireGuard tunnel (wg0, $WG_PREFIX.0/24); Cassandra is reachable only"
    say "through it. This machine is $WG_IP. Open UDP 51820 to the internet on your cloud firewall /"
    say "security list for every machine; the installer opens it on the host firewall itself."
    chmod +x wg-setup.sh
    PUBKEY="$(./wg-setup.sh key)"
    say "This machine's WireGuard public key (the other machines' installers will ask for it):"
    echo "  $PUBKEY"
    say "Run the installer on every other machine up to this point, then enter their details here."
    for (( i = 0; i < CLUSTER_SIZE; i++ )); do
        (( i == ORDINAL )) && continue
        pip="$(ask_ip "Machine $i ($WG_PREFIX.$((i+1))) public IP:")"
        pkey="$(ask_wgkey "Machine $i WireGuard public key:")"
        PEERS+=("$WG_PREFIX.$((i+1)),$pip,$pkey")
    done
    WG_MTU="$(ask_int 'Tunnel MTU (1280 works on any path; up to 1420 when the path carries 1500-byte packets):' 1200 1420 1280)"
    say "Bringing the tunnel up..."
    ./wg-setup.sh up "$WG_IP" "$WG_MTU" "${PEERS[@]}"
    for p in "${PEERS[@]}"; do
        pwg="${p%%,*}"
        say "Checking the tunnel to $pwg (the other machine must have reached this step too)..."
        r=""
        until ping -c 1 -W 3 -M do -s $((WG_MTU - 28)) "$pwg" >/dev/null 2>&1; do
            say "No answer from $pwg through the tunnel yet. Check that UDP 51820 is open on both cloud"
            say "firewalls, that the public IPs and keys are right, and that the other installer has"
            say "brought its tunnel up (this check needs the other machine past the same step)."
            read -rp "Press Enter to re-check (or type 'skip' to proceed anyway): " r
            [[ "$r" == skip ]] && break
        done
        [[ "$r" == skip ]] || say "Tunnel to $pwg is up (MTU $WG_MTU verified)."
    done
fi

# --- the network block (public node advertises its hostname; a local one asks for no public port) ---
if [[ -n "$HOSTNAME_PUBLIC" ]]; then
    NETWORK="\"network\": { \"controlLayer\": { \"websocketHost\": \"$HOSTNAME_PUBLIC\", \"websocketPortRange\": { \"min\": $WS_PORT, \"max\": $WS_PORT } } }"
else
    NETWORK="\"network\": { \"controlLayer\": { \"websocketPortRange\": null } }"
fi

# --- write the config ---
# The node reaches its own Cassandra by service name and the peers' by tunnel
# address (the driver discovers the whole ring from any of them). Retention
# deletes replicate through Cassandra, so only machine 0 runs it.
HOSTS='"cassandra"'
for p in ${PEERS[@]+"${PEERS[@]}"}; do HOSTS="$HOSTS, \"${p%%,*}\""; done
RETENTION=true
(( ORDINAL == 0 )) || RETENTION=false
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
            "cassandra": { "hosts": [$HOSTS], "username": "", "password": "", "keyspace": "$KEYSPACE", "datacenter": "dc1" },
            "storageConfig": { "refreshInterval": 60000 },
            "cluster": { "clusterSize": $NODE_CLUSTER_SIZE, "myIndexInCluster": $NODE_INDEX },
            "retention": { "enabled": $RETENTION, "abortFractionPercent": 80 },
            "signedReads": { "enabled": $SIGNED_READS }
        }
    }
}
EOF
chmod 600 config/pombo-node.json
# The node runs as uid 1000 inside the image; when the installer runs as root the
# file must still be readable there.
chown 1000:1000 config/pombo-node.json 2>/dev/null || true
say "Wrote config/pombo-node.json (clusterSize=$NODE_CLUSTER_SIZE, myIndexInCluster=$NODE_INDEX, retention=$RETENTION)"

# --- compose files and .env ---
COMPOSE="-f docker-compose.yml"
[[ "$CLUSTER" == true ]] && COMPOSE="$COMPOSE -f docker-compose.cluster.yml"
SEEDS=""
for (( i = 0; i < CLUSTER_SIZE; i++ )); do SEEDS="$SEEDS${SEEDS:+,}$WG_PREFIX.$((i+1))"; done
{
    [[ -n "$HOSTNAME_PUBLIC" ]] && echo "POMBO_NODE_DOMAIN=$HOSTNAME_PUBLIC"
    echo "POMBO_WS_PORT=$WS_PORT"
    # Sizing, when given in the installer's environment (defaults suit a 4 GB box).
    [[ -n "${CASSANDRA_HEAP:-}" ]] && echo "CASSANDRA_HEAP=$CASSANDRA_HEAP"
    [[ -n "${CASSANDRA_HEAP_NEW:-}" ]] && echo "CASSANDRA_HEAP_NEW=$CASSANDRA_HEAP_NEW"
    [[ -n "${NODE_OLD_SPACE_MB:-}" ]] && echo "NODE_OLD_SPACE_MB=$NODE_OLD_SPACE_MB"
    [[ -n "${POMBO_NODE_TAG:-}" ]] && echo "POMBO_NODE_TAG=$POMBO_NODE_TAG"
    echo "POMBO_NODE_ORDINAL=$ORDINAL"
    echo "CASSANDRA_CLUSTER_NAME=$CLUSTER_NAME"
    echo "CASSANDRA_KEYSPACE=$KEYSPACE"
    echo "CASSANDRA_RACK=rack$((ORDINAL+1))"
    if [[ "$CLUSTER" == true ]]; then
        echo "WG_IP=$WG_IP"
        echo "CASSANDRA_SEEDS=$SEEDS"
    fi
} > .env

# --- get the node image: pull the published one, else build only if source is present ---
if $DOCKER compose $COMPOSE -f docker-compose.image.yml pull node >/dev/null 2>&1; then
    COMPOSE="$COMPOSE -f docker-compose.image.yml"
    say "Pulled the prebuilt node image."
    # The concrete version comes from the image, not from the compose tag,
    # which may be `latest`.
    if [[ -z "${POMBO_NODE_TAG:-}" ]]; then
        IMAGE_REF=$($DOCKER compose $COMPOSE config 2>/dev/null | sed -n 's/^ *image: *//p' | grep pombo-storage-node | head -1)
        PULLED_VERSION=$($DOCKER image inspect "$IMAGE_REF" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
            | sed -n 's/^POMBO_NODE_VERSION=//p' | tr -d '\r')
        if [[ -n "$PULLED_VERSION" && "$PULLED_VERSION" != "dev" && "$PULLED_VERSION" != "latest" ]]; then
            echo "POMBO_NODE_TAG=$PULLED_VERSION" >> .env
            say "Pinned the node image to $PULLED_VERSION in .env (edit POMBO_NODE_TAG to upgrade)."
        fi
    fi
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

# Non-interactive container commands read from /dev/null: `compose run` and
# `compose exec` attach stdin by default and would swallow answers typed ahead
# of the next prompt.
crun()  { $DOCKER compose $COMPOSE run --rm --no-deps -T "$@" </dev/null; }
cexec() { $DOCKER compose $COMPOSE exec -T "$@" </dev/null; }

# --- derive the node address from the key (a local operation, no funds needed) ---
say "Reading the node address from the key..."
ADDRESS="$(crun node node dist/bin/streamr-storage-node-register.js --print-address --config "$CONFIG_IN_CONTAINER" 2>/dev/null | tr -d '[:space:]' || true)"
[[ "$ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]] || {
    echo "Could not derive the node address. Run without hiding errors to see why:"
    echo "  $DOCKER compose $COMPOSE run --rm --no-deps node node dist/bin/streamr-storage-node-register.js --print-address --config $CONFIG_IN_CONTAINER"
    exit 1
}
say "This node's address is: $ADDRESS"

wait_for_cassandra() {
    say "Waiting for Cassandra to answer..."
    for _ in $(seq 1 30); do
        cexec cassandra cqlsh -e "DESCRIBE KEYSPACES" >/dev/null 2>&1 && return 0
        sleep 5
    done
    echo "Cassandra did not become ready in time. Check: $DOCKER compose logs cassandra"; exit 1
}

# Poll the chain until the address holds enough POL, instead of trusting a keypress.
wait_for_funds() {
    local addr="$1" js out
    js='const min=BigInt(process.env.MINWEI);fetch(process.env.RPC,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_getBalance",params:[process.env.ADDR,"latest"]})}).then(r=>r.json()).then(j=>{const w=BigInt(j.result);process.stdout.write((w>=min?"OK ":"LOW ")+(Number(w)/1e18).toFixed(4));}).catch(()=>process.stdout.write("ERR"));'
    say "Fund this address with about 1 POL from any wallet: $addr"
    say "It pays once for creating the node's assignment stream and registering it."
    while true; do
        out="$(crun -e RPC="$RPC0" -e ADDR="$addr" -e MINWEI="$MIN_WEI" node node -e "$js" 2>/dev/null | tr -d '[:space:]')"
        case "$out" in
            OK*)  say "Balance ${out#OK} POL: funded. Continuing."; return 0 ;;
            LOW*) say "Balance ${out#LOW} POL: not enough yet." ;;
            *)    say "Could not read the balance from the RPC (network?). You can retry or skip." ;;
        esac
        read -rp "Press Enter to re-check (or type 'skip' to proceed anyway): " r
        [[ "$r" == skip ]] && return 0
    done
}

register_urls() {
    # $1 = comma-separated URLs. Creates the assignment stream and registers the URLs.
    wait_for_funds "$ADDRESS"
    say "Creating the assignment stream and registering: $1"
    crun node node dist/bin/streamr-storage-node-register.js "$1" --config "$CONFIG_IN_CONTAINER"
}

if [[ "$CLUSTER" == true ]]; then
    # Every machine lists every machine as a seed (so any of them can restart
    # alone), which means a joining Cassandra started before the first one
    # would form a ring of its own: machine 0 must be up first.
    if [[ "$IS_SEED" == false ]]; then
        SEED_WG="$WG_PREFIX.1"
        say "Checking that machine 0's Cassandra ($SEED_WG:7000) is up through the tunnel (finish machine 0 first)..."
        r=""
        until tcp_open "$SEED_WG" 7000; do
            say "Cannot reach $SEED_WG on 7000 yet. Bring machine 0 up first (its installer starts Cassandra)."
            read -rp "Press Enter to re-check (or type 'skip' to proceed anyway): " r
            [[ "$r" == skip ]] && break
        done
        [[ "$r" == skip ]] || say "Machine 0's Cassandra is reachable."
    fi

    # Bring up Cassandra on its own first, so the ring and schema settle before the node starts.
    say "Starting Cassandra..."
    $DOCKER compose $COMPOSE up -d cassandra
    wait_for_cassandra

    if [[ "$IS_SEED" == true ]]; then
        say "Creating the replicated keyspace (replication factor $CLUSTER_SIZE, every node a full copy)..."
        sed "s/'dc1': 2/'dc1': $CLUSTER_SIZE/; s/pombo_storage/$KEYSPACE/g" cassandra/init-cluster.cql > /tmp/pombo-init-cluster.cql
        $DOCKER compose $COMPOSE cp /tmp/pombo-init-cluster.cql cassandra:/tmp/init-cluster.cql
        cexec cassandra cqlsh -f /tmp/init-cluster.cql
        rm -f /tmp/pombo-init-cluster.cql
    else
        say "Waiting for the Cassandra ring to reach $CLUSTER_SIZE nodes Up/Normal..."
        RING=""
        for _ in $(seq 1 60); do
            UN="$(cexec cassandra nodetool status 2>/dev/null | grep -cE '^UN[[:space:]]' || true)"
            if [[ "${UN:-0}" -ge "$CLUSTER_SIZE" ]]; then RING=1; break; fi
            sleep 5
        done
        [[ -n "$RING" ]] || {
            echo "The ring did not reach $CLUSTER_SIZE Up/Normal nodes. Check that the tunnel is up"
            echo "(sudo wg show), that machine 0 is running, then:"
            echo "  $DOCKER compose $COMPOSE exec cassandra nodetool status"
            exit 1
        }
        say "The Cassandra ring is up. Waiting for the keyspace to replicate here..."
        for _ in $(seq 1 30); do
            cexec cassandra cqlsh -e "USE $KEYSPACE" >/dev/null 2>&1 && break
            sleep 5
        done
    fi

    if [[ "$IS_SEED" == true ]]; then
        say "A cluster registers every node's URL under the one shared key, once, from machine 0."
        DEFAULT_URL=""; [[ -n "$HOSTNAME_PUBLIC" ]] && DEFAULT_URL="https://$HOSTNAME_PUBLIC"
        URLS="$(ask 'Every node URL, comma-separated (e.g. https://node1.example.org,https://node2.example.org):' "$DEFAULT_URL")"
        [[ -n "$URLS" ]] || { echo "At least machine 0's URL is required to register the cluster."; exit 1; }
        register_urls "$URLS"
    else
        say "This machine shares machine 0's key, so machine 0 already created the assignment stream"
        say "and registered the URLs. No funding or registration is needed here."
    fi

    say "Starting the node and the maintenance sidecar..."
    $DOCKER compose $COMPOSE up -d
else
    # Single node: the assignment stream must exist before the node starts, and creating it
    # (and registering the URL) spends POL, so this comes before bring-up.
    if [[ -n "$HOSTNAME_PUBLIC" ]]; then
        register_urls "https://$HOSTNAME_PUBLIC"
    else
        say "Creating the assignment stream (no hostname given, so no URL is registered yet)..."
        wait_for_funds "$ADDRESS"
        crun node node dist/bin/streamr-storage-node-register.js --config "$CONFIG_IN_CONTAINER"
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

if [[ "$CLUSTER" == true ]]; then
    say "Firewall summary: 80/tcp, 443/tcp, $WS_PORT/tcp and 51820/udp open to the internet; nothing else."
    say "Cassandra (7000/9042) is reachable only through the tunnel. Repair and garbage collection run"
    say "in the maintenance sidecar; retention runs on machine 0 only."
else
    say "Retention runs automatically. See POMBO.md to tune it."
fi
