-- Receipt timestamp written by the node for every stored message.
-- Run once against an existing keyspace before starting a node that
-- carries this column; rows written before the change have no value.
ALTER TABLE stream_data ADD stored_at timestamp;
