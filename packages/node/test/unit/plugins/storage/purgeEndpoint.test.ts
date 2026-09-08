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
import { PurgeAuthorizer, PurgeTarget, createPurgeEndpoint, targetToLine } from '../../../../src/plugins/storage/purgeEndpoint'

const STREAM_ID = toStreamID('0x1234567890123456789012345678901234567890/abcdef-1')
const PARTITION = 0
const GATE = randomEthereumAddress()
const OWNER = randomEthereumAddress()
const MODERATOR = randomEthereumAddress()

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

describe('purgeEndpoint', () => {

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
        const message = createSignedRequestMessage('purge', STREAM_ID, PARTITION, issuedAt, nonce, targets.map(targetToLine))
        return {
            user,
            issuedAt,
            nonce,
            signature: await signingWallet.signMessage(message),
            targets
        }
    }

    const purge = (body: any) => {
        return request(app).post(`/streams/${encodeURIComponent(STREAM_ID)}/data/partitions/${PARTITION}/purge`).send(body)
    }

    beforeEach(() => {
        storage = mock<Storage>()
        client = mock<StreamrClient>()
        gateReader = mock<GateReader>()
        rows = {
            [targetToLine({ timestamp: 1000, sequenceNumber: 0 })]: [createRow(1000, 0)],
            [targetToLine({ timestamp: 2000, sequenceNumber: 1 })]: [createRow(2000, 1)]
        }
        storage.getMessages.mockImplementation(async (_streamId, _partition, timestamp, sequenceNumber) => {
            return rows[targetToLine({ timestamp, sequenceNumber })] ?? []
        })
        storage.deleteMessage.mockResolvedValue(undefined)
        client.hasPermission.mockResolvedValue(false)
        client.getStreamMetadata.mockResolvedValue({ partitions: 1, description: JSON.stringify({ a: 'pombo', t: 'public' }) })
        client.getMessageSigner.mockReturnValue(randomEthereumAddress())
        gateReader.getInfo.mockResolvedValue(gate())
        gateReader.isModerator.mockResolvedValue(false)
        gates = new PomboGates(client, gateReader)
        app = express()
        const endpoint = createPurgeEndpoint(storage, new PurgeAuthorizer(client, gates), new SignedRequestVerifier())
        app.route(endpoint.path)[endpoint.method](endpoint.requestHandlers)
    })

    afterEach(() => {
        gates.destroy()
    })

    it('rejects a body without valid targets', async () => {
        await purge({ targets: [] }).expect(400)
        await purge({ targets: [{ timestamp: 'x' }] }).expect(400)
        await purge({}).expect(400)
    })

    it('rejects an unsigned request', async () => {
        await purge({ targets: [{ timestamp: 1000, sequenceNumber: 0 }] }).expect(401)
    })

    it('rejects a request signed by someone else than the claimed user', async () => {
        const body = await signedBody([{ timestamp: 1000, sequenceNumber: 0 }], Wallet.createRandom(), signer)
        await purge(body).expect(401)
    })

    it('deletes for an account with DELETE permission on the stream', async () => {
        client.hasPermission.mockResolvedValue(true)
        const body = await signedBody([{ timestamp: 1000, sequenceNumber: 0 }, { timestamp: 3000, sequenceNumber: 0 }])
        const res = await purge(body).expect(200)
        expect(res.body.results).toEqual([
            { timestamp: 1000, sequenceNumber: 0, result: 'deleted' },
            { timestamp: 3000, sequenceNumber: 0, result: 'not_found' }
        ])
        expect(storage.deleteMessage).toHaveBeenCalledTimes(1)
        expect(storage.deleteMessage).toHaveBeenCalledWith(STREAM_ID, PARTITION, rows['1000:0'][0])
    })

    it('deletes for the author of the message', async () => {
        client.getMessageSigner.mockReturnValue(signer)
        const body = await signedBody([{ timestamp: 1000, sequenceNumber: 0 }])
        const res = await purge(body).expect(200)
        expect(res.body.results[0].result).toBe('deleted')
    })

    it('refuses someone who is neither owner nor author', async () => {
        const body = await signedBody([{ timestamp: 1000, sequenceNumber: 0 }])
        const res = await purge(body).expect(200)
        expect(res.body.results[0].result).toBe('forbidden')
        expect(storage.deleteMessage).not.toHaveBeenCalled()
    })

    describe('gated channels', () => {
        beforeEach(() => {
            client.getStreamMetadata.mockResolvedValue({ partitions: 1, description: JSON.stringify({ a: 'pombo', t: 'gated', g: GATE }) })
        })

        it('deletes for the gate owner', async () => {
            const body = await signedBody([{ timestamp: 1000, sequenceNumber: 0 }], wallet, signer)
            gateReader.getInfo.mockResolvedValue(gate({ owner: signer }))
            const res = await purge(body).expect(200)
            expect(res.body.results[0].result).toBe('deleted')
        })

        it('deletes for a gate moderator', async () => {
            gateReader.isModerator.mockImplementation(async (_gate, user) => user === MODERATOR || user === signer)
            const body = await signedBody([{ timestamp: 1000, sequenceNumber: 0 }])
            const res = await purge(body).expect(200)
            expect(res.body.results[0].result).toBe('deleted')
        })

        it('deletes for the author on a Visible channel', async () => {
            client.getMessageSigner.mockReturnValue(signer)
            const body = await signedBody([{ timestamp: 1000, sequenceNumber: 0 }])
            const res = await purge(body).expect(200)
            expect(res.body.results[0].result).toBe('deleted')
        })

        it('never applies the author rule on a Sealed channel', async () => {
            gateReader.getInfo.mockResolvedValue(gate({ visible: false }))
            client.getMessageSigner.mockReturnValue(signer)
            const body = await signedBody([{ timestamp: 1000, sequenceNumber: 0 }])
            const res = await purge(body).expect(200)
            expect(res.body.results[0].result).toBe('forbidden')
            expect(client.getMessageSigner).not.toHaveBeenCalled()
        })
    })
})
