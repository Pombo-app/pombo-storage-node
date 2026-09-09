# Pombo storage node

A Streamr storage node that knows what a Pombo channel is. It is the
[Streamr network monorepo](https://github.com/streamr-dev/network) with a
few additions to the storage plugin and the SDK, kept as isolated commits on
top of an upstream release (branch `pombo/<version>`). Run it with the
`docker compose` in [deploy/](deploy/README.md).

The vanilla storage node stores every message it receives on an assigned
stream: no signature check, no permission check, no way to delete, no
record of when a message arrived, and anyone can read everything. This
fork changes each of those. Nothing here is required by the Pombo
clients: they work against vanilla nodes and detect these features
through `GET /capabilities`.

## What is different

### Validation at ingest

Before a message is stored it must pass the validation a subscriber
applies: a valid signature (ERC-1271 included) and PUBLISH permission of
the publisher on the stream. A message that fails is dropped and logged;
a message that cannot be verified (chain unreachable) is stored, because
an outage must not erase legitimate history.

On the conversation stream (`-1`) of a Pombo channel whose gate is
**read-only and Visible**, only the gate owner and moderators are stored.
The gate contract accepts every member's signature on purpose (it cannot
tell streams apart); the stream-aware cut lives in the node. **Sealed**
channels are left alone: everyone publishes under the shared channel key
and the node is blind to authorship by design.

### `storedAt`

Every stored message carries the time this node received it, in a
`stored_at` column. Reads with `format=object` and `format=metadata`
return it as `storedAt`; `format=raw` is unchanged so vanilla clients keep
working. Rows written before the column existed have no value.

### `format=metadata`

`/streams/:id/data/partitions/:partition/{last,from,range}?format=metadata`
returns `{timestamp, sequenceNumber, publisherId, size, storedAt}` per
message, without the payload. Verifying which chunks of an upload a node
holds costs kilobytes instead of the upload itself.

### Purge

`POST /streams/:id/data/partitions/:partition/purge` deletes specific
messages from this node. Body:

```json
{
  "user": "0x…",          // the account asking
  "issuedAt": 1700000000000,
  "nonce": "random, unique per request",
  "signature": "0x…",     // see "Signed requests"
  "targets": [ { "timestamp": 1700000000000, "sequenceNumber": 0 } ]
}
```

At most 100 targets. The response lists each target with `deleted`,
`forbidden` or `not_found`. A request is honoured when the signer

- holds DELETE permission on the stream (the channel owner), or
- owns or moderates the channel's Pombo gate, or
- signed the message itself, checked against the stored envelope. On a
  Sealed channel every message carries the shared key's signature, so this
  rule is off there.

Other storage nodes of the same channel keep their copy: this removes the
message from this node, not from the network.

### Signed reads

Reading the streams of a gated channel requires a signed request
(`plugins.storage.signedReads.enabled`, on by default), and the signer must have access
to the channel right now (owner, moderator, or accepted by the gate's
`checkAccess`). The admin stream (`-3`) stays open: channel previews and
the entry screen of non-members are served from it. Streams outside
gated channels are unaffected. While the chain cannot be consulted the
node answers 503 rather than serve the data.

Headers: `x-pombo-user`, `x-pombo-issued-at`, `x-pombo-nonce`,
`x-pombo-signature`.

Clients that do not sign their reads cannot read gated channels from a
node with this enabled; disable it only to serve such clients.

### Retention (automatic, no external process)

A vanilla storage node keeps data forever unless an external command prunes
it. This node enforces retention itself, on a timer, in three phases:

1. **bucket retention:** whole buckets whose newest message is past the
   stream's `storageDays` (the upstream retention command);
2. **row sweep:** individual messages older than `storageDays` that are stuck
   in buckets which keep receiving writes, so phase 1 never closes them;
3. **orphan sweep:** data of streams deleted on-chain, which the first two
   phases skip because they read `storageDays` from the registry.

The orphan sweep is destructive and depends on the chain, so it is guarded:
it deletes only when the registry reports the stream as not found, aborts the
phase if any stream errors for another reason (an unstable RPC looks like a
deletion otherwise) or if a suspiciously large fraction of streams look
deleted, and holds a grace period before removing anything.

In a cluster the deletes replicate through Cassandra, so retention runs on
**one node only** — the node with `myIndexInCluster: 0`.

### `GET /capabilities`

```json
{ "name": "pombo-storage-node", "features": ["metadata", "storedAt", "purge", "signedReads"] }
```

`signedReads` appears in the list only while it is enabled.

## Signed requests

Purge and signed reads authenticate the requester with an EIP-191
`personal_sign` signature over a message built from the request itself,
one field per line:

```
pombo-storage-node
<purpose>            purge | read
<streamId>
<partition>
<issuedAt>           milliseconds since the epoch, client clock
<nonce>
<request lines…>
```

Request lines for `purge`: one line `timestamp:sequenceNumber` per target,
in the order sent. For `read`: the resend type (`last`, `from`, `range`)
and then the query string in canonical form, parameters sorted by name as
`name=value` joined with `&`, values unencoded.

The signature must recover `user`; `issuedAt` must be within five minutes
of the node's clock; a nonce is accepted once per user.

## Configuration

Storage plugin keys added to the upstream ones:

| Key | Default | Meaning |
|---|---|---|
| `bucket.maxBucketSize` | 8388608 | bytes per Cassandra bucket (100 MB upstream; smaller buckets keep partitions healthy under binary ingest) |
| `bucket.maxBucketRecords` | 500000 | messages per bucket |
| `bucket.checkFullBucketsTimeout` | 250 | ms between checks for full buckets |
| `batch.logErrors` | true | log failed batch inserts (upstream retries them silently) |
| `signedReads.enabled` | true | require signed reads on gated channels |
| `retention.enabled` | true | prune stored data past each stream's storageDays (runs on cluster node 0) |
| `retention.intervalHours` | 6 | how often retention runs |
| `retention.graceDays` | 7 | hold before deleting an on-chain-deleted stream's data |

`client.cache.maxAge` in the node config governs how long permission
lookups are cached; the example config sets 10 minutes so a revoked
publisher stops being stored within that time. The ERC-1271 result cache
in the SDK is 10 minutes as well.

## Schema

The `stream_data` table needs a `stored_at timestamp` column. New
installs get it from `deploy/cassandra/init.cql`; existing keyspaces apply
`packages/node/cassandra/stored_at.cql`. The node refuses to start
without it.

## SDK changes

Three public methods on `StreamrClient`, used by the storage plugin:
`validateMessage(msg)` (the subscriber-side validation), `getMessageSigner(msg)`
(the account behind an ECDSA or ERC-1271 signature) and `getProvider()`.
`StreamrClientError` is exported.

## License

The upstream code is under the Streamr Network Open Source License (AGPL v3
with additional terms); this fork stays under it. See [LICENSE](LICENSE).
