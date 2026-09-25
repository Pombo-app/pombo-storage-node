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

    describe('what a refusal is worth', () => {
        beforeEach(() => {
            jest.useFakeTimers()
        })

        afterEach(() => {
            jest.useRealTimers()
        })

        it('asks again seconds after a refusal, so a payment is seen', async () => {
            const user = randomEthereumAddress()
            gateReader.checkAccess.mockResolvedValue(false)
            expect(await gates.hasAccess(GATE, user)).toBe(false)
            jest.advanceTimersByTime(21 * 1000)
            gateReader.checkAccess.mockResolvedValue(true)
            expect(await gates.hasAccess(GATE, user)).toBe(true)
            expect(gateReader.checkAccess).toHaveBeenCalledTimes(2)
        })

        it('keeps a grant for the full window', async () => {
            const user = randomEthereumAddress()
            gateReader.checkAccess.mockResolvedValue(true)
            expect(await gates.hasAccess(GATE, user)).toBe(true)
            jest.advanceTimersByTime(9 * 60 * 1000)
            expect(await gates.hasAccess(GATE, user)).toBe(true)
            expect(gateReader.checkAccess).toHaveBeenCalledTimes(1)
        })

        it('spares the chain between two refusals in the same breath', async () => {
            const user = randomEthereumAddress()
            gateReader.checkAccess.mockResolvedValue(false)
            await gates.hasAccess(GATE, user)
            jest.advanceTimersByTime(1000)
            await gates.hasAccess(GATE, user)
            expect(gateReader.checkAccess).toHaveBeenCalledTimes(1)
        })
    })

    describe('the last answer about a public stream', () => {
        const PUBLIC_STREAM = '0x1234567890123456789012345678901234567890/public-1'

        const askChain = async (streamId: string): Promise<void> => {
            if (await gates.getGate(streamId) === null) {
                await gates.isPublicSubscribe(streamId)
            }
        }

        beforeEach(() => {
            jest.useFakeTimers()
            client.hasPermission.mockResolvedValue(true)
        })

        afterEach(() => {
            jest.useRealTimers()
        })

        it('remembers a stream with no gate and public SUBSCRIBE', async () => {
            expect(gates.wasLastSeenPublic(PUBLIC_STREAM)).toBe(false)
            await askChain(PUBLIC_STREAM)
            expect(gates.wasLastSeenPublic(PUBLIC_STREAM)).toBe(true)
        })

        it('never remembers a private or a gated stream', async () => {
            client.hasPermission.mockResolvedValue(false)
            await askChain(PUBLIC_STREAM)
            await askChain(CONVERSATION_STREAM)
            expect(gates.wasLastSeenPublic(PUBLIC_STREAM)).toBe(false)
            expect(gates.wasLastSeenPublic(CONVERSATION_STREAM)).toBe(false)
        })

        it('keeps the last answer while the chain fails', async () => {
            await askChain(PUBLIC_STREAM)
            jest.advanceTimersByTime(11 * 60 * 1000)
            client.getStreamMetadata.mockRejectedValue(new Error('RPC unavailable'))
            client.hasPermission.mockRejectedValue(new Error('RPC unavailable'))
            await expect(askChain(PUBLIC_STREAM)).rejects.toThrow('RPC unavailable')
            expect(gates.wasLastSeenPublic(PUBLIC_STREAM)).toBe(true)
        })

        it('forgets it as soon as the chain answers that SUBSCRIBE is no longer public', async () => {
            await askChain(PUBLIC_STREAM)
            jest.advanceTimersByTime(11 * 60 * 1000)
            client.hasPermission.mockResolvedValue(false)
            await askChain(PUBLIC_STREAM)
            expect(gates.wasLastSeenPublic(PUBLIC_STREAM)).toBe(false)
        })

        it('forgets it as soon as the chain answers that the stream has a gate', async () => {
            await askChain(PUBLIC_STREAM)
            jest.advanceTimersByTime(21 * 1000)
            client.getStreamMetadata.mockResolvedValue(gatedMetadata(GATE))
            await askChain(PUBLIC_STREAM)
            expect(gates.wasLastSeenPublic(PUBLIC_STREAM)).toBe(false)
        })

        it('forgets it when the metadata names a gate, even if the gate itself cannot be read', async () => {
            await askChain(PUBLIC_STREAM)
            jest.advanceTimersByTime(21 * 1000)
            client.getStreamMetadata.mockResolvedValue(gatedMetadata(GATE))
            gateReader.getInfo.mockRejectedValue(new Error('RPC unavailable'))
            await expect(askChain(PUBLIC_STREAM)).rejects.toThrow('RPC unavailable')
            expect(gates.wasLastSeenPublic(PUBLIC_STREAM)).toBe(false)
        })

        it('forgets it when the stream is deleted on chain', async () => {
            await askChain(PUBLIC_STREAM)
            jest.advanceTimersByTime(21 * 1000)
            client.getStreamMetadata.mockRejectedValue(Object.assign(new Error('Stream not found'), { code: 'STREAM_NOT_FOUND' }))
            await expect(askChain(PUBLIC_STREAM)).rejects.toThrow('Stream not found')
            expect(gates.wasLastSeenPublic(PUBLIC_STREAM)).toBe(false)
        })
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
