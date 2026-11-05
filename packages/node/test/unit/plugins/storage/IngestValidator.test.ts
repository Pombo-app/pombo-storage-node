import { ContentType, EncryptionType, MessageID, SignatureType, StreamMessage, StreamrClient, StreamrClientError } from '@streamr/sdk'
import { randomEthereumAddress, randomUserId } from '@streamr/test-utils'
import { EthereumAddress, MetricsContext, hexToBinary, toStreamID, utf8ToBinary } from '@streamr/utils'
import { mock } from 'jest-mock-extended'
import { IngestValidator } from '../../../../src/plugins/storage/IngestValidator'
import { GateInfo, GateReader, PomboGates } from '../../../../src/plugins/storage/PomboGates'

const mockWarn = jest.fn()
jest.mock('@streamr/utils', () => {
    const actual = jest.requireActual('@streamr/utils')
    return {
        ...actual,
        Logger: class extends actual.Logger {
            constructor(...args: any[]) {
                super(...args)
                this.warn = (...warnArgs: any[]) => mockWarn(...warnArgs)
            }
        }
    }
})

const OWNER = randomEthereumAddress()
const MODERATOR = randomEthereumAddress()
const MEMBER = randomEthereumAddress()
const GATE = randomEthereumAddress()
const CONVERSATION_STREAM = toStreamID('0x1234567890123456789012345678901234567890/abcdef-1')
const REACTIONS_STREAM = toStreamID('0x1234567890123456789012345678901234567890/abcdef-5')

const createStreamMessage = (streamId = CONVERSATION_STREAM): StreamMessage => {
    return new StreamMessage({
        messageId: new MessageID(streamId, 0, Date.now(), 0, randomUserId(), 'msgChainId'),
        content: utf8ToBinary(JSON.stringify({ hello: 'world' })),
        signature: hexToBinary('0x1234'),
        contentType: ContentType.JSON,
        encryptionType: EncryptionType.NONE,
        signatureType: SignatureType.ERC_1271
    })
}

const gatedMetadata = (gate: EthereumAddress) => ({
    partitions: 1,
    description: JSON.stringify({ a: 'pombo', t: 'gated', g: gate })
})

describe('IngestValidator', () => {

    let client: ReturnType<typeof mock<StreamrClient>>
    let gateReader: ReturnType<typeof mock<GateReader>>
    let gates: PomboGates
    let validator: IngestValidator

    const gate = (overrides: Partial<GateInfo> = {}): GateInfo => ({
        address: GATE,
        owner: OWNER,
        readOnly: true,
        visible: true,
        ...overrides
    })

    beforeEach(() => {
        client = mock<StreamrClient>()
        gateReader = mock<GateReader>()
        client.validateMessage.mockResolvedValue(undefined)
        client.getStreamMetadata.mockResolvedValue(gatedMetadata(GATE))
        gateReader.getInfo.mockResolvedValue(gate())
        gateReader.isModerator.mockImplementation(async (_gate, user) => user === MODERATOR)
        gates = new PomboGates(client, gateReader)
        validator = new IngestValidator(client, new MetricsContext(), gates)
    })

    afterEach(() => {
        gates.destroy()
    })

    describe('protocol rule', () => {
        it('rejects a message the subscriber validation rejects', async () => {
            client.validateMessage.mockRejectedValue(new StreamrClientError('nope', 'MISSING_PERMISSION'))
            const verdict = await validator.validate(createStreamMessage())
            expect(verdict).toEqual({ store: false, reason: 'MISSING_PERMISSION' })
        })

        it('rejects an invalid signature', async () => {
            client.validateMessage.mockRejectedValue(new StreamrClientError('nope', 'INVALID_SIGNATURE'))
            const verdict = await validator.validate(createStreamMessage())
            expect(verdict).toEqual({ store: false, reason: 'INVALID_SIGNATURE' })
        })

        it('stores when validation cannot be completed', async () => {
            client.validateMessage.mockRejectedValue(new Error('RPC unavailable'))
            const verdict = await validator.validate(createStreamMessage())
            expect(verdict).toEqual({ store: true })
        })

        it('logs why validation could not complete, without the message', async () => {
            const msg = createStreamMessage()
            const err: any = new Error('Could not reach the StreamPermission Smart Contract')
            err.code = 'UNKNOWN_ERROR'
            err.streamMessage = msg
            client.validateMessage.mockRejectedValue(err)
            expect(await validator.validate(msg)).toEqual({ store: true })
            const call = mockWarn.mock.calls.find(([text]) => text === 'Could not validate message, storing it')
            expect(call?.[1]).toEqual({
                streamId: msg.getStreamId(),
                publisherId: msg.getPublisherId(),
                code: 'UNKNOWN_ERROR',
                reason: 'Could not reach the StreamPermission Smart Contract'
            })
        })
    })

    describe('read-only Visible channels', () => {
        it('stores the owner', async () => {
            client.getMessageSigner.mockReturnValue(OWNER)
            expect(await validator.validate(createStreamMessage())).toEqual({ store: true })
        })

        it('stores a moderator', async () => {
            client.getMessageSigner.mockReturnValue(MODERATOR)
            expect(await validator.validate(createStreamMessage())).toEqual({ store: true })
        })

        it('rejects a member on the conversation stream', async () => {
            client.getMessageSigner.mockReturnValue(MEMBER)
            expect(await validator.validate(createStreamMessage())).toEqual({ store: false, reason: 'READ_ONLY' })
        })

        it('leaves the other streams of the channel alone', async () => {
            client.getMessageSigner.mockReturnValue(MEMBER)
            expect(await validator.validate(createStreamMessage(REACTIONS_STREAM))).toEqual({ store: true })
            expect(gateReader.getInfo).not.toHaveBeenCalled()
        })

        it('does not apply to channels that are not read-only', async () => {
            gateReader.getInfo.mockResolvedValue(gate({ readOnly: false }))
            client.getMessageSigner.mockReturnValue(MEMBER)
            expect(await validator.validate(createStreamMessage())).toEqual({ store: true })
        })

        it('is blind to authorship on Sealed channels', async () => {
            gateReader.getInfo.mockResolvedValue(gate({ visible: false }))
            client.getMessageSigner.mockReturnValue(MEMBER)
            expect(await validator.validate(createStreamMessage())).toEqual({ store: true })
            expect(client.getMessageSigner).not.toHaveBeenCalled()
        })

        it('does not apply to streams without a gate', async () => {
            client.getStreamMetadata.mockResolvedValue({ partitions: 1, description: JSON.stringify({ a: 'pombo', t: 'public' }) })
            client.getMessageSigner.mockReturnValue(MEMBER)
            expect(await validator.validate(createStreamMessage())).toEqual({ store: true })
            expect(gateReader.getInfo).not.toHaveBeenCalled()
        })

        it('stores when the gate cannot be read', async () => {
            gateReader.getInfo.mockRejectedValue(new Error('RPC unavailable'))
            client.getMessageSigner.mockReturnValue(MEMBER)
            expect(await validator.validate(createStreamMessage())).toEqual({ store: true })
        })

        it('reads the gate once per stream', async () => {
            client.getMessageSigner.mockReturnValue(OWNER)
            await validator.validate(createStreamMessage())
            await validator.validate(createStreamMessage())
            expect(client.getStreamMetadata).toHaveBeenCalledTimes(1)
            expect(gateReader.getInfo).toHaveBeenCalledTimes(1)
        })
    })
})
