# Running a Pombo storage cluster (multi-machine)

Several machines that share one node identity and one Cassandra ring, so a
machine being down loses no data and any machine can serve any read. For a
single node, see [HOW_TO_INSTALL.md](../HOW_TO_INSTALL.md).

The quick way is the installer: run it on each machine and answer yes to the
multi-machine cluster question. It sets up the tunnel between the machines,
the Cassandra ring, the node, HTTPS and the maintenance sidecar. This page
explains the model and gives the same procedure by hand, for troubleshooting
or a custom setup.

## How it works

- **One cluster key**, the same private key on every machine. Its address is
  the cluster's on-chain identity and owns the assignment stream. Machines
  get different overlay node IDs (the ID derives from the IP, not the key),
  so sharing the key is safe.
- **A WireGuard tunnel** (`wg0`, `10.10.0.0/24`; machine *i* is
  `10.10.0.(i+1)`) is the private network between the machines. Cassandra
  listens on the tunnel address only, so its ports (7000, 9042) are never on
  the internet and need no firewall rule. The only port the tunnel needs is
  UDP 51820, which WireGuard makes safe to expose: it ignores packets not
  signed by a listed peer.
- **One Cassandra ring** across the machines, `NetworkTopologyStrategy` with
  replication factor N (every machine a full copy), datacenter `dc1`, one
  rack per machine, cluster name `pombo-storage`, keyspace `pombo_storage`.
  Every machine lists every machine as a seed, so any of them can restart
  alone. To join an existing database under other names, run the installer
  with `CASSANDRA_CLUSTER_NAME=... CASSANDRA_KEYSPACE=... ./install.sh`.
- **Storage model.** By default every node runs `clusterSize: 1` and stores
  every stream: each machine captures everything from the overlay, and
  Cassandra replication makes the copies equal. A machine that goes down
  misses nothing, because the others captured it (full redundancy). The
  advanced *split* mode instead gives each node a distinct
  `myIndexInCluster` with `clusterSize: N`, so each captures only its share
  of stream-partitions: less overlay load per machine, but the overlay has
  no history, so a partition's messages are lost while its node is down.
  Use split only when a single machine cannot carry the number of streams
  you host. (Two machines per index, each pair sharing an index, would give
  both; the installer does not set that up.)
- **Maintenance sidecar** (`maintenance` service, cluster only): runs
  `nodetool repair -full -pr` daily and `nodetool garbagecollect` weekly,
  staggered by machine (`deploy/maintenance/run.sh`). Without repair the
  replicas drift and history goes intermittently missing. Retention (the
  node's own scheduler) runs on machine 0 only; its deletes replicate.
- **Register once** (from machine 0) with every machine's URL; clients fail
  over between them.

Placeholder values, two machines:

| number | hostname          | public IP    | tunnel IP |
|--------|-------------------|--------------|-----------|
| 0      | node1.example.org | 203.0.113.10 | 10.10.0.1 |
| 1      | node2.example.org | 203.0.113.20 | 10.10.0.2 |

## 0. Prerequisites

- Docker on each machine, plus the repo's `deploy/` files (a shallow clone
  is enough when pulling the image: `git clone --depth 1 --branch
  pombo/103.3.1 <repo>`).
- Firewall on each machine (cloud security list and host): `80`, `443`,
  `32200/tcp` and `51820/udp` from anywhere. Nothing else; in particular no
  7000/9042.
- A cluster key with a little POL, the same on every machine.
- A DNS `A` record per machine pointing at its public IP.

Shorthand below (run from `deploy/`), using the prebuilt image:

```bash
DC="-f docker-compose.yml -f docker-compose.cluster.yml -f docker-compose.image.yml"
```

## 1. Every machine: the tunnel

Create the key and print the public key (installs `wireguard-tools`):

```bash
./wg-setup.sh key
```

Do this on every machine, then bring the tunnel up on each, giving it its
own tunnel IP, the MTU, and every other machine as
`<peer-tunnel-ip>,<peer-public-ip>,<peer-public-key>`:

```bash
# machine 0
./wg-setup.sh up 10.10.0.1 1280 10.10.0.2,203.0.113.20,<key of machine 1>
# machine 1
./wg-setup.sh up 10.10.0.2 1280 10.10.0.1,203.0.113.10,<key of machine 0>
```

This writes `/etc/wireguard/wg0.conf`, enables `wg-quick@wg0`, makes Docker
start after it (the Cassandra ports bind to the tunnel address), and opens
UDP 51820 on the host firewall. Check the tunnel with the MTU you chose:

```bash
sudo wg show                                  # latest handshake a few seconds ago
ping -M do -s 1252 -c 3 10.10.0.2             # 1252 = 1280 - 28; from machine 1 ping 10.10.0.1
```

MTU: 1280 works on any path. Up to 1420 is faster when the path between the
machines carries 1500-byte packets (`ping -M do -s 1472 <peer public IP>`
answers); if large packets silently die while small ones pass, lower it.

## 2. Every machine: config and .env

Write `config/pombo-node.json` as in [HOW_TO_INSTALL](../HOW_TO_INSTALL.md), with:

- the **same** cluster key in `client.auth.privateKey` on every machine;
- `client.network.controlLayer.websocketHost` = this machine's hostname;
- `plugins.storage.cassandra`: `hosts` = `["cassandra", "<every other
  machine's tunnel IP>"]`, `keyspace` `pombo_storage`, `datacenter` `dc1`;
- `plugins.storage.cluster`: `{ "clusterSize": 1, "myIndexInCluster": 0 }`
  (or, for split mode, `clusterSize` = N and a distinct index per machine);
- `plugins.storage.retention.enabled`: `true` on machine 0, `false` elsewhere.

`deploy/.env`:

```bash
POMBO_NODE_DOMAIN=<this machine's hostname>
POMBO_NODE_ORDINAL=<0, 1, ...>
CASSANDRA_CLUSTER_NAME=pombo-storage
CASSANDRA_KEYSPACE=pombo_storage
CASSANDRA_RACK=rack<ordinal+1>
WG_IP=<this machine's tunnel IP>
CASSANDRA_SEEDS=10.10.0.1,10.10.0.2     # every machine's tunnel IP, the same everywhere
```

## 3. Machine 0: Cassandra + schema

```bash
docker compose $DC pull
docker compose $DC up -d cassandra
docker compose exec cassandra cqlsh -e "DESCRIBE KEYSPACES"    # wait until it answers
sed "s/'dc1': 2/'dc1': <N>/" cassandra/init-cluster.cql > /tmp/init-cluster.cql   # also rename pombo_storage if you changed CASSANDRA_KEYSPACE
docker compose cp /tmp/init-cluster.cql cassandra:/tmp/init-cluster.cql
docker compose exec cassandra cqlsh -f /tmp/init-cluster.cql
```

## 4. Every other machine: join the ring

Only after machine 0's Cassandra is up (every machine is a seed, so one
started alone forms its own ring):

```bash
docker compose $DC pull
docker compose $DC up -d cassandra
```

On any machine, every machine must show `UN` (Up/Normal) at its tunnel IP:

```bash
docker compose exec cassandra nodetool status
```

## 5. Register once (from machine 0)

Fund the cluster key with a little POL, then register every machine's URL, once:

```bash
docker compose $DC run --rm --no-deps node \
  node dist/bin/streamr-storage-node-register.js \
  https://node1.example.org,https://node2.example.org \
  --config /home/streamr/.streamr/config/pombo-node.json
```

## 6. Every machine: node, sidecar and HTTPS

```bash
cp Caddyfile.example Caddyfile
docker compose $DC -f docker-compose.caddy.yml up -d
```

Each machine logs `Node address <cluster address>`; `docker compose logs
maintenance` shows the repair and garbage-collection schedule.

## 7. Validate

- `nodetool status` on each machine: N nodes `UN`, addresses `10.10.0.x`,
  racks `rack1`..`rackN`, datacenter `dc1`.
- `ss -ltn | grep -E ':(7000|9042) '` shows the tunnel address only; from
  outside, `nc -vz <public IP> 9042` fails.
- Publish to a channel assigned to the cluster, then read its history from
  each machine's URL: the same messages come back from every machine.
- `docker compose logs node | grep Retention` shows retention on machine 0
  only.
- Run one repair by hand and watch it finish:
  `docker compose exec maintenance bash /run.sh repair`.

## Troubleshooting

- **No handshake** (`sudo wg show` shows none, or an old one): UDP 51820 is
  not open on a cloud firewall, a public IP or key is wrong, or the other
  side's tunnel is down. Both sides need `Endpoint` set, so either can start
  the handshake.
- **Ping works, `ping -M do` at the MTU fails**: the path carries smaller
  packets than the MTU; lower it in `wg0.conf` on both machines and
  `sudo systemctl restart wg-quick@wg0`.
- **Cassandra fails to start with "cannot assign requested address"**: wg0
  was not up when Docker started. `sudo systemctl restart wg-quick@wg0`
  then `docker compose $DC up -d`.
- **Ring does not reach N `UN`**: the tunnel is down, or a joining machine
  started before machine 0 and formed its own ring (`nodetool status` shows
  one node with the same cluster name on each side). Stop the joiner, wipe
  its data (`docker compose $DC down -v` on the joiner only) and join again.
- **History intermittently missing**: replicas drifted; check the sidecar is
  running and its repairs finish (`docker compose logs maintenance`).
