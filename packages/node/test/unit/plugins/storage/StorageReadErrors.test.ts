import { ContentType, EncryptionType, MessageID, SignatureType, StreamMessage, convertStreamMessageToBytes } from '@streamr/sdk'
import { randomUserId } from '@streamr/test-utils'
import { MetricsContext, hexToBinary, toStreamID, until, utf8ToBinary, wait } from '@streamr/utils'
import { Client } from 'cassandra-driver'
import express from 'express'
import http from 'http'
import { AddressInfo } from 'net'
import { Storage } from '../../../../src/plugins/storage/Storage'
import { createDataQueryEndpoint } from '../../../../src/plugins/storage/dataQueryEndpoint'

interface PendingQuery {
    options: { fetchSize?: number }
    onRow: (n: number, row: unknown) => void
    onEnd: (err?: Error) => void
}

const BUCKET_ROW = { id: 'bucket-1', records: 10, size: 100, date_create: new Date(0) }

const STORED_ROW = {
    payload: Buffer.from(convertStreamMessageToBytes(new StreamMessage({
        messageId: new MessageID(toStreamID('s1'), 0, 1, 0, randomUserId(), 'msgChainId'),
        content: utf8ToBinary(JSON.stringify({ foo: 'bar' })),
        signature: hexToBinary('0x1234'),
        contentType: ContentType.JSON,
        encryptionType: EncryptionType.NONE,
        signatureType: SignatureType.ECDSA_SECP256K1_EVM
    }))),
    stored_at: new Date(1)
}

const serverTimeout = () => new Error('Server timeout during read query at consistency LOCAL_ONE (0 replica(s) responded over 1 required)')

// The driver finishes a request from a socket callback, outside of any promise chain
const fromDriver = (fn: () => void) => setImmediate(fn)

const createFakeClient = () => {
    const queries: PendingQuery[] = []
    const client = {
        execute: async (query: string) => (query.startsWith('SELECT * FROM bucket') ? { rows: [BUCKET_ROW] } : { rows: [] }),
        eachRow: (
            _query: string,
            _params: unknown[],
            options: PendingQuery['options'],
            onRow: PendingQuery['onRow'],
            onEnd: PendingQuery['onEnd']
        ) => {
            queries.push({ options, onRow, onEnd })
        },
        shutdown: async () => {}
    }
    // The real stream() of the driver: it is the one that emits the page errors
    const stream = Client.prototype.stream.bind(client)
    return { client: { ...client, stream } as unknown as Client, queries }
}

describe('Storage range read paging', () => {

    const firstPageSize = async (fetchSize?: number): Promise<number | undefined> => {
        const { client, queries } = createFakeClient()
        const storage = new Storage(client, { fetchSize })
        const stream = storage.requestFrom('s1', 0, 1, 0)
        await until(() => queries.length === 1)
        stream.destroy()
        storage.bucketManager.stop()
        return queries[0].options.fetchSize
    }

    it('reads 32 rows per page by default', async () => {
        expect(await firstPageSize()).toBe(32)
    })

    it('reads the configured number of rows per page', async () => {
        expect(await firstPageSize(8)).toBe(8)
    })
})

describe('Storage range reads when Cassandra fails', () => {

    let storage: Storage
    let queries: PendingQuery[]
    let server: http.Server
    let port: number

    const openRequest = (query: string): { request: http.ClientRequest, response: Promise<http.IncomingMessage> } => {
        const request = http.get(`http://127.0.0.1:${port}/streams/s1/data/partitions/0/range?${query}`)
        request.on('error', () => {})
        const response = new Promise<http.IncomingMessage>((resolve) => request.on('response', (res) => {
            res.on('data', () => {})
            res.on('error', () => {})
            resolve(res)
        }))
        return { request, response }
    }

    beforeEach(async () => {
        const fake = createFakeClient()
        queries = fake.queries
        storage = new Storage(fake.client, {})
        const endpoint = createDataQueryEndpoint(storage, new MetricsContext())
        const app = express()
        app.route(endpoint.path)[endpoint.method](endpoint.requestHandlers)
        server = app.listen(0)
        await until(() => server.listening)
        port = (server.address() as AddressInfo).port
    })

    afterEach(async () => {
        server.closeAllConnections()
        server.close()
        storage.bucketManager.stop()
    })

    it('responds 500 when a page fails while the client waits', async () => {
        const { response } = openRequest('fromTimestamp=1&toTimestamp=2')
        await until(() => queries.length === 1)
        fromDriver(() => queries[0].onEnd(serverTimeout()))
        expect((await response).statusCode).toBe(500)
    })

    it('survives a page that fails after the client closed the request', async () => {
        const { request } = openRequest('fromTimestamp=1&toTimestamp=2')
        await until(() => queries.length === 1)
        request.destroy()
        await wait(100)
        fromDriver(() => queries[0].onEnd(serverTimeout()))
        await wait(100)
    })

    it('survives a page that fails after the client closed a response in progress', async () => {
        const { request, response } = openRequest('fromTimestamp=1&toTimestamp=2')
        await until(() => queries.length === 1)
        fromDriver(() => queries[0].onRow(0, STORED_ROW))
        expect((await response).statusCode).toBe(200)
        request.destroy()
        await wait(100)
        fromDriver(() => queries[0].onEnd(serverTimeout()))
        await wait(100)
    })

    it('fails the response when a later query of a sequence number range fails first', async () => {
        const { response } = openRequest('fromTimestamp=1&toTimestamp=2&fromSequenceNumber=1')
        await until(() => queries.length === 3)
        fromDriver(() => queries[1].onEnd(serverTimeout()))
        expect((await response).statusCode).toBe(500)
    })

    it('survives the remaining queries of a range failing after the first one', async () => {
        const { response } = openRequest('fromTimestamp=1&toTimestamp=2&fromSequenceNumber=1')
        await until(() => queries.length === 3)
        fromDriver(() => queries[0].onEnd(serverTimeout()))
        expect((await response).statusCode).toBe(500)
        fromDriver(() => queries[1].onEnd(new Error('Socket was closed')))
        fromDriver(() => queries[2].onEnd(new Error('Socket was closed')))
        await wait(100)
    })
})
