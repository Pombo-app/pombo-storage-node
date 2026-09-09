/* eslint-disable class-methods-use-this */
import { StreamrClient } from '@streamr/sdk'
import { mock } from 'jest-mock-extended'
import { RetentionConfig, RetentionScheduler } from '../../../../src/plugins/storage/RetentionScheduler'

const DAY_MS = 24 * 60 * 60 * 1000

const CONFIG: RetentionConfig = {
    enabled: true,
    intervalHours: 6,
    graceDays: 7,
    abortFractionPercent: 30,
    bucketDeleteLimit: 100000,
    rowDeleteLimit: 200000
}

// A stand-in Cassandra client: DISTINCT lists the stream parts, per-stream
// queries return that stream's buckets, MAX(ts) returns each bucket's newest
// message, and batch records the deletes.
class FakeCassandra {
    batches: any[][] = []
    private readonly buckets: { streamId: string, partition: number, id: string, newest: number, dateCreate: Date }[]
    constructor(buckets: { streamId: string, partition: number, id: string, newest: number, dateCreate: Date }[]) {
        this.buckets = buckets
    }
    async execute(query: string, params: any[] = [], _opts?: any): Promise<{ rows: any[] }> {
        if (query.includes('SELECT DISTINCT stream_id, partition FROM bucket')) {
            const seen = new Set<string>()
            const rows: any[] = []
            for (const b of this.buckets) {
                const key = `${b.streamId}-${b.partition}`
                if (!seen.has(key)) {
                    seen.add(key)
                    rows.push({ stream_id: b.streamId, partition: b.partition })
                }
            }
            return { rows }
        }
        if (query.includes('SELECT id, date_create FROM bucket')) {
            const [streamId, partition] = params
            const matching = this.buckets.filter((b) => b.streamId === streamId && b.partition === partition)
            return { rows: matching.map((b) => ({ id: b.id, date_create: b.dateCreate })) }
        }
        if (query.includes('SELECT MAX(ts) AS m FROM stream_data')) {
            const bucketId = params[2]
            const bucket = this.buckets.find((b) => b.id === bucketId)
            return { rows: [{ m: bucket ? new Date(bucket.newest) : null }] }
        }
        return { rows: [] }
    }
    async batch(queries: any[], _opts?: any): Promise<void> {
        this.batches.push(queries)
    }
    async shutdown(): Promise<void> {}
}

const streamError = (code: string): Error => Object.assign(new Error(code), { code })

describe('RetentionScheduler orphan sweep', () => {

    let client: ReturnType<typeof mock<StreamrClient>>
    let scheduler: RetentionScheduler

    const setChainState = (state: Record<string, 'exists' | 'deleted' | 'error'>) => {
        client.getStream.mockImplementation(async (streamId: string) => {
            const s = state[streamId] ?? 'exists'
            if (s === 'deleted') {
                throw streamError('STREAM_NOT_FOUND')
            }
            if (s === 'error') {
                throw streamError('RPC_TIMEOUT')
            }
            return {} as any
        })
    }

    const run = async (buckets: { streamId: string, partition: number, id: string, newest: number, dateCreate?: Date }[]) => {
        const cassandra = new FakeCassandra(buckets.map((b) => ({ ...b, dateCreate: b.dateCreate ?? new Date(b.newest) })))
        await (scheduler as any).orphanSweep(cassandra)
        return cassandra
    }

    beforeEach(() => {
        client = mock<StreamrClient>()
        scheduler = new RetentionScheduler(client, { hosts: ['h'], username: '', password: '', keyspace: 'k', datacenter: 'd' }, CONFIG, 8002)
    })

    it('deletes nothing when every stream still exists', async () => {
        setChainState({ a: 'exists', b: 'exists' })
        const c = await run([
            { streamId: 'a', partition: 0, id: 'b1', newest: Date.now() - 100 * DAY_MS },
            { streamId: 'b', partition: 0, id: 'b2', newest: Date.now() - 100 * DAY_MS }
        ])
        expect(c.batches).toHaveLength(0)
    })

    it('deletes the buckets of a stream deleted on-chain and past the grace period', async () => {
        // 1 deleted of 4 = 25% < 30%, so the fraction valve does not fire
        setChainState({ a: 'exists', b: 'exists', c: 'exists', gone: 'deleted' })
        const c = await run([
            { streamId: 'a', partition: 0, id: 'b1', newest: Date.now() },
            { streamId: 'b', partition: 0, id: 'b3', newest: Date.now() },
            { streamId: 'c', partition: 0, id: 'b4', newest: Date.now() },
            { streamId: 'gone', partition: 0, id: 'b2', newest: Date.now() - 30 * DAY_MS }
        ])
        expect(c.batches).toHaveLength(1)
        expect(JSON.stringify(c.batches[0])).toContain('b2')
    })

    it('holds a deleted stream still within the grace period', async () => {
        setChainState({ a: 'exists', b: 'exists', c: 'exists', gone: 'deleted' })
        const c = await run([
            { streamId: 'a', partition: 0, id: 'b1', newest: Date.now() },
            { streamId: 'b', partition: 0, id: 'b3', newest: Date.now() },
            { streamId: 'c', partition: 0, id: 'b4', newest: Date.now() },
            { streamId: 'gone', partition: 0, id: 'b2', newest: Date.now() - 1 * DAY_MS }
        ])
        expect(c.batches).toHaveLength(0)
    })

    it('aborts the whole phase if any stream errors for a reason other than not-found', async () => {
        setChainState({ a: 'error', gone: 'deleted' })
        const c = await run([
            { streamId: 'a', partition: 0, id: 'b1', newest: Date.now() - 100 * DAY_MS },
            { streamId: 'gone', partition: 0, id: 'b2', newest: Date.now() - 100 * DAY_MS }
        ])
        expect(c.batches).toHaveLength(0)
    })

    it('aborts if a suspiciously large fraction of streams look deleted', async () => {
        // 2 of 3 deleted = 66% > 30%
        setChainState({ a: 'exists', b: 'deleted', c: 'deleted' })
        const cassandra = await run([
            { streamId: 'a', partition: 0, id: 'b1', newest: Date.now() - 100 * DAY_MS },
            { streamId: 'b', partition: 0, id: 'b2', newest: Date.now() - 100 * DAY_MS },
            { streamId: 'c', partition: 0, id: 'b3', newest: Date.now() - 100 * DAY_MS }
        ])
        expect(cassandra.batches).toHaveLength(0)
    })
})
