import { StreamrClient } from '@streamr/sdk'
import { randomEthereumAddress } from '@streamr/test-utils'
import { EthereumAddress } from '@streamr/utils'
import { mock } from 'jest-mock-extended'
import { GateInfo, GateReader, PomboGates, parseGateAddress, parseLinkedStream } from '../../../../src/plugins/storage/PomboGates'

const GATE = randomEthereumAddress()
const CONVERSATION_STREAM = '0x1234567890123456789012345678901234567890/abcdef-1'
const KEYS_STREAM = '0x1234567890123456789012345678901234567890/abcdef-4'

const gatedMetadata = (gate: EthereumAddress) => ({
    partitions: 11,
    description: JSON.stringify({ a: 'pombo', t: 'gated', g: gate })
})

const linkedMetadata = (linkedTo: string) => ({
    partitions: 4,
    description: JSON.stringify({ a: 'pombo', ln: linkedTo, k: 'keys' })
})

describe('PomboGates', () => {

    let client: ReturnType<typeof mock<StreamrClient>>
    let gateReader: ReturnType<typeof mock<GateReader>>
    let gates: PomboGates
    const info: GateInfo = { address: GATE, owner: randomEthereumAddress(), readOnly: false, visible: true }

    beforeEach(() => {
        client = mock<StreamrClient>()
        gateReader = mock<GateReader>()
        gateReader.getInfo.mockResolvedValue(info)
        client.getStreamMetadata.mockImplementation(async (streamId) => {
            if (streamId === CONVERSATION_STREAM) {
                return gatedMetadata(GATE)
            } else if (streamId === KEYS_STREAM) {
                return linkedMetadata(CONVERSATION_STREAM)
            }
            return { partitions: 1 }
        })
        gates = new PomboGates(client, gateReader)
    })

    afterEach(() => {
        gates.destroy()
    })

    it('reads the gate of a conversation stream', async () => {
        expect(await gates.getGate(CONVERSATION_STREAM)).toEqual(info)
        expect(gateReader.getInfo).toHaveBeenCalledWith(GATE)
    })

    it('follows a secondary stream to the conversation stream that carries the gate', async () => {
        expect(await gates.getGate(KEYS_STREAM)).toEqual(info)
        expect(client.getStreamMetadata).toHaveBeenCalledWith(KEYS_STREAM)
        expect(client.getStreamMetadata).toHaveBeenCalledWith(CONVERSATION_STREAM)
    })

    it('returns null for a stream outside any gated channel', async () => {
        expect(await gates.getGate('0x1234567890123456789012345678901234567890/other')).toBeNull()
        expect(gateReader.getInfo).not.toHaveBeenCalled()
    })

    it('caches gate and moderator lookups', async () => {
        gateReader.isModerator.mockResolvedValue(true)
        const user = randomEthereumAddress()
        await gates.getGate(CONVERSATION_STREAM)
        await gates.getGate(CONVERSATION_STREAM)
        expect(await gates.isModerator(GATE, user)).toBe(true)
        expect(await gates.isModerator(GATE, user)).toBe(true)
        expect(gateReader.getInfo).toHaveBeenCalledTimes(1)
        expect(gateReader.isModerator).toHaveBeenCalledTimes(1)
    })

    describe('metadata parsing', () => {
        it('reads the gate from the Pombo description', () => {
            expect(parseGateAddress(gatedMetadata(GATE))).toBe(GATE)
        })

        it('reads the linked conversation stream', () => {
            expect(parseLinkedStream(linkedMetadata(CONVERSATION_STREAM))).toBe(CONVERSATION_STREAM)
            expect(parseGateAddress(linkedMetadata(CONVERSATION_STREAM))).toBeUndefined()
        })

        it('ignores streams without a Pombo description', () => {
            expect(parseGateAddress({ partitions: 1 })).toBeUndefined()
            expect(parseGateAddress({ description: 'plain text' })).toBeUndefined()
            expect(parseGateAddress({ description: JSON.stringify({ g: 'not-an-address' }) })).toBeUndefined()
            expect(parseLinkedStream({ description: JSON.stringify({ ln: 42 }) })).toBeUndefined()
        })
    })
})
