import { StreamMessage, StreamrClient } from '@streamr/sdk'
import { EthereumAddress, Logger, MetricsContext, RateMetric } from '@streamr/utils'
import { GateInfo, PomboGates } from './PomboGates'

const logger = new Logger('IngestValidator')

const CONVERSATION_STREAM_SUFFIX = '-1'

// Error codes that mean "this message must not be stored". Anything else
// (RPC failures, unknown errors) is treated as "could not verify" and the
// message is stored: a chain outage must not erase legitimate history.
const DEFINITIVE_REJECTIONS = new Set(['INVALID_SIGNATURE', 'MISSING_PERMISSION', 'INVALID_PARTITION', 'SIGNATURE_POLICY_VIOLATION'])

export type IngestVerdict = { store: true } | { store: false, reason: string }

/**
 * Decides at ingest whether a message may be stored.
 *
 * 1. Protocol rule, every stream: valid signature and PUBLISH permission of
 *    the publisher, exactly as a subscriber validates.
 * 2. Pombo rule, conversation streams of read-only Visible gated channels:
 *    only the gate owner and moderators publish. The gate contract accepts
 *    every member's ERC-1271 signature on purpose (it cannot tell streams
 *    apart), so the stream-aware cut lives here. Sealed channels are skipped:
 *    the publisher is the shared channel key and the node is blind to
 *    authorship by design.
 */
export class IngestValidator {

    private readonly client: StreamrClient
    private readonly gates: PomboGates
    private readonly metrics = {
        rejectedMessagesPerSecond: new RateMetric()
    }

    constructor(client: StreamrClient, metricsContext: MetricsContext, gates: PomboGates) {
        this.client = client
        this.gates = gates
        metricsContext.addMetrics('broker.plugin.storage', this.metrics)
    }

    async validate(msg: StreamMessage): Promise<IngestVerdict> {
        try {
            await this.client.validateMessage(msg)
        } catch (err: any) {
            if (DEFINITIVE_REJECTIONS.has(err?.code)) {
                return this.reject(msg, err.code)
            }
            logger.warn('Could not validate message, storing it', {
                streamId: msg.getStreamId(),
                publisherId: msg.getPublisherId(),
                err
            })
            return { store: true }
        }
        return this.enforceReadOnly(msg)
    }

    private async enforceReadOnly(msg: StreamMessage): Promise<IngestVerdict> {
        const streamId = msg.getStreamId()
        if (!streamId.endsWith(CONVERSATION_STREAM_SUFFIX)) {
            return { store: true }
        }
        let gate: GateInfo | null
        try {
            gate = await this.gates.getGate(streamId)
        } catch (err) {
            logger.warn('Could not read gate, storing message', { streamId, err })
            return { store: true }
        }
        if (gate === null || !gate.readOnly || !gate.visible) {
            return { store: true }
        }
        let signer: EthereumAddress
        try {
            signer = this.client.getMessageSigner(msg)
        } catch {
            return this.reject(msg, 'UNRECOVERABLE_SIGNER')
        }
        if (signer === gate.owner) {
            return { store: true }
        }
        try {
            if (await this.gates.isModerator(gate.address, signer)) {
                return { store: true }
            }
        } catch (err) {
            logger.warn('Could not read moderators, storing message', { streamId, gate: gate.address, err })
            return { store: true }
        }
        return this.reject(msg, 'READ_ONLY', signer)
    }

    private reject(msg: StreamMessage, reason: string, signer?: EthereumAddress): IngestVerdict {
        this.metrics.rejectedMessagesPerSecond.record(1)
        logger.info('Rejected message at ingest', {
            reason,
            streamId: msg.getStreamId(),
            partition: msg.getStreamPartition(),
            timestamp: msg.getTimestamp(),
            sequenceNumber: msg.getSequenceNumber(),
            publisherId: msg.getPublisherId(),
            signer
        })
        return { store: false, reason }
    }
}
