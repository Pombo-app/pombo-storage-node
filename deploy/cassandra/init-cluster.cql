-- Schema for a Pombo storage CLUSTER (>1 machine) on a replicated Cassandra.
-- Apply once, on the first node only, after all Cassandra nodes have joined
-- the ring. The replication factor equals the number of machines, so every
-- node keeps a full copy and any node can serve any read (install.sh sets it).

CREATE KEYSPACE IF NOT EXISTS pombo_storage
    WITH replication = { 'class': 'NetworkTopologyStrategy', 'dc1': 2 };

USE pombo_storage;

CREATE TABLE IF NOT EXISTS bucket (
    stream_id   text,
    partition   int,
    date_create timestamp,
    id          timeuuid,
    records     int,
    size        int,
    PRIMARY KEY ((stream_id, partition), date_create)
) WITH CLUSTERING ORDER BY (date_create DESC);

CREATE TABLE IF NOT EXISTS stream_data (
    stream_id    text,
    partition    int,
    bucket_id    timeuuid,
    ts           timestamp,
    sequence_no  int,
    publisher_id text,
    msg_chain_id text,
    payload      blob,
    stored_at    timestamp,
    PRIMARY KEY ((stream_id, partition, bucket_id), ts, sequence_no, publisher_id, msg_chain_id)
) WITH CLUSTERING ORDER BY (ts ASC, sequence_no ASC)
  AND compaction = { 'class': 'TimeWindowCompactionStrategy', 'compaction_window_unit': 'DAYS', 'compaction_window_size': 7, 'unchecked_tombstone_compaction': true }
  AND compression = { 'class': 'LZ4Compressor', 'chunk_length_in_kb': 64 }
  AND gc_grace_seconds = 259200;
