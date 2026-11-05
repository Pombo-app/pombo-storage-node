import { StreamrClient, convertBytesToStreamMessage } from '@streamr/sdk'
import { EthereumAddress, Logger } from '@streamr/utils'
import express, { Request, RequestHandler, Response } from 'express'
import { HttpServerEndpoint } from '../../Plugin'
import { PomboGates } from './PomboGates'
import { SignedRequestError, SignedRequestVerifier } from './SignedRequest'
import { Storage } from './Storage'
import { StoredRow } from './StoredMessage'
import { PurgeTarget, targetToLine } from './purgeEndpoint'

const logger = new Logger('storedEndpoint')

const MAX_TARGETS = 100

export type StoredResult = 'present' | 'absent'

const isTarget = (value: any): value is PurgeTarget => {
    return Number.isInteger(value?.timestamp) && Number.isInteger(value?.sequenceNumber) && (value.sequenceNumber >= 0)
}

const signedBy = (client: StreamrClient, rows: StoredRow[], signer: EthereumAddress): boolean => {
    return (rows.length > 0) && rows.every((row) => {
        try {
            return client.getMessageSigner(convertBytesToStreamMessage(row.payload)) === signer
        } catch {
            return false
        }
    })
}

/**
 * Answers whether specific messages are stored on this node, without returning
 * their content or metadata. Used by a DM file sender to verify its uploaded
 * chunks landed, when it cannot read the recipient's inbox (it holds no
 * SUBSCRIBE there). To never become an existence oracle it reports `present`
 * only for a row that both exists AND the signer is entitled to know about:
 * a reader of the stream (public, SUBSCRIBE holder, or the gate's owner /
 * moderator / member) sees present/absent for anything, anyone else only for
 * the rows they signed themselves; everything else is `absent`.
 */
const createHandler = (storage: Storage, gates: PomboGates, client: StreamrClient, verifier: SignedRequestVerifier): RequestHandler => {
    return async (req: Request, res: Response) => {
        const streamId = req.params.id
        const partition = parseInt(req.params.partition)
        if (Number.isNaN(partition)) {
            res.status(400).json({ error: `Path parameter "partition" not a number: ${req.params.partition}` })
            return
        }
        const targets = req.body?.targets
        if (!Array.isArray(targets) || (targets.length === 0) || (targets.length > MAX_TARGETS) || !targets.every(isTarget)) {
            res.status(400).json({ error: `Body must carry 1-${MAX_TARGETS} targets of {timestamp, sequenceNumber}` })
            return
        }
        let signer: EthereumAddress
        try {
            signer = verifier.verify(req.body, 'stored', streamId, partition, targets.map(targetToLine))
        } catch (err) {
            if (err instanceof SignedRequestError) {
                res.status(401).json({ error: err.message })
                return
            }
            throw err
        }
        let canRead: boolean
        try {
            canRead = await gates.canRead(streamId, signer)
        } catch (err) {
            if (!gates.wasLastSeenPublic(streamId)) {
                logger.warn('Could not verify access, refusing', { streamId, signer, err })
                res.status(503).json({ error: 'Cannot verify access right now' })
                return
            }
            logger.warn('Could not verify access, answering for a stream last seen as public', { streamId, err })
            canRead = true
        }
        const keys = await storage.getRowKeys(streamId, partition, targets.map((target) => target.timestamp))
        const results: (PurgeTarget & { result: StoredResult })[] = []
        for (const target of targets) {
            const publishers = keys
                .filter((key) => (key.timestamp === target.timestamp) && (key.sequenceNo === target.sequenceNumber))
                .map((key) => key.publisherId.toLowerCase())
            let present = false
            if (publishers.length > 0) {
                // Ingest verifies an EOA signature against publisher_id before storing the row.
                if (canRead || publishers.every((publisher) => publisher === signer.toLowerCase())) {
                    present = true
                } else {
                    const rows = await storage.getMessages(streamId, partition, target.timestamp, target.sequenceNumber)
                    present = signedBy(client, rows, signer)
                }
            }
            results.push({ ...target, result: present ? 'present' : 'absent' })
        }
        logger.info('Stored check', { streamId, partition, signer, canRead, targets: targets.length })
        res.status(200).json({ results })
    }
}

export const createStoredEndpoint = (
    storage: Storage,
    gates: PomboGates,
    client: StreamrClient,
    verifier: SignedRequestVerifier
): HttpServerEndpoint => {
    return {
        path: '/streams/:id/data/partitions/:partition/stored',
        method: 'post',
        requestHandlers: [express.json({ limit: '64kb' }), createHandler(storage, gates, client, verifier)]
    }
}
