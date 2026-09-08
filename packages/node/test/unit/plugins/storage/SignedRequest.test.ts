import { toEthereumAddress } from '@streamr/utils'
import { BaseWallet, Wallet } from 'ethers'
import {
    MAX_CLOCK_SKEW,
    SignedRequestEnvelope,
    SignedRequestVerifier,
    createSignedRequestMessage
} from '../../../../src/plugins/storage/SignedRequest'

const STREAM_ID = '0x1234567890123456789012345678901234567890/foo-1'
const PARTITION = 0
const PURPOSE = 'purge'
const PAYLOAD = ['1700000000000:0', '1700000000001:2']

describe('SignedRequestVerifier', () => {

    const wallet = Wallet.createRandom()
    let now: number
    let verifier: SignedRequestVerifier

    const sign = async (overrides: Partial<SignedRequestEnvelope> = {}, signer: BaseWallet = wallet): Promise<SignedRequestEnvelope> => {
        const issuedAt = overrides.issuedAt ?? now
        const nonce = overrides.nonce ?? `nonce-${Math.random()}`
        const message = createSignedRequestMessage(PURPOSE, STREAM_ID, PARTITION, issuedAt, nonce, PAYLOAD)
        return {
            user: overrides.user ?? signer.address,
            issuedAt,
            nonce,
            signature: overrides.signature ?? await signer.signMessage(message)
        }
    }

    beforeEach(() => {
        now = 1700000000000
        verifier = new SignedRequestVerifier(() => now)
    })

    afterEach(() => {
        verifier.destroy()
    })

    it('accepts a request signed by the claimed user', async () => {
        const envelope = await sign()
        expect(verifier.verify(envelope, PURPOSE, STREAM_ID, PARTITION, PAYLOAD)).toBe(toEthereumAddress(wallet.address))
    })

    it('rejects a signature by someone else', async () => {
        const envelope = await sign({ user: wallet.address }, Wallet.createRandom())
        expect(() => verifier.verify(envelope, PURPOSE, STREAM_ID, PARTITION, PAYLOAD)).toThrow('does not belong')
    })

    it('rejects a signature over a different request', async () => {
        const envelope = await sign()
        expect(() => verifier.verify(envelope, PURPOSE, STREAM_ID, PARTITION, ['1700000000009:0'])).toThrow('does not belong')
        expect(() => verifier.verify(envelope, 'read', STREAM_ID, PARTITION, PAYLOAD)).toThrow('does not belong')
        expect(() => verifier.verify(envelope, PURPOSE, STREAM_ID, 1, PAYLOAD)).toThrow('does not belong')
    })

    it('rejects a garbled signature', async () => {
        const envelope = await sign({ signature: '0x1234' })
        expect(() => verifier.verify(envelope, PURPOSE, STREAM_ID, PARTITION, PAYLOAD)).toThrow('Invalid signature')
    })

    it('rejects a stale request', async () => {
        const envelope = await sign({ issuedAt: now - MAX_CLOCK_SKEW - 1 })
        expect(() => verifier.verify(envelope, PURPOSE, STREAM_ID, PARTITION, PAYLOAD)).toThrow('too old')
    })

    it('accepts a nonce once', async () => {
        const envelope = await sign()
        verifier.verify(envelope, PURPOSE, STREAM_ID, PARTITION, PAYLOAD)
        expect(() => verifier.verify(envelope, PURPOSE, STREAM_ID, PARTITION, PAYLOAD)).toThrow('Nonce already used')
    })

    it('rejects a malformed envelope', () => {
        expect(() => verifier.verify({ user: wallet.address }, PURPOSE, STREAM_ID, PARTITION, PAYLOAD)).toThrow('must carry')
        expect(() => verifier.verify(undefined, PURPOSE, STREAM_ID, PARTITION, PAYLOAD)).toThrow('must carry')
    })
})
