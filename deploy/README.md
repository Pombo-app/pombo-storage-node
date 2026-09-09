# Running a Pombo storage node

One machine, one `docker compose`: the node and its Cassandra database.
What the node adds on top of a Streamr storage node is described in
[POMBO.md](../POMBO.md).

## What you need

- Docker with the compose plugin.
- 4 GB of RAM and a few tens of GB of disk to start with; Cassandra grows
  with the channels you host.
- A public IP with TCP port 32200 reachable from the internet (the Streamr
  overlay connects to it).
- A hostname with a valid TLS certificate in front of the node's HTTP API.
  The Pombo web app runs in a browser and will only talk to `https://`
  endpoints with a certificate the browser trusts. Any reverse proxy works;
  a Caddy example is below.
- A little POL on the node's address, for the one transaction that
  registers the node.

## 1. Configure

```
cd deploy
cp config/pombo-node.json.example config/pombo-node.json
```

Edit `config/pombo-node.json`:

- `client.auth.privateKey`: the node's key. Generate one with
  `node -e "console.log(require('ethers').Wallet.createRandom().privateKey)"`
  or any wallet you control. The address derived from it is the node's
  identity; channel owners will assign channels to that address.
- `client.network.controlLayer.websocketHost`: the public hostname or IP
  the overlay can reach you at on port 32200.
- `plugins.storage.signedReads.enabled` is on: gated channels are only
  readable with a signed request (POMBO.md explains what it does).

## 2. Start

```
docker compose up -d --build
```

The first start builds the node image from source (several minutes) and
creates the Cassandra schema. Watch it with `docker compose logs -f node`;
you should see `Started HTTP server on port 8002` and a line naming the node.

## 3. Put HTTPS in front

The compose file binds the HTTP API to `127.0.0.1:8002` only. A minimal
Caddyfile:

```
node.example.org {
    reverse_proxy 127.0.0.1:8002
}
```

Caddy obtains the certificate itself. With nginx or another proxy, make sure
CORS is passed through untouched: the node answers preflight requests for
any origin, which is what the browser clients need.

Check from another machine:

```
curl https://node.example.org/capabilities
```

which answers `{"name":"pombo-storage-node","features":[...]}`.

## 4. Register the node

Streamr streams are assigned to storage nodes by address, and clients find
a node's HTTP endpoint through the metadata registered on-chain. Register
your public URL once (this is the transaction that costs POL):

```
npx -p @streamr/cli-tools streamr storage-node register https://node.example.org --private-key 0x... --env polygon
```

Several URLs can be registered, comma-separated, if you serve the same
Cassandra from more than one hostname. Show what is registered with
`streamr storage-node show <address> --env polygon`.

From then on, a Pombo channel owner who picks your node's address when
creating a channel gets its history stored here.

## Upgrades

```
git pull
docker compose up -d --build
```

Schema changes ship as files in `cassandra/`; the node refuses to start
when a column it needs is missing and names the file to apply. Apply it
with `docker compose exec cassandra cqlsh -f /path/to/file` after copying
it into the container, or with any cqlsh that reaches the database.

## More than one node

The storage plugin's `cluster` section (`clusterSize`, `myIndexInCluster`)
lets several nodes share one Cassandra cluster and split the streams among
them; Cassandra replication then keeps every node's data available on the
others. That setup is outside this compose file: it needs a Cassandra
cluster with `NetworkTopologyStrategy` replication and the `init.cql`
adjusted accordingly.
