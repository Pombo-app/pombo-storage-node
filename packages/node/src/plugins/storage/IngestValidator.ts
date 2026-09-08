import { StreamMessage, StreamrClient } from '@streamr/sdk'
import { EthereumAddress, Logger, MapWithTtl, MetricsContext, RateMetric, toEthereumAddress } from '@streamr/utils'
import { Contract } from 'ethers'

const logger = new Logger('IngestValidator')

const POMBO_GATE_ABI = [
    'function owner() view returns (address)',
    'function readOnly() view returns (bool)',
    'function wireIdentity() view returns (uint8)',
    'function moderators(address) view returns (bool)'
]
const WIRE_IDENTITY_VISIBLE = 0
const CONVERSATION_STREAM_SUFFIX = '-1'
const CACHE_TTL = 10 * 60 * 1000

// Error codes that mean "this message must not be stored". Anything else
// (RPC failures, unknown errors) is treated as "could not verify" and the
// message is stored: a chain outage must not erase legitimate history.
const DEFINITIVE_REJECTIONS = new Set(['INVALID_SIGNATURE', 'MISSING_PERMISSION', 'INVALID_PARTITION', 'SIGNATURE_POLICY_VIOLATION'])

export interface GateInfo {
    address: EthereumAddress
    owner: EthereumAddress
    readOnly: boolean
    visible: boolean
}

export interface GateReader {
    getInfo: (gateAddress: EthereumAddress) => Promise<GateInfo>
    isModerator: (gateAddress: EthereumAddress, user: EthereumAddress) => Promise<boolean>
}

export type IngestVerdict = { store: true } | { store: false, reason: string }

/**
 * The Pombo gate address travels in the stream metadata: the `description`
 * field holds a JSON document whose `g` key is the gate contract.
 */
export const parseGateAddress = (metadata: Record<string, unknown>): EthereumAddress | undefined => {
    const description = metadata.description
    if (typeof description !== 'string') {
        return undefined
    }
    try {
        const pombo = JSON.parse(description)
        const gate = pombo?.g
        if (typeof gate === 'string' && /^0x[0-9a-fA-F]{40}$/.test(gate)) {
            return toEthereumAddress(gate)
        }
    } catch {
        // not a Pombo description
    }
    return undefined
}

export const createEthersGateReader = (client: StreamrClient): GateReader => {
    const contracts = new Map<EthereumAddress, Contract>()
    const getContract = (gateAddress: EthereumAddress): Contract => {
        let contract = contracts.get(gateAddress)
        if (contract === undefined) {
            contract = new Contract(gateAddress, POMBO_GATE_ABI, client.getProvider())
            contracts.set(gateAddress, contract)
        }
        return contract
    }
    return {
        getInfo: async (gateAddress) => {
            const contract = getContract(gateAddress)
            const [owner, readOnly, wireIdentity] = await Promise.all([
                contract.owner(),
                contract.readOnly(),
                contract.wireIdentity()
            ])
            return {
                address: gateAddress,
                owner: toEthereumAddress(owner),
                readOnly: Boolean(readOnly),
                visible: Number(wireIdentity) === WIRE_IDENTITY_VISIBLE
            }
        },
        isModerator: async (gateAddress, user) => {
            return Boolean(await getContract(gateAddress).moderators(user))
        }
    }
}

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
    private readonly gateReader: GateReader
    // streamId -> gate, or null for streams that are not a Pombo gated conversation
    private readonly gateCache = new MapWithTtl<string, GateInfo | null>(() => CACHE_TTL)
    private readonly moderatorCache = new MapWithTtl<string, boolean>(() => CACHE_TTL)
    private readonly metrics = {
        rejectedMessagesPerSecond: new RateMetric()
    }

    constructor(client: StreamrClient, metricsContext: MetricsContext, gateReader: GateReader = createEthersGateReader(client)) {
        this.client = client
        this.gateReader = gateReader
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

    destroy(): void {
        this.gateCache.clear()
        this.moderatorCache.clear()
    }

    private async enforceReadOnly(msg: StreamMessage): Promise<IngestVerdict> {
        const streamId = msg.getStreamId()
        if (!streamId.endsWith(CONVERSATION_STREAM_SUFFIX)) {
            return { store: true }
        }
        let gate: GateInfo | null
        try {
            gate = await this.getGate(streamId)
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
            if (await this.isModerator(gate.address, signer)) {
                return { store: true }
            }
        } catch (err) {
            logger.warn('Could not read moderators, storing message', { streamId, gate: gate.address, err })
            return { store: true }
        }
        return this.reject(msg, 'READ_ONLY', signer)
    }

    private async getGate(streamId: string): Promise<GateInfo | null> {
        const cached = this.gateCache.get(streamId)
        if (cached !== undefined) {
            return cached
        }
        const metadata = await this.client.getStreamMetadata(streamId)
        const gateAddress = parseGateAddress(metadata)
        const info = (gateAddress !== undefined) ? await this.gateReader.getInfo(gateAddress) : null
        this.gateCache.set(streamId, info)
        return info
    }

    private async isModerator(gateAddress: EthereumAddress, user: EthereumAddress): Promise<boolean> {
        const key = `${gateAddress}_${user}`
        const cached = this.moderatorCache.get(key)
        if (cached !== undefined) {
            return cached
        }
        const result = await this.gateReader.isModerator(gateAddress, user)
        this.moderatorCache.set(key, result)
        return result
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
