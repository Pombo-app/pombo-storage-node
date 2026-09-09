# Running a Pombo storage cluster (multi-machine)

Several storage nodes that split the write load and replicate each other's
data, so any node serves any read. This is the multi-machine shape (the
Pombo-equivalent). For a single node, see [HOW_TO_INSTALL.md](HOW_TO_INSTALL.md).

## How it works

- **One cluster key**, the *same* private key on every node. Its address is the
  cluster's on-chain identity and owns the assignment stream. Different machines
  get different overlay node IDs (the ID is derived from the IP, not the key),
  so sharing the key is safe.
- Each node sets `clusterSize` = N and a distinct `myIndexInCluster` (0..N-1). A
  node ingests a stream-partition only when it maps to its index, so the nodes
  split the load.
- The Cassandra instances form **one cluster** with `NetworkTopologyStrategy`
  and replication factor N, so every node keeps a full copy. Reads are local and
  any node serves any partition. This shared, replicated Cassandra is what makes
  the cluster correct, and it is the part that takes the most care.
- Register the cluster key **once** with every node's URL; clients fail over.

## This example: two nodes

| index | hostname                          | public IP       | role |
|-------|-----------------------------------|-----------------|------|
| 0     | vps3.blob-storage-streamr.online  | 130.61.201.136  | seed |
| 1     | 1.storage.pombo.cc                | 130.61.202.30   |      |

## 0. Prerequisites

- Each hostname resolves only to its node's IP.
- Firewall (VCN security list) per node: `80`, `443`, `32200` from `0.0.0.0/0`;
  and `7000` + `9042` from the **other node's IP only** (a /32 rule per peer).
  Cassandra has no auth here, so never open 7000/9042 to `0.0.0.0/0`.
- The prebuilt image public, so both nodes pull instead of building.
- A cluster key with a little POL — the same on both nodes.

Shorthand used below (run from `deploy/`):

```bash
DC="-f docker-compose.yml -f docker-compose.cluster.yml -f docker-compose.image.yml"
```

## 1. Both nodes: node + config

On each VPS install Docker and git ([HOW_TO_INSTALL](HOW_TO_INSTALL.md) steps
1-2), clone, `cd deploy`, and write `config/pombo-node.json` as in step 3, with:

- the **same** cluster key in `client.auth.privateKey` on both nodes;
- `client.network.controlLayer.websocketHost` = this node's hostname;
- in `plugins.storage.cluster`: `clusterSize` = 2, and `myIndexInCluster` = 0 on
  node 0, 1 on node 1.

## 2. Both nodes: deploy/.env

Node 0:

```bash
THIS_PUBLIC_IP=130.61.201.136
CASSANDRA_SEEDS=130.61.201.136
POMBO_NODE_DOMAIN=vps3.blob-storage-streamr.online
```

Node 1 (seed stays node 0's IP):

```bash
THIS_PUBLIC_IP=130.61.202.30
CASSANDRA_SEEDS=130.61.201.136
POMBO_NODE_DOMAIN=1.storage.pombo.cc
```

## 3. Node 0 (seed): Cassandra + schema

```bash
docker compose $DC pull
docker compose $DC up -d cassandra
docker compose exec cassandra cqlsh -e "DESCRIBE KEYSPACES"     # wait until it answers
docker compose cp cassandra/init-cluster.cql cassandra:/tmp/init-cluster.cql
docker compose exec cassandra cqlsh -f /tmp/init-cluster.cql
```

## 4. Node 1: join the ring

```bash
docker compose $DC pull
docker compose $DC up -d cassandra
```

On either node, both must show `UN` (Up/Normal):

```bash
docker compose exec cassandra nodetool status
```

## 5. Fund + register once (from node 0)

Fund the cluster key with about 1 POL, then, on node 0 only:

```bash
docker compose $DC run --rm --no-deps node \
  node dist/bin/streamr-storage-node-register.js \
  https://vps3.blob-storage-streamr.online,https://1.storage.pombo.cc \
  --config /home/streamr/.streamr/config/pombo-node.json
```

## 6. Both nodes: bring up the node and HTTPS

```bash
docker compose $DC -f docker-compose.caddy.yml up -d
```

Each node logs `Node address <cluster address>`.

## 7. Validate

- Each node stores only its partitions: `docker compose logs node | grep -i assign`.
- Publish across several partitions, then confirm a partition ingested by one
  node is readable from the other (proves the shared Cassandra): the metadata
  endpoint on both nodes returns the same counts.

## The fiddly part

Cross-machine Cassandra over Oracle's public IPs is where problems land: the VMs
sit behind NAT (a private interface, a public IP via the gateway), so
Cassandra's broadcast address must be the public IP while it listens on the
instance's interface. If `nodetool status` does not show both nodes `UN`, that
is the place to look — bring the logs and we tune it.
