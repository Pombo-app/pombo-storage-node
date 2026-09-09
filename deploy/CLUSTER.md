# Running a Pombo storage cluster (multi-machine)

Several storage nodes that split the write load and replicate each other's
data, so any node can serve any read. For a single node, see
[HOW_TO_INSTALL.md](../HOW_TO_INSTALL.md).

## How it works

- **One cluster key**, the same private key on every node. Its address is the
  cluster's on-chain identity and owns the assignment stream. Nodes on
  different machines get different overlay node IDs (the ID derives from the
  IP, not the key), so sharing the key is safe.
- Each node sets `clusterSize` = N and a distinct `myIndexInCluster` (0..N-1);
  a node stores a stream-partition only when it maps to its index, so the
  nodes split the load.
- The Cassandra instances form one cluster with `NetworkTopologyStrategy` and
  replication factor N, so every node keeps a full copy and any node serves
  any partition. This shared, replicated Cassandra is the part that needs the
  most care.
- Register the cluster key once with every node's URL; clients fail over.

This guide uses two nodes as the example; for more, raise `clusterSize` and
give each machine the next index. Placeholder values, replace with yours:

| index | hostname            | public IP      |       |
|-------|---------------------|----------------|-------|
| 0     | node1.example.org   | 203.0.113.10   | seed  |
| 1     | node2.example.org   | 203.0.113.20   |       |

## 0. Prerequisites

- Docker on each machine, plus the repo's `deploy/` files. Pulling the image
  needs only those, so a shallow clone is enough:
  `git clone --depth 1 --branch pombo/103.3.1 <repo>` then `cd .../deploy`.
- The node image reachable by every machine: pull the published image, or build
  from source on each (building needs the full repository, not a shallow clone).
- Firewall on each machine: `80`, `443`, `32200` from anywhere; and `7000` +
  `9042` reachable only from the other nodes' IPs. Cassandra is unauthenticated
  in this setup, so never open 7000/9042 to the internet.
- A cluster key with a little POL, the same on every node.
- A DNS `A` record per node pointing at its IP.

Shorthand below (run from `deploy/`), using the prebuilt image:

```bash
DC="-f docker-compose.yml -f docker-compose.cluster.yml -f docker-compose.image.yml"
```

To build from source instead, drop `-f docker-compose.image.yml` and run
`docker compose $DC build node` before each bring-up.

## 1. Every node: config

Write `config/pombo-node.json` as in [HOW_TO_INSTALL](../HOW_TO_INSTALL.md), with:

- the **same** cluster key in `client.auth.privateKey` on every node;
- `client.network.controlLayer.websocketHost` = this node's hostname;
- in `plugins.storage.cluster`: `clusterSize` = N, and `myIndexInCluster` = this
  node's index (0, 1, ...).

## 2. Every node: deploy/.env

```bash
THIS_PUBLIC_IP=<this node's public IP>
CASSANDRA_SEEDS=<the seed node's public IP>    # node 0's IP, the same on every node
POMBO_NODE_DOMAIN=<this node's hostname>
```

## 3. Seed node (index 0): Cassandra + schema

```bash
docker compose $DC pull
docker compose $DC up -d cassandra
docker compose exec cassandra cqlsh -e "DESCRIBE KEYSPACES"    # wait until it answers
docker compose cp cassandra/init-cluster.cql cassandra:/tmp/init-cluster.cql
docker compose exec cassandra cqlsh -f /tmp/init-cluster.cql
```

## 4. Every other node: join the ring

```bash
docker compose $DC pull
docker compose $DC up -d cassandra
```

On any node, every node must show `UN` (Up/Normal):

```bash
docker compose exec cassandra nodetool status
```

## 5. Register once (from the seed)

Fund the cluster key with a little POL, then register every node's URL, once:

```bash
docker compose $DC run --rm --no-deps node \
  node dist/bin/streamr-storage-node-register.js \
  https://node1.example.org,https://node2.example.org \
  --config /home/streamr/.streamr/config/pombo-node.json
```

## 6. Every node: bring up the node and HTTPS

```bash
docker compose $DC -f docker-compose.caddy.yml up -d
```

Each node logs `Node address <cluster address>`.

## 7. Validate

- Each node stores only its partitions: `docker compose logs node | grep -i assign`.
- Publish across several partitions, then read a partition ingested by one node
  from another. The metadata endpoint returns the same counts on every node,
  which shows the shared Cassandra is working.

## Troubleshooting the Cassandra cluster

Cross-machine Cassandra is the usual sticking point. On cloud VMs behind NAT (a
private interface with a public IP via a gateway), Cassandra's broadcast address
must be the public IP while it listens on the instance's interface. If
`nodetool status` does not list every node as `UN`, check that broadcast address
and that ports 7000 and 9042 are reachable between the machines.
