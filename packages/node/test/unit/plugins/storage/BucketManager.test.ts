import { until, wait } from '@streamr/utils'
import { Client } from 'cassandra-driver'
import { BucketManager } from '../../../../src/plugins/storage/BucketManager'

const clientTimeout = () => new Error('The host 10.10.0.2:9042 did not reply before timeout 12000 ms')

describe('BucketManager when Cassandra fails', () => {

    let bucketManager: BucketManager | undefined

    afterEach(() => {
        bucketManager?.stop()
    })

    it('keeps checking buckets after a failed query and then opens the bucket', async () => {
        let failing = true
        let calls = 0
        const client = {
            execute: async () => {
                calls++
                if (failing) {
                    throw clientTimeout()
                }
                return { rows: [] }
            }
        } as unknown as Client
        bucketManager = new BucketManager(client, { checkFullBucketsTimeout: 10 })
        const timestamp = Date.now()
        expect(bucketManager.getBucketId('s1', 0, timestamp)).toBeUndefined()
        await until(() => calls >= 2)
        failing = false
        await until(() => bucketManager!.getBucketId('s1', 0, timestamp) !== undefined)
    })

    it('stops checking after stop()', async () => {
        let calls = 0
        const client = {
            execute: async () => {
                calls++
                throw clientTimeout()
            }
        } as unknown as Client
        bucketManager = new BucketManager(client, { checkFullBucketsTimeout: 10 })
        bucketManager.getBucketId('s1', 0, Date.now())
        await until(() => calls >= 1)
        bucketManager.stop()
        await wait(30)
        const callsAfterStop = calls
        await wait(50)
        expect(calls).toBe(callsAfterStop)
    })
})
