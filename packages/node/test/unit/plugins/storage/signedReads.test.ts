import { StreamrClient } from '@streamr/sdk'
import { randomEthereumAddress } from '@streamr/test-utils'
import { EthereumAddress, toEthereumAddress } from '@streamr/utils'
import { BaseWallet, Wallet } from 'ethers'
import express from 'express'
import { mock } from 'jest-mock-extended'
import request from 'supertest'
import { GateInfo, GateReader, PomboGates } from '../../../../src/plugins/storage/PomboGates'
import { SignedRequestVerifier, createSignedRequestMessage } from '../../../../src/plugins/storage/SignedRequest'
import { SIGNED_READ_HEADERS, canonicalQuery, createSignedReadGuard } from '../../../../src/plugins/storage/signedReads'

const BASE = '0x1234567890123456789012345678901234567890/abcdef'
const GATE = randomEthereumAddress()
const OWNER = randomEthereumAddress()

describe('signed reads', () => {

    const wallet = Wallet.createRandom()
    const user = toEthereumAddress(wallet.address)
    let client: ReturnType<typeof mock<StreamrClient>>
    let gateReader: ReturnType<typeof mock<GateReader>>
    let gates: PomboGates

    const gate = (overrides: Partial<GateInfo> = {}): GateInfo => ({
        address: GATE,
        owner: OWNER,
        readOnly: false,
        visible: true,
        ...overrides
    })

    const createApp = (enabled: boolean) => {
        const app = express()
        const guard = createSignedReadGuard(enabled, gates, new SignedRequestVerifier())
        app.get('/streams/:id/data/partitions/:partition/:resendType', guard, (_req, res) => {
            res.status(200).json({ ok: true })
        })
        return app
    }

    const read = (app: express.Express, streamId: string, query: Record<string, string>) => {
        return request(app).get(`/streams/${encodeURIComponent(streamId)}/data/partitions/0/last`).query(query)
    }

    const signedRead = async (
        app: express.Express,
        streamId: string,
        query: Record<string, string>,
        expectedStatus: number,
        signer: BaseWallet = wallet,
        claimedUser: EthereumAddress = user
    ) => {
        const issuedAt = Date.now()
        const nonce = `nonce-${Math.random()}`
        const message = createSignedRequestMessage('read', streamId, 0, issuedAt, nonce, ['last', canonicalQuery(query)])
        const signature = await signer.signMessage(message)
        await read(app, streamId, query)
            .set(SIGNED_READ_HEADERS.user, claimedUser)
            .set(SIGNED_READ_HEADERS.issuedAt, String(issuedAt))
            .set(SIGNED_READ_HEADERS.nonce, nonce)
            .set(SIGNED_READ_HEADERS.signature, signature)
            .expect(expectedStatus)
    }

    beforeEach(() => {
        client = mock<StreamrClient>()
        gateReader = mock<GateReader>()
        client.getStreamMetadata.mockImplementation(async (streamId) => {
            if (streamId.startsWith(BASE)) {
                return streamId.endsWith('-1')
                    ? { partitions: 11, description: JSON.stringify({ a: 'pombo', t: 'gated', g: GATE }) }
                    : { partitions: 4, description: JSON.stringify({ a: 'pombo', ln: `${BASE}-1` }) }
            }
            return { partitions: 1, description: JSON.stringify({ a: 'pombo', t: 'public' }) }
        })
        gateReader.getInfo.mockResolvedValue(gate())
        gateReader.isModerator.mockResolvedValue(false)
        gateReader.checkAccess.mockResolvedValue(false)
        // Non-gated streams: public by default (served without a signature).
        client.hasPermission.mockImplementation(async (query: any) => query.public === true)
        gates = new PomboGates(client, gateReader)
    })

    afterEach(() => {
        gates.destroy()
    })

    it('does nothing while disabled', async () => {
        await read(createApp(false), `${BASE}-1`, { count: '5' }).expect(200)
        expect(client.getStreamMetadata).not.toHaveBeenCalled()
    })

    it('serves streams outside gated channels without a signature', async () => {
        await read(createApp(true), '0x1234567890123456789012345678901234567890/public-1', { count: '5' }).expect(200)
    })

    it('serves the admin stream of a gated channel without a signature', async () => {
        await read(createApp(true), `${BASE}-3`, { count: '5' }).expect(200)
        expect(client.getStreamMetadata).not.toHaveBeenCalled()
    })

    it('refuses an unsigned read of a gated stream', async () => {
        await read(createApp(true), `${BASE}-1`, { count: '5' }).expect(401)
        await read(createApp(true), `${BASE}-4`, { count: '5' }).expect(401)
    })

    it('refuses a signature over a different query', async () => {
        gateReader.checkAccess.mockResolvedValue(true)
        const app = createApp(true)
        const issuedAt = Date.now()
        const nonce = `nonce-${Math.random()}`
        const message = createSignedRequestMessage('read', `${BASE}-1`, 0, issuedAt, nonce, ['last', canonicalQuery({ count: '1' })])
        await read(app, `${BASE}-1`, { count: '500' })
            .set(SIGNED_READ_HEADERS.user, user)
            .set(SIGNED_READ_HEADERS.issuedAt, String(issuedAt))
            .set(SIGNED_READ_HEADERS.nonce, nonce)
            .set(SIGNED_READ_HEADERS.signature, await wallet.signMessage(message))
            .expect(401)
    })

    it('serves a member the gate accepts', async () => {
        gateReader.checkAccess.mockImplementation(async (_gate, u) => u === user)
        await signedRead(createApp(true), `${BASE}-1`, { count: '5', format: 'raw' }, 200)
    })

    it('serves the owner', async () => {
        gateReader.getInfo.mockResolvedValue(gate({ owner: user }))
        await signedRead(createApp(true), `${BASE}-1`, { count: '5' }, 200)
    })

    it('serves a moderator, on the secondary streams too', async () => {
        gateReader.isModerator.mockImplementation(async (_gate, u) => u === user)
        await signedRead(createApp(true), `${BASE}-5`, { count: '5' }, 200)
    })

    it('refuses a signer without access', async () => {
        await signedRead(createApp(true), `${BASE}-1`, { count: '5' }, 403)
    })

    it('refuses a signature by someone else than the claimed user', async () => {
        gateReader.checkAccess.mockResolvedValue(true)
        await signedRead(createApp(true), `${BASE}-1`, { count: '5' }, 401, Wallet.createRandom(), user)
    })

    it('refuses reads while the chain cannot be consulted', async () => {
        gateReader.checkAccess.mockRejectedValue(new Error('RPC unavailable'))
        await signedRead(createApp(true), `${BASE}-1`, { count: '5' }, 503)
    })

    describe('non-gated private streams (e.g. a DM inbox)', () => {
        const DM = '0x1234567890123456789012345678901234567890/Pombo-DM-1'

        it('refuses an unsigned read', async () => {
            client.hasPermission.mockResolvedValue(false)
            await read(createApp(true), DM, { count: '5' }).expect(401)
        })

        it('refuses a signer without SUBSCRIBE', async () => {
            client.hasPermission.mockResolvedValue(false)
            await signedRead(createApp(true), DM, { count: '5' }, 403)
        })

        it('serves a SUBSCRIBE holder', async () => {
            client.hasPermission.mockImplementation(async (query: any) => (query.public !== true) && (query.userId === user))
            await signedRead(createApp(true), DM, { count: '5' }, 200)
        })

        it('refuses reads while the chain cannot be consulted', async () => {
            client.hasPermission.mockRejectedValue(new Error('RPC unavailable'))
            await signedRead(createApp(true), DM, { count: '5' }, 503)
        })
    })

    it('canonicalises the query string by parameter name', () => {
        expect(canonicalQuery({ toTimestamp: '2', fromTimestamp: '1', format: 'raw' })).toBe('format=raw&fromTimestamp=1&toTimestamp=2')
        expect(canonicalQuery({})).toBe('')
    })
})
