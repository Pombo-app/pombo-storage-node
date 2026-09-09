#!/usr/bin/env bash
#
# One-command setup of a Pombo storage node on a bare machine. Installs git and
# Docker, clones the node, and runs the interactive installer.
#
#   bash bootstrap.sh
#
# You still need: a public machine with ports 80, 443 and 32200 open, a
# hostname pointing at it, and a little POL. The installer asks for the rest.
set -euo pipefail

REPO="${POMBO_REPO:-https://github.com/Pombo-app/pombo-storage-node.git}"
BRANCH="${POMBO_BRANCH:-pombo/103.3.1}"
DIR="pombo-storage-node"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# shellcheck disable=SC1091
. /etc/os-release 2>/dev/null || true
FAMILY="unknown"
case " ${ID:-} ${ID_LIKE:-} " in
    *" debian "*|*" ubuntu "*) FAMILY="debian" ;;
    *" rhel "*|*" fedora "*|*" ol "*|*" centos "*|*" rocky "*|*" almalinux "*) FAMILY="rhel" ;;
esac

install_prereqs() {
    if command -v docker >/dev/null && command -v git >/dev/null; then
        return
    fi
    say "Installing git and Docker..."
    if [[ "$FAMILY" == "debian" ]]; then
        sudo apt-get update
        sudo apt-get -y install git
        command -v docker >/dev/null || curl -fsSL https://get.docker.com | sudo sh
    elif [[ "$FAMILY" == "rhel" ]]; then
        sudo dnf -y install git dnf-plugins-core
        if ! command -v docker >/dev/null; then
            sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
            sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin --allowerasing
        fi
    else
        echo "Could not recognise this OS. Install git and Docker by hand (HOW_TO_INSTALL.md step 1), then run deploy/install.sh."
        exit 1
    fi
    sudo systemctl enable --now docker
    sudo usermod -aG docker "$USER" || true
}

clone_repo() {
    if [[ -d "$DIR/.git" ]]; then
        say "Repository already here, updating..."
        git -C "$DIR" pull --ff-only || true
        return
    fi
    say "Cloning the node..."
    if ! git clone --branch "$BRANCH" "$REPO" "$DIR" 2>/dev/null; then
        echo "Could not clone. If the repository is private, paste a GitHub token with read access."
        read -rp "Token (blank to abort): " TOKEN
        [[ -n "$TOKEN" ]] || { echo "Aborted."; exit 1; }
        git clone --branch "$BRANCH" "https://${TOKEN}@github.com/Pombo-app/pombo-storage-node.git" "$DIR"
    fi
}

install_prereqs
clone_repo
say "Prerequisites ready."
exec bash "$DIR/deploy/install.sh"
