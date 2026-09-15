#!/usr/bin/env bash
#
# The WireGuard tunnel between the cluster machines, the private network the
# Cassandra ring runs on. Point-to-point: each peer is reachable only at its
# own /32 and nothing else is routed through the tunnel. Only UDP 51820 needs
# to be open to the internet; WireGuard ignores packets that are not signed
# by a listed peer. Idempotent; uses sudo when not root.
#
#   wg-setup.sh key                              create this machine's key if missing, print its public key
#   wg-setup.sh up <wg-ip> <mtu> <peer>...       write /etc/wireguard/wg0.conf and bring wg0 up
#       peer = <peer-wg-ip>,<peer-public-ip>,<peer-public-key>
set -euo pipefail

CONF=/etc/wireguard/wg0.conf
KEY=/etc/wireguard/wg0.key
SUDO=""; [[ $EUID -eq 0 ]] || SUDO="sudo"

install_tools() {
    command -v wg >/dev/null && return 0
    # Package output goes to stderr: `key` must print nothing but the public key on stdout.
    if command -v dnf >/dev/null; then
        $SUDO dnf -y -q install wireguard-tools >&2
    elif command -v apt-get >/dev/null; then
        { $SUDO apt-get -qq update && $SUDO apt-get -qq -y install wireguard-tools; } >&2
    else
        echo "Install wireguard-tools by hand, then rerun." >&2; exit 1
    fi
}

ensure_key() {
    $SUDO mkdir -p /etc/wireguard
    $SUDO chmod 700 /etc/wireguard
    if ! $SUDO test -s "$KEY"; then
        wg genkey | $SUDO tee "$KEY" >/dev/null
        $SUDO chmod 600 "$KEY"
    fi
}

case "${1:-}" in
key)
    install_tools
    ensure_key
    $SUDO cat "$KEY" | wg pubkey
    ;;
up)
    [[ $# -ge 4 ]] || { echo "usage: wg-setup.sh up <wg-ip> <mtu> <peer>..." >&2; exit 2; }
    install_tools
    ensure_key
    WG_IP="$2"; MTU="$3"; shift 3
    {
        echo "[Interface]"
        echo "Address = $WG_IP/24"
        echo "ListenPort = 51820"
        echo "MTU = $MTU"
        echo "PrivateKey = $($SUDO cat "$KEY")"
        for p in "$@"; do
            IFS=, read -r pwg ppub pkey <<<"$p"
            echo
            echo "[Peer]"
            echo "PublicKey = $pkey"
            echo "Endpoint = $ppub:51820"
            echo "AllowedIPs = $pwg/32"
            echo "PersistentKeepalive = 25"
        done
    } | $SUDO tee "$CONF" >/dev/null
    $SUDO chmod 600 "$CONF"

    # Docker binds Cassandra to the tunnel address, so the tunnel must exist
    # before the daemon starts the containers at boot.
    $SUDO mkdir -p /etc/systemd/system/docker.service.d
    printf '[Unit]\nAfter=wg-quick@wg0.service\nWants=wg-quick@wg0.service\n' \
        | $SUDO tee /etc/systemd/system/docker.service.d/wireguard.conf >/dev/null
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable -q wg-quick@wg0
    if systemctl is-active -q wg-quick@wg0; then
        $SUDO systemctl restart wg-quick@wg0
    else
        $SUDO systemctl start wg-quick@wg0
    fi

    # UDP 51820 on the host firewall when one is running; the cloud firewall
    # (security list, security group) is the operator's to open.
    if systemctl is-active -q firewalld; then
        $SUDO firewall-cmd -q --add-port=51820/udp
        $SUDO firewall-cmd -q --permanent --add-port=51820/udp
    elif command -v ufw >/dev/null && $SUDO ufw status 2>/dev/null | grep -q '^Status: active'; then
        $SUDO ufw allow 51820/udp >/dev/null
    fi
    $SUDO wg show wg0
    ;;
*)
    sed -n '3,12p' "$0" >&2
    exit 2
    ;;
esac
