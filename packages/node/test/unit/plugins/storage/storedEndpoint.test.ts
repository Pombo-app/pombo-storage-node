import {
    ContentType,
    EncryptionType,
    MessageID,
    SignatureType,
    StreamMessage,
    StreamrClient,
    convertStreamMessageToBytes
} from '@streamr/sdk'
import { randomEthereumAddress, randomUserId } from '@streamr/test-utils'
import { EthereumAddress, hexToBinary, toEthereumAddress, toStreamID, utf8ToBinary } from '@streamr/utils'
import { BaseWallet, Wallet } from 'ethers'
import express from 'express'
import { mock } from 'jest-mock-extended'
import request from 'supertest'
import { GateInfo, GateReader, PomboGates } from '../../../../src/plugins/storage/PomboGates'
import { SignedRequestVerifier, createSignedRequestMessage } from '../../../../src/plugins/storage/SignedRequest'
import { Storage } from '../../../../src/plugins/storage/Storage'
import { StoredRow } from '../../../../src/plugins/storage/StoredMessage'
import { PurgeTarget, targetToLine } from '../../../../src/plugins/storage/purgeEndpoint'
import { createStoredEndpoint } from '../../../../src/plugins/storage/storedEndpoint'

const STREAM_ID = toStreamID('0x1234567890123456789012345678901234567890/Pombo-DM-1')
const PARTITION = 0
const GATE = randomEthereumAddress()
const OWNER = randomEthereumAddress()

const createRow = (timestamp: number, sequenceNo: number): StoredRow => {
    const msg = new StreamMessage({
        messageId: new MessageID(STREAM_ID, PARTITION, timestamp, sequenceNo, randomUserId(), 'msgChainId'),
        content: utf8ToBinary(JSON.stringify({ hello: 'world' })),
        signature: hexToBinary('0x1234'),
        contentType: ContentType.JSON,
        encryptionType: EncryptionType.NONE,
        signatureType: SignatureType.ECDSA_SECP256K1_EVM
    })
    return {
        bucketId: 'bucket',
        timestamp,
        sequenceNo,
        publisherId: msg.getPublisherId(),
        msgChainId: 'msgChainId',
        payload: convertStreamMessageToBytes(msg)
    }
}

describe('storedEndpoint', () => {

    const wallet = Wallet.createRandom()
    const signer = toEthereumAddress(wallet.address)
    let app: express.Express
    let storage: ReturnType<typeof mock<Storage>>
    let client: ReturnType<typeof mock<StreamrClient>>
    let gateReader: ReturnType<typeof mock<GateReader>>
    let gates: PomboGates
    let rows: Record<string, StoredRow[]>

    const gate = (overrides: Partial<GateInfo> = {}): GateInfo => ({
        address: GATE,
        owner: OWNER,
        readOnly: false,
        visible: true,
        ...overrides
    })

    const signedBody = async (targets: PurgeTarget[], signingWallet: BaseWallet = wallet, user: EthereumAddress = signer) => {
        const issuedAt = Date.now()
        const nonce = `nonce-${Math.random()}`
        const message = createSignedRequestMessage('stored', STREAM_ID, PARTITION, issuedAt, nonce, targets.map(targetToLine))
        return { user, issuedAt, nonce, signature: await signingWallet.signMessage(message), targets }
    }

    const stored = (body: any) => {
        return request(app).post(`/streams/${encodeURIComponent(STREAM_ID)}/data/partitions/${PARTITION}/stored`).send(body)
    }

    beforeEach(() => {
        storage = mock<Storage>()
        client = mock<StreamrClient>()
        gateReader = mock<GateReader>()
        rows = {
            [targetToLine({ timestamp: 1000, sequenceNumber: 0 })]: [createRow(1000, 0)]
        }
        storage.getMessages.mockImplementation(async (_streamId, _partition, timestamp, sequenceNumber) => {
            return rows[targetToLine({ timestamp, sequenceNumber })] ?? []
        })
        client.hasPermission.mockResolvedValue(false)   // not a reader by default
        client.getStreamMetadata.mockResolvedValue({ partitions: 1, description: JSON.stringify({ a: 'pombo', t: 'public' }) })   // no gate
        client.getMessageSigner.mockReturnValue(randomEthereumAddress())   // not the signer by default
        gateReader.getInfo.mockResolvedValue(gate())
        gates = new PomboGates(client, gateReader)
        app = express()
        const endpoint = createStoredEndpoint(storage, gates, client, new SignedRequestVerifier())
        app.route(endpoint.path)[endpoint.method](endpoint.requestHandlers)
    })

    afterEach(() => {
        gates.destroy()
    })

    it('rejects a body without valid targets', async () => {
        await stored({ targets: [] }).expect(400)
        await stored({ targets: [{ timestamp: 'x' }] }).expect(400)
        await stored({}).expect(400)
    })

    it('rejects an unsigned request', async () => {
        await stored({ targets: [{ timestamp: 1000, sequenceNumber: 0 }] }).expect(401)
    })

    it('rejects a request signed by someone else than the claimed user', async () => {
        const body = await signedBody([{ timestamp: 1000, sequenceNumber: 0 }], Wallet.createRandom(), signer)
        await stored(body).expect(401)
    })

    it('reports present/absent to a reader of the stream', async () => {
        client.hasPermission.mockImplementation(async (query: any) => query.public === true)   // public: a reader
        const body = await signedBody([{ timestamp: 1000, sequenceNumber: 0 }, { timestamp: 9999, sequenceNumber: 0 }])
        const res = await stored(body).expect(200)
        expect(res.body.results).toEqual([
            { timestamp: 1000, sequenceNumber: 0, result: 'present' },
            { timestamp: 9999, sequenceNumber: 0, result: 'absent' }
        ])
    })

    it('reports present for a non-reader only on rows it signed', async () => {
        client.getMessageSigner.mockReturnValue(signer)
        const body = await signedBody([{ timestamp: 1000, sequenceNumber: 0 }])
        const res = await stored(body).expect(200)
        expect(res.body.results[0].result).toBe('present')
    })

    it('is not an existence oracle: a non-reader who did not sign gets absent whether or not the row exists', async () => {
        // signer is neither a reader (hasPermission false) nor the author (getMessageSigner returns a random address)
        const body = await signedBody([
            { timestamp: 1000, sequenceNumber: 0 },   // exists, signed by someone else
            { timestamp: 9999, sequenceNumber: 0 }    // does not exist
        ])
        const res = await stored(body).expect(200)
        expect(res.body.results).toEqual([
            { timestamp: 1000, sequenceNumber: 0, result: 'absent' },
            { timestamp: 9999, sequenceNumber: 0, result: 'absent' }
        ])
    })

    it('refuses while the chain cannot be consulted', async () => {
        client.hasPermission.mockRejectedValue(new Error('RPC unavailable'))
        const body = await signedBody([{ timestamp: 1000, sequenceNumber: 0 }])
        await stored(body).expect(503)
    })
})
