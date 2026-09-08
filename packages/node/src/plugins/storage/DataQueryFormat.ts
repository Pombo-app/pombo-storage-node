import { type StreamMessage, convertBytesToStreamMessage } from '@streamr/sdk'
import { binaryToHex, toLengthPrefixedFrame } from '@streamr/utils'

export interface Format {
    formatMessage: ((bytes: Uint8Array) => string) | ((bytes: Uint8Array) => Uint8Array)
    contentType: string
    delimiter?: string
    header?: string
    footer?: string
}

const createJsonFormat = (formatMessage: (bytes: Uint8Array) => string): Format => {
    return {
        formatMessage,
        contentType: 'application/json',
        delimiter: ',',
        header: '[',
        footer: ']'
    }
}

const createBinaryFormat = (formatMessage: (bytes: Uint8Array) => Uint8Array): Format => {
    return {
        formatMessage,
        contentType: 'application/octet-stream'
    }
}

export const toObject = (msg: StreamMessage): any => {
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
    return result
}

/**
 * Message metadata without the payload. Lets a client confirm which messages
 * a node holds (e.g. verify a chunked upload) at a fraction of the cost of
 * reading the content back. `size` is the binary content length, or null
 * when the content is not binary.
 */
export const toMetadataObject = (msg: StreamMessage): any => {
    let size: number | null = null
    try {
        const content = msg.getParsedContent()
        if (content instanceof Uint8Array) {
            size = content.length
        }
    } catch {
        // unparsable content: report the message without a size
    }
    return {
        timestamp: msg.getTimestamp(),
        sequenceNumber: msg.getSequenceNumber(),
        publisherId: msg.getPublisherId(),
        size
    }
}

const FORMATS: Record<string, Format> = {
    'object': createJsonFormat((bytes: Uint8Array) => JSON.stringify(toObject(convertBytesToStreamMessage(bytes)))),
    'raw': createBinaryFormat(toLengthPrefixedFrame),
    'metadata': createJsonFormat((bytes: Uint8Array) => JSON.stringify(toMetadataObject(convertBytesToStreamMessage(bytes))))
}

export const getFormat = (id: string | undefined): Format | undefined => {
    const key = id ?? 'object'
    return FORMATS[key]
}
