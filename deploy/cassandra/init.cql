-- Schema for a single-node Pombo storage node. Applied once by the
-- cassandra-init service; every statement is idempotent.
--
-- For a multi-node Cassandra cluster replace SimpleStrategy with
-- NetworkTopologyStrategy and the replication factor you run, and apply the
-- file on one node only.

CREATE KEYSPACE IF NOT EXISTS streamr
    WITH replication = { 'class': 'SimpleStrategy', 'replication_factor': 1 };

USE streamr;

CREATE TABLE IF NOT EXISTS bucket (
    stream_id   text,
    partition   int,
    date_create timestamp,
    id          timeuuid,
    records     int,
    size        int,
    PRIMARY KEY ((stream_id, partition), date_create)
) WITH CLUSTERING ORDER BY (date_create DESC);

-- Messages are written and expire in time order, so time-window compaction
-- keeps deletes cheap; gc_grace of three days assumes a repair at least that
-- often on multi-node clusters (irrelevant on a single node).
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

-- Existing keyspaces created before stored_at existed:
-- ALTER TABLE stream_data ADD stored_at timestamp;
