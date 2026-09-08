import { EthereumAddress, MapWithTtl, toEthereumAddress } from '@streamr/utils'
import { verifyMessage } from 'ethers'

export const MAX_CLOCK_SKEW = 5 * 60 * 1000

export interface SignedRequestEnvelope {
    /** Address that claims to have signed the request */
    user: string
    /** Client clock at signing time (ms since epoch) */
    issuedAt: number
    /** Random string, unique per request */
    nonce: string
    /** EIP-191 personal signature over the canonical message */
    signature: string
}

export class SignedRequestError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'SignedRequestError'
    }
}

/**
 * The message a client signs (EIP-191 personal_sign) to authenticate a
 * request to this node. Every line is a field the server recomputes from
 * the request it received, so a signature only ever covers exactly one
 * request. `payloadLines` carry the request-specific fields, e.g. the
 * messages a purge targets.
 */
export const createSignedRequestMessage = (
    purpose: string,
    streamId: string,
    partition: number,
    issuedAt: number,
    nonce: string,
    payloadLines: string[]
): string => {
    return ['pombo-storage-node', purpose, streamId, String(partition), String(issuedAt), nonce, ...payloadLines].join('\n')
}

const isEnvelope = (value: any): value is SignedRequestEnvelope => {
    return (typeof value?.user === 'string')
        && (typeof value.issuedAt === 'number')
        && (typeof value.nonce === 'string') && (value.nonce.length >= 8) && (value.nonce.length <= 128)
        && (typeof value.signature === 'string')
}

/**
 * Verifies signed requests: the signature must recover the claimed user,
 * the request must be recent, and a nonce is accepted once.
 */
export class SignedRequestVerifier {

    private readonly seenNonces = new MapWithTtl<string, true>(() => 2 * MAX_CLOCK_SKEW)
    private readonly now: () => number

    constructor(now: () => number = Date.now) {
        this.now = now
    }

    verify(
        envelope: unknown,
        purpose: string,
        streamId: string,
        partition: number,
        payloadLines: string[]
    ): EthereumAddress {
        if (!isEnvelope(envelope)) {
            throw new SignedRequestError('Request must carry user, issuedAt, nonce and signature')
        }
        if (Math.abs(this.now() - envelope.issuedAt) > MAX_CLOCK_SKEW) {
            throw new SignedRequestError('Request is too old or too far in the future')
        }
        let user: EthereumAddress
        let signer: EthereumAddress
        try {
            user = toEthereumAddress(envelope.user)
            const message = createSignedRequestMessage(purpose, streamId, partition, envelope.issuedAt, envelope.nonce, payloadLines)
            signer = toEthereumAddress(verifyMessage(message, envelope.signature))
        } catch {
            throw new SignedRequestError('Invalid signature')
        }
        if (signer !== user) {
            throw new SignedRequestError('Signature does not belong to the claimed user')
        }
        const nonceKey = `${user}_${envelope.nonce}`
        if (this.seenNonces.has(nonceKey)) {
            throw new SignedRequestError('Nonce already used')
        }
        this.seenNonces.set(nonceKey, true)
        return user
    }

    destroy(): void {
        this.seenNonces.clear()
    }
}
