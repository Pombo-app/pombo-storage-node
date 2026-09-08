import { StreamPermission, StreamrClient, convertBytesToStreamMessage } from '@streamr/sdk'
import { EthereumAddress, Logger } from '@streamr/utils'
import express, { Request, RequestHandler, Response } from 'express'
import { HttpServerEndpoint } from '../../Plugin'
import { PomboGates } from './PomboGates'
import { SignedRequestError, SignedRequestVerifier } from './SignedRequest'
import { Storage } from './Storage'
import { StoredRow } from './StoredMessage'

const logger = new Logger('purgeEndpoint')

const MAX_TARGETS = 100

export interface PurgeTarget {
    timestamp: number
    sequenceNumber: number
}

export type PurgeResult = 'deleted' | 'forbidden' | 'not_found'

const isTarget = (value: any): value is PurgeTarget => {
    return Number.isInteger(value?.timestamp) && Number.isInteger(value?.sequenceNumber) && (value.sequenceNumber >= 0)
}

export const targetToLine = (target: PurgeTarget): string => `${target.timestamp}:${target.sequenceNumber}`

/**
 * Deletes specific messages from this node. The request is signed by the
 * account asking for the deletion; it is honoured when that account
 * - holds DELETE permission on the stream (the channel owner), or
 * - owns or moderates the Pombo gate of the channel, or
 * - signed the message itself, which the node checks against the stored
 *   envelope. On a Sealed channel every message is signed by the shared
 *   channel key, so that rule would let any member delete anything; there
 *   only the first two apply.
 *
 * Other storage nodes of the same channel keep their copy: this is
 * removal from this node, not from the network.
 */
export class PurgeAuthorizer {

    private readonly client: StreamrClient
    private readonly gates: PomboGates

    constructor(client: StreamrClient, gates: PomboGates) {
        this.client = client
        this.gates = gates
    }

    async createContext(streamId: string, signer: EthereumAddress): Promise<{ admin: boolean, authorRuleApplies: boolean }> {
        let admin = false
        try {
            admin = await this.client.hasPermission({ streamId, permission: StreamPermission.DELETE, userId: signer, allowPublic: false })
        } catch (err) {
            logger.warn('Could not read stream permissions', { streamId, signer, err })
        }
        let authorRuleApplies = true
        try {
            const gate = await this.gates.getGate(streamId)
            if (gate !== null) {
                authorRuleApplies = gate.visible
                if (!admin) {
                    admin = (signer === gate.owner) || await this.gates.isModerator(gate.address, signer)
                }
            }
        } catch (err) {
            logger.warn('Could not read gate', { streamId, signer, err })
            authorRuleApplies = false
        }
        return { admin, authorRuleApplies }
    }

    isAuthor(rows: StoredRow[], signer: EthereumAddress): boolean {
        return rows.every((row) => {
            try {
                return this.client.getMessageSigner(convertBytesToStreamMessage(row.payload)) === signer
            } catch {
                return false
            }
        })
    }
}

const createHandler = (storage: Storage, authorizer: PurgeAuthorizer, verifier: SignedRequestVerifier): RequestHandler => {
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
            signer = verifier.verify(req.body, 'purge', streamId, partition, targets.map(targetToLine))
        } catch (err) {
            if (err instanceof SignedRequestError) {
                res.status(401).json({ error: err.message })
                return
            }
            throw err
        }
        const context = await authorizer.createContext(streamId, signer)
        const results: (PurgeTarget & { result: PurgeResult })[] = []
        for (const target of targets) {
            const rows = await storage.getMessages(streamId, partition, target.timestamp, target.sequenceNumber)
            let result: PurgeResult
            if (rows.length === 0) {
                result = 'not_found'
            } else if (context.admin || (context.authorRuleApplies && authorizer.isAuthor(rows, signer))) {
                for (const row of rows) {
                    await storage.deleteMessage(streamId, partition, row)
                }
                result = 'deleted'
            } else {
                result = 'forbidden'
            }
            results.push({ ...target, result })
        }
        logger.info('Purge request', { streamId, partition, signer, admin: context.admin, results })
        res.status(200).json({ results })
    }
}

export const createPurgeEndpoint = (storage: Storage, authorizer: PurgeAuthorizer, verifier: SignedRequestVerifier): HttpServerEndpoint => {
    return {
        path: '/streams/:id/data/partitions/:partition/purge',
        method: 'post',
        requestHandlers: [express.json({ limit: '64kb' }), createHandler(storage, authorizer, verifier)]
    }
}
