/**
 * A message as it comes out of Cassandra: the serialized envelope and the
 * time this node received it. `storedAt` is missing for rows written before
 * the column existed.
 */
export interface StoredMessage {
    payload: Uint8Array
    storedAt?: number
}

/** One row of stream_data, with everything a delete needs to address it exactly. */
export interface StoredRow extends StoredMessage {
    bucketId: unknown
    timestamp: number
    sequenceNo: number
    publisherId: string
    msgChainId: string
}
