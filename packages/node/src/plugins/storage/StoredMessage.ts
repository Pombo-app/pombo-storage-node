/**
 * A message as it comes out of Cassandra: the serialized envelope and the
 * time this node received it. `storedAt` is missing for rows written before
 * the column existed.
 */
export interface StoredMessage {
    payload: Uint8Array
    storedAt?: number
}
