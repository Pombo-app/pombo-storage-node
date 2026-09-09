#!/usr/bin/env bash
#
# One-command setup of a Pombo storage node on a bare machine. Installs Docker,
# fetches only the small deploy/ files (not the ~150 MB source tree), and runs
# the interactive installer, which pulls the prebuilt node image.
#
#   bash bootstrap.sh
#
# You still need: a public machine with ports 80, 443 and 32200 open, a
# hostname pointing at it, and a little POL. The installer asks for the rest.
# To build the image from source instead of pulling it, clone the full
# repository and run deploy/install.sh from there.
set -euo pipefail

RAW="${POMBO_RAW:-https://raw.githubusercontent.com/Pombo-app/pombo-storage-node/pombo/103.3.1}"
DIR="pombo-storage-node/deploy"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# shellcheck disable=SC1091
. /etc/os-release 2>/dev/null || true
FAMILY="unknown"
case " ${ID:-} ${ID_LIKE:-} " in
    *" debian "*|*" ubuntu "*) FAMILY="debian" ;;
    *" rhel "*|*" fedora "*|*" ol "*|*" centos "*|*" rocky "*|*" almalinux "*) FAMILY="rhel" ;;
esac

install_docker() {
    command -v docker >/dev/null && return
    say "Installing Docker..."
    if [[ "$FAMILY" == "debian" ]]; then
        curl -fsSL https://get.docker.com | sudo sh
    elif [[ "$FAMILY" == "rhel" ]]; then
        sudo dnf -y install dnf-plugins-core
        sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
        sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin --allowerasing
    else
        echo "Could not recognise this OS. Install Docker by hand (HOW_TO_INSTALL.md step 1), then run deploy/install.sh."
        exit 1
    fi
    sudo systemctl enable --now docker
    sudo usermod -aG docker "$USER" || true
}

# The deploy set is small and stable; fetch it file by file rather than cloning
# the monorepo. Add a line here if deploy/ gains a file the installer needs.
fetch_deploy() {
    say "Fetching the deploy files..."
    mkdir -p "$DIR/cassandra" "$DIR/config"
    local files=(
        install.sh
        Caddyfile.example
        docker-compose.yml
        docker-compose.image.yml
        docker-compose.caddy.yml
        docker-compose.cluster.yml
        cassandra/init.cql
        cassandra/init-cluster.cql
        config/pombo-node.json.example
    )
    local f
    for f in "${files[@]}"; do
        curl -fsSL "$RAW/deploy/$f" -o "$DIR/$f" || { echo "Could not fetch deploy/$f from $RAW"; exit 1; }
    done
    chmod +x "$DIR/install.sh"
}

install_docker
fetch_deploy
say "Prerequisites ready."
exec bash "$DIR/install.sh"
