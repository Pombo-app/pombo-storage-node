# Installing a Pombo storage node

This is the full procedure, from a bare machine to a node that a Pombo
channel can store its history on. It runs the node and its Cassandra
database with `docker compose`. What the node does beyond a vanilla Streamr
storage node is described in [POMBO.md](POMBO.md).

Every command is meant to be copy-pasted. Lines you must edit are called out.

## Quick install

On a bare machine, one command installs Docker and git, fetches the node, and
runs an interactive installer that asks whether to generate a key or use
yours, and your hostname, then does the rest:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Pombo-app/pombo-storage-node/pombo/103.3.1/bootstrap.sh)
```

While the repository is private, download `bootstrap.sh` with your GitHub
credentials and run `bash bootstrap.sh` instead. If the node is already
cloned, run `deploy/install.sh` directly.

The installer pauses for the two things it cannot do for you: funding the node
with POL, and opening the firewall ports. The steps below are the same
procedure by hand, if you prefer to run them yourself or need to troubleshoot.

## 0. What you need

- A machine with **Docker** and the compose plugin, and a few tens of GB of
  disk that grows with the channels you host. The node and Cassandra run
  comfortably in **4 GB of RAM**, but the image build (step 4) compiles the
  node from source and is memory-hungry: give it **8 GB**, or add swap on a
  4 GB machine, or build the image on a bigger machine and pull it.
- A **public IP** with these ports reachable from the internet:
  - `443` and `80` for the HTTPS endpoint (80 is used once to issue the certificate),
  - `32200` for the Streamr overlay.
- A **hostname** you control, with a DNS `A` record pointing at the machine's
  IP (for example `node.example.org`). The Pombo web app is a browser and
  only reads from an `https://` endpoint with a valid certificate on a real
  hostname; an IP address or plain HTTP will not work.
- A little **POL** (Polygon's native token) on the node's address for the one
  transaction that registers the node.

## 1. Install Docker

On a fresh Debian/Ubuntu machine:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"
```

On Oracle Linux / RHEL / Rocky / Alma (the `get.docker.com` script does not
support them), use the Docker repository instead:

```bash
sudo dnf -y install dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
# if dnf reports a conflict with runc/containerd, repeat the install with --allowerasing
```

Then log out and back in so the group applies, and check:

```bash
docker version
docker compose version
```

## 2. Get the node

Install git if the machine does not have it (`git --version` to check; on
Oracle Linux / RHEL: `sudo dnf -y install git`, on Debian/Ubuntu:
`sudo apt-get update && sudo apt-get -y install git`), then:

```bash
git clone https://github.com/Pombo-app/pombo-storage-node.git
cd pombo-storage-node/deploy
```

While the repository is private, clone it with your GitHub credentials, for
example `gh repo clone Pombo-app/pombo-storage-node` after `gh auth login`, or
a personal access token in the URL.

## 3. Create the node's key and configuration

Generate a private key for the node. Its address is the node's identity;
channel owners assign channels to that address.

```bash
echo "0x$(openssl rand -hex 32)"
```

Copy the example config and open it:

```bash
cp config/pombo-node.json.example config/pombo-node.json
nano config/pombo-node.json
```

Edit two fields:

- `client.auth.privateKey`: paste the `0x…` key from above.
- `client.network.controlLayer.websocketHost`: your public hostname (the same
  one the DNS record points at), so the overlay can reach you on 32200.

Leave `plugins.storage.signedReads.enabled` at `true`: gated channels are
only readable with a signed request, which is what the Pombo clients do.

## 4. Start the node and its database

```bash
docker compose up -d --build
```

The first start builds the node image from source (several minutes), starts
Cassandra, and creates the schema. Follow it with:

```bash
docker compose logs -f node
```

You are ready when you see `Started HTTP server on port 8002` and a line
naming the node. The API is bound to `127.0.0.1:8002` on purpose; the next
step puts HTTPS in front of it.

Find the node's address (you will fund and register it):

```bash
docker compose logs node | grep "Node address"
```

## 5. Fund the node's address

Send a small amount of POL (about 1 POL is plenty) to the node address from
any wallet. This pays for the one registration transaction.

## 6. Put HTTPS in front

Set your domain and start Caddy, which obtains and renews the certificate for
you:

```bash
cp Caddyfile.example Caddyfile
echo "POMBO_NODE_DOMAIN=node.example.org" > .env   # <-- your hostname
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

Check from another machine (not the node itself):

```bash
curl https://node.example.org/capabilities
```

It answers `{"name":"pombo-storage-node","features":[...]}`. If the
certificate is still being issued, wait a minute and retry.

## 7. Register the node on-chain

This creates the node's assignment stream (needed once before it can serve a
channel) and publishes its public URL so clients can find it. It reads the
node key from the config, and is the transaction that spends POL:

```bash
docker compose run --rm node \
  node dist/bin/streamr-storage-node-register.js https://node.example.org \
  --config /home/streamr/.streamr/config/pombo-node.json
```

You can register several URLs at once, comma-separated, if you serve the same
node at more than one hostname; the clients fail over between them.

The node is now installed. A Pombo channel owner who picks your node's
address when creating a channel gets its history stored here.

## Everyday operations

**Logs and status:**

```bash
docker compose ps
docker compose logs -f node
```

**Upgrade** to a newer version of the node:

```bash
git pull
docker compose up -d --build
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

Schema changes ship as files under `cassandra/`. The node refuses to start
when a column it needs is missing and names the file to apply. Apply it with:

```bash
docker compose cp cassandra/<file>.cql cassandra:/tmp/x.cql
docker compose exec cassandra cqlsh -f /tmp/x.cql
```

**Stop** the node (the database volume is kept):

```bash
docker compose -f docker-compose.yml -f docker-compose.caddy.yml down
```

**Back up** the database — snapshot Cassandra before risky changes:

```bash
docker compose exec cassandra nodetool snapshot streamr
```

**Retention runs automatically.** The node prunes stored data past each
stream's `storageDays` on its own timer, so there is no cron to set up. See
the retention section of [POMBO.md](POMBO.md) to tune or disable it.

## Running more than one node (a cluster)

This compose file is a single machine with its own Cassandra. To run several
nodes that share the load and replicate each other's data, point each node at
a shared Cassandra cluster with `NetworkTopologyStrategy` replication and set
`plugins.storage.cluster` (`clusterSize`, `myIndexInCluster`) in each config.
That setup is outside this file; `cassandra/init.cql` shows the single-node
schema to adapt.

## Troubleshooting

- **`curl https://…/capabilities` hangs or fails to get a certificate:** ports
  80 and 443 must be reachable from the internet and the DNS `A` record must
  point at this machine. Caddy needs port 80 to answer the issuance challenge.
- **The node logs `stored_at` and refuses to start:** the Cassandra schema is
  missing a column; apply the file named in the message (see Upgrade).
- **The web app will not add your node:** it requires a registered `https://`
  hostname URL. Register one (step 7); an IP or plain HTTP is rejected.
- **`docker compose up --build` fails to build:** make sure you cloned the
  whole repository and have a recent Docker; the image compiles the node from
  source and needs network access during the build.
