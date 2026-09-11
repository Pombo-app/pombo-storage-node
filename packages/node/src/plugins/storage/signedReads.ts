import { EthereumAddress, Logger } from '@streamr/utils'
import { NextFunction, Request, RequestHandler, Response } from 'express'
import { PomboGates } from './PomboGates'
import { SignedRequestError, SignedRequestVerifier } from './SignedRequest'

const logger = new Logger('signedReads')

export const SIGNED_READ_HEADERS = {
    user: 'x-pombo-user',
    issuedAt: 'x-pombo-issued-at',
    nonce: 'x-pombo-nonce',
    signature: 'x-pombo-signature'
}

// The admin stream stays readable by anyone: channel previews, the channel
// image and the entry screen of non-members are served from it.
const OPEN_STREAM_SUFFIX = '-3'

/**
 * The query string as the client must sign it: parameters sorted by name,
 * `name=value`, joined with `&`, values unencoded. Repeated parameters are
 * listed in the order received.
 */
export const canonicalQuery = (query: Record<string, unknown>): string => {
    return Object.keys(query).sort().flatMap((key) => {
        const value = query[key]
        const values = Array.isArray(value) ? value : [value]
        return values.map((v) => `${key}=${String(v)}`)
    }).join('&')
}

const readEnvelope = (req: Request): unknown => {
    const user = req.header(SIGNED_READ_HEADERS.user)
    const issuedAt = req.header(SIGNED_READ_HEADERS.issuedAt)
    const nonce = req.header(SIGNED_READ_HEADERS.nonce)
    const signature = req.header(SIGNED_READ_HEADERS.signature)
    if (user === undefined || issuedAt === undefined || nonce === undefined || signature === undefined) {
        return undefined
    }
    return { user, issuedAt: Number(issuedAt), nonce, signature }
}

/**
 * Requires a signed request to read a gated channel (all but the admin stream)
 * or any non-public stream (e.g. a DM inbox). The signer must have access right
 * now: for a gated channel the gate owner, a moderator, or an account the gate
 * accepts; for a non-gated stream, SUBSCRIBE on it. A stream whose SUBSCRIBE is
 * public is served without a signature, as a vanilla node serves it. When the
 * chain cannot be consulted the read is refused: a read can be retried, a leak
 * cannot be undone.
 */
export const createSignedReadGuard = (
    enabled: boolean,
    gates: PomboGates,
    verifier: SignedRequestVerifier
): RequestHandler => {
    return async (req: Request, res: Response, next: NextFunction) => {
        if (!enabled) {
            next()
            return
        }
        const streamId = req.params.id
        const partition = parseInt(req.params.partition)
        if (Number.isNaN(partition) || streamId.endsWith(OPEN_STREAM_SUFFIX)) {
            next()
            return
        }
        let gate
        try {
            gate = await gates.getGate(streamId)
        } catch (err) {
            logger.warn('Could not read gate, refusing read', { streamId, err })
            res.status(503).json({ error: 'Cannot verify access right now' })
            return
        }
        // Pick the access rule. A gated channel: owner, moderator, or the gate's
        // access. A non-gated stream: open when SUBSCRIBE is public (as a vanilla
        // node serves it); otherwise it is private (e.g. a DM inbox), so require a
        // signed read by an account that holds SUBSCRIBE.
        let accessCheck: (user: EthereumAddress) => Promise<boolean>
        if (gate === null) {
            let isPublic: boolean
            try {
                isPublic = await gates.isPublicSubscribe(streamId)
            } catch (err) {
                logger.warn('Could not read permissions, refusing read', { streamId, err })
                res.status(503).json({ error: 'Cannot verify access right now' })
                return
            }
            if (isPublic) {
                next()
                return
            }
            accessCheck = (user) => gates.hasSubscribe(streamId, user)
        } else {
            const info = gate
            accessCheck = async (user) => (user === info.owner) || await gates.isModerator(info.address, user) || await gates.hasAccess(info.address, user)
        }
        let user: EthereumAddress
        try {
            const payloadLines = [req.params.resendType ?? '', canonicalQuery(req.query as Record<string, unknown>)]
            user = verifier.verify(readEnvelope(req), 'read', streamId, partition, payloadLines)
        } catch (err) {
            if (err instanceof SignedRequestError) {
                res.status(401).json({ error: err.message })
                return
            }
            throw err
        }
        let allowed: boolean
        try {
            allowed = await accessCheck(user)
        } catch (err) {
            logger.warn('Could not verify access, refusing read', { streamId, user, err })
            res.status(503).json({ error: 'Cannot verify access right now' })
            return
        }
        if (!allowed) {
            res.status(403).json({ error: 'No access to this stream' })
            return
        }
        next()
    }
}
