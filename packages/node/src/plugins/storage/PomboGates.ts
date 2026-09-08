import { StreamrClient } from '@streamr/sdk'
import { EthereumAddress, MapWithTtl, toEthereumAddress } from '@streamr/utils'
import { Contract } from 'ethers'

const POMBO_GATE_ABI = [
    'function owner() view returns (address)',
    'function readOnly() view returns (bool)',
    'function wireIdentity() view returns (uint8)',
    'function moderators(address) view returns (bool)'
]
const WIRE_IDENTITY_VISIBLE = 0
const CACHE_TTL = 10 * 60 * 1000

export interface GateInfo {
    address: EthereumAddress
    owner: EthereumAddress
    readOnly: boolean
    /** Visible: every message is signed by its author. Sealed: everyone publishes under a shared key. */
    visible: boolean
}

export interface GateReader {
    getInfo: (gateAddress: EthereumAddress) => Promise<GateInfo>
    isModerator: (gateAddress: EthereumAddress, user: EthereumAddress) => Promise<boolean>
}

const parsePomboDescription = (metadata: Record<string, unknown>): Record<string, unknown> | undefined => {
    const description = metadata.description
    if (typeof description !== 'string') {
        return undefined
    }
    try {
        const parsed = JSON.parse(description)
        return (parsed !== null && typeof parsed === 'object') ? parsed : undefined
    } catch {
        return undefined
    }
}

/**
 * The Pombo gate address travels in the stream metadata: the `description`
 * field holds a JSON document whose `g` key is the gate contract.
 */
export const parseGateAddress = (metadata: Record<string, unknown>): EthereumAddress | undefined => {
    const gate = parsePomboDescription(metadata)?.g
    if (typeof gate === 'string' && /^0x[0-9a-fA-F]{40}$/.test(gate)) {
        return toEthereumAddress(gate)
    }
    return undefined
}

/**
 * The secondary streams of a channel (presence, admin, keys, interactions)
 * carry no gate of their own; their `ln` key names the conversation stream
 * that does.
 */
export const parseLinkedStream = (metadata: Record<string, unknown>): string | undefined => {
    const linked = parsePomboDescription(metadata)?.ln
    return (typeof linked === 'string' && linked.length > 0) ? linked : undefined
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
 * Resolves the Pombo gate behind any stream of a channel, with the chain
 * reads cached: the gate itself is immutable, and a ban or a new moderator
 * is seen within CACHE_TTL.
 */
export class PomboGates {

    private readonly client: StreamrClient
    private readonly gateReader: GateReader
    // streamId -> gate, or null for streams that do not belong to a gated channel
    private readonly gateCache = new MapWithTtl<string, GateInfo | null>(() => CACHE_TTL)
    private readonly moderatorCache = new MapWithTtl<string, boolean>(() => CACHE_TTL)

    constructor(client: StreamrClient, gateReader: GateReader = createEthersGateReader(client)) {
        this.client = client
        this.gateReader = gateReader
    }

    async getGate(streamId: string): Promise<GateInfo | null> {
        const cached = this.gateCache.get(streamId)
        if (cached !== undefined) {
            return cached
        }
        const metadata = await this.client.getStreamMetadata(streamId)
        let gateAddress = parseGateAddress(metadata)
        if (gateAddress === undefined) {
            const linked = parseLinkedStream(metadata)
            if (linked !== undefined && linked !== streamId) {
                gateAddress = parseGateAddress(await this.client.getStreamMetadata(linked))
            }
        }
        const info = (gateAddress !== undefined) ? await this.gateReader.getInfo(gateAddress) : null
        this.gateCache.set(streamId, info)
        return info
    }

    async isModerator(gateAddress: EthereumAddress, user: EthereumAddress): Promise<boolean> {
        const key = `${gateAddress}_${user}`
        const cached = this.moderatorCache.get(key)
        if (cached !== undefined) {
            return cached
        }
        const result = await this.gateReader.isModerator(gateAddress, user)
        this.moderatorCache.set(key, result)
        return result
    }

    destroy(): void {
        this.gateCache.clear()
        this.moderatorCache.clear()
    }
}
