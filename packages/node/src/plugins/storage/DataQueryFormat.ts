import { type StreamMessage, convertBytesToStreamMessage } from '@streamr/sdk'
import { binaryToHex, toLengthPrefixedFrame } from '@streamr/utils'
import { StoredMessage } from './StoredMessage'

export interface Format {
    formatMessage: ((msg: StoredMessage) => string) | ((msg: StoredMessage) => Uint8Array)
    contentType: string
    delimiter?: string
    header?: string
    footer?: string
}

const createJsonFormat = (formatMessage: (msg: StoredMessage) => string): Format => {
    return {
        formatMessage,
        contentType: 'application/json',
        delimiter: ',',
        header: '[',
        footer: ']'
    }
}

const createBinaryFormat = (formatMessage: (msg: StoredMessage) => Uint8Array): Format => {
    return {
        formatMessage,
        contentType: 'application/octet-stream'
    }
}

export const toObject = (msg: StreamMessage, storedAt?: number): any => {
    const parsedContent = msg.getParsedContent()
    const result: any = {
        streamId: msg.getStreamId(),
        streamPartition: msg.getStreamPartition(),
        timestamp: msg.getTimestamp(),
        sequenceNumber: msg.getSequenceNumber(),
        publisherId: msg.getPublisherId(),
        msgChainId: msg.getMsgChainId(),
        messageType: msg.messageType,
        contentType: msg.contentType,
        encryptionType: msg.encryptionType,
        content: parsedContent instanceof Uint8Array ? binaryToHex(parsedContent) : parsedContent,
        signature: binaryToHex(msg.signature),
    }
    if (msg.groupKeyId !== undefined) {
        result.groupKeyId = msg.groupKeyId
    }
    if (storedAt !== undefined) {
        result.storedAt = storedAt
    }
    return result
}

/**
 * Message metadata without the payload. Lets a client confirm which messages
 * a node holds (e.g. verify a chunked upload) at a fraction of the cost of
 * reading the content back. `size` is the binary content length, or null
 * when the content is not binary. `storedAt` is the time this node received
 * the message, which the publisher cannot choose; absent on rows written
 * before the node recorded it.
 */
export const toMetadataObject = (msg: StreamMessage, storedAt?: number): any => {
    let size: number | null = null
    try {
        const content = msg.getParsedContent()
        if (content instanceof Uint8Array) {
            size = content.length
        }
    } catch {
        // unparsable content: report the message without a size
    }
    const result: any = {
        timestamp: msg.getTimestamp(),
        sequenceNumber: msg.getSequenceNumber(),
        publisherId: msg.getPublisherId(),
        size
    }
    if (storedAt !== undefined) {
        result.storedAt = storedAt
    }
    return result
}

const FORMATS: Record<string, Format> = {
    'object': createJsonFormat((msg: StoredMessage) => JSON.stringify(toObject(convertBytesToStreamMessage(msg.payload), msg.storedAt))),
    'raw': createBinaryFormat((msg: StoredMessage) => toLengthPrefixedFrame(msg.payload)),
    'metadata': createJsonFormat((msg: StoredMessage) => JSON.stringify(toMetadataObject(convertBytesToStreamMessage(msg.payload), msg.storedAt)))
}

export const getFormat = (id: string | undefined): Format | undefined => {
    const key = id ?? 'object'
    return FORMATS[key]
}
