import { StreamrClient } from '@streamr/sdk'
import { Logger } from '@streamr/utils'
import cassandra, { Client } from 'cassandra-driver'
import pLimit from 'p-limit'
import { DeleteExpiredCmd } from './DeleteExpiredCmd'

const logger = new Logger('RetentionScheduler')

const listStreamParts = async (client: Client): Promise<{ streamId: string, partition: number }[]> => {
    const rs = await client.execute('SELECT DISTINCT stream_id, partition FROM bucket', [], { fetchSize: 100000 })
    return rs.rows.map((r) => ({ streamId: r.stream_id, partition: r.partition }))
}

const DAY_MS = 24 * 60 * 60 * 1000
const CLASSIFY_CONCURRENCY = 5

export interface RetentionConfig {
    enabled: boolean
    intervalHours: number
    graceDays: number
    abortFractionPercent: number
    bucketDeleteLimit: number
    rowDeleteLimit: number
}

export interface RetentionCassandraConfig {
    hosts: string[]
    username: string
    password: string
    keyspace: string
    datacenter: string
}

type StreamState = { sid: string, state: 'exists' | 'deleted' } | { sid: string, state: 'error', code: string }

/**
 * Enforces retention inside the node, so it needs no external cron. Runs three
 * phases every `intervalHours`:
 *
 *   1. bucket retention: whole buckets whose newest message is past the
 *      stream's storageDays (the upstream DeleteExpiredCmd);
 *   2. row sweep: individual messages older than storageDays that are stuck in
 *      buckets which keep receiving writes, so phase 1 never closes them;
 *   3. orphan sweep: data of streams deleted on-chain, which phases 1 and 2
 *      skip because they resolve storageDays from the registry.
 *
 * The orphan sweep is destructive and depends on the chain, so it is guarded:
 * it deletes only when getStream reports STREAM_NOT_FOUND, aborts the phase if
 * any stream errors for another reason (unstable RPC) or if the fraction of
 * "deleted" streams looks suspicious, and holds a grace period before deleting.
 *
 * In a cluster the deletes replicate through Cassandra, so only one node should
 * run this; the plugin starts it on the node with index 0.
 */
export class RetentionScheduler {

    private readonly streamrClient: StreamrClient
    private readonly cassandraConfig: RetentionCassandraConfig
    private readonly config: RetentionConfig
    private readonly streamrBaseUrl: string
    private cassandraClient?: Client
    private timeout?: NodeJS.Timeout
    private running = false
    private stopped = false

    constructor(streamrClient: StreamrClient, cassandraConfig: RetentionCassandraConfig, config: RetentionConfig, httpPort: number) {
        this.streamrClient = streamrClient
        this.cassandraConfig = cassandraConfig
        this.config = config
        this.streamrBaseUrl = `http://127.0.0.1:${httpPort}`
    }

    start(): void {
        this.stopped = false
        // first run shortly after startup, then every interval
        this.schedule(60 * 1000)
    }

    stop(): void {
        this.stopped = true
        if (this.timeout !== undefined) {
            clearTimeout(this.timeout)
        }
    }

    private schedule(delay: number): void {
        this.timeout = setTimeout(() => {
            return this.runOnce()
                .catch((err) => logger.warn('Retention run failed', { err }))
                .finally(() => {
                    if (!this.stopped) {
                        this.schedule(this.config.intervalHours * 60 * 60 * 1000)
                    }
                })
        }, delay)
    }

    async runOnce(): Promise<void> {
        if (this.running) {
            logger.info('Previous retention run still in progress, skipping')
            return
        }
        this.running = true
        const client = this.getCassandraClient()
        try {
            logger.info('Retention: bucket retention')
            await this.bucketRetention()
            logger.info('Retention: row sweep')
            await this.rowSweep(client)
            logger.info('Retention: orphan sweep')
            await this.orphanSweep(client)
        } finally {
            this.running = false
        }
    }

    private getCassandraClient(): Client {
        this.cassandraClient ??= new cassandra.Client({
            contactPoints: [...this.cassandraConfig.hosts],
            localDataCenter: this.cassandraConfig.datacenter,
            keyspace: this.cassandraConfig.keyspace,
            authProvider: new cassandra.auth.PlainTextAuthProvider(this.cassandraConfig.username, this.cassandraConfig.password)
        })
        return this.cassandraClient
    }

    private async bucketRetention(): Promise<void> {
        const cmd = new DeleteExpiredCmd({
            streamrBaseUrl: this.streamrBaseUrl,
            cassandraUsername: this.cassandraConfig.username,
            cassandraPassword: this.cassandraConfig.password,
            cassandraHosts: this.cassandraConfig.hosts,
            cassandraDatacenter: this.cassandraConfig.datacenter,
            cassandraKeyspace: this.cassandraConfig.keyspace,
            bucketLimit: this.config.bucketDeleteLimit,
            dryRun: false
        })
        try {
            await cmd.run(this.streamrClient)
        } finally {
            await cmd.cassandraClient.shutdown()
        }
    }

    private async storageDaysOf(streamId: string): Promise<number | undefined> {
        try {
            const stream = await this.streamrClient.getStream(streamId)
            return (await stream.getStorageDayCount()) ?? 365
        } catch {
            return undefined
        }
    }

    private async rowSweep(client: Client): Promise<void> {
        const pairs = await listStreamParts(client)
        const streamIds = [...new Set(pairs.map((p) => p.streamId))]
        const storageDaysByStream = new Map<string, number>()
        const limit = pLimit(CLASSIFY_CONCURRENCY)
        await Promise.all(streamIds.map((sid) => limit(async () => {
            const days = await this.storageDaysOf(sid)
            if (days !== undefined) {
                storageDaysByStream.set(sid, days)
            }
        })))

        let rowsDeleted = 0
        for (const { streamId, partition } of pairs) {
            if (rowsDeleted >= this.config.rowDeleteLimit) {
                break
            }
            const storageDays = storageDaysByStream.get(streamId)
            if (storageDays === undefined) {
                continue
            }
            const cutoff = Date.now() - storageDays * DAY_MS
            const buckets = await client.execute(
                'SELECT id FROM bucket WHERE stream_id = ? AND partition = ? AND date_create <= ?',
                [streamId, partition, cutoff],
                { prepare: true }
            )
            for (const bucket of buckets.rows) {
                const countRs = await client.execute(
                    'SELECT COUNT(*) AS c FROM stream_data WHERE stream_id = ? AND partition = ? AND bucket_id = ? AND ts < ?',
                    [streamId, partition, bucket.id, cutoff],
                    { prepare: true }
                )
                const count = countRs.rows[0] ? Number(countRs.rows[0].c) : 0
                if (count === 0) {
                    continue
                }
                if (rowsDeleted + count > this.config.rowDeleteLimit) {
                    logger.info('Row sweep hit the per-run limit, stopping', { rowDeleteLimit: this.config.rowDeleteLimit })
                    return
                }
                rowsDeleted += count
                await client.execute(
                    'DELETE FROM stream_data WHERE stream_id = ? AND partition = ? AND bucket_id = ? AND ts < ?',
                    [streamId, partition, bucket.id, cutoff],
                    { prepare: true }
                )
            }
        }
        if (rowsDeleted > 0) {
            logger.info('Row sweep deleted stale messages', { rowsDeleted })
        }
    }

    private async classify(streamId: string): Promise<StreamState> {
        let code = 'UNKNOWN'
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await this.streamrClient.getStream(streamId)
                return { sid: streamId, state: 'exists' }
            } catch (err: any) {
                if (err?.code === 'STREAM_NOT_FOUND') {
                    return { sid: streamId, state: 'deleted' }
                }
                code = err?.code ?? 'UNKNOWN'
                await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
            }
        }
        return { sid: streamId, state: 'error', code }
    }

    private async orphanSweep(client: Client): Promise<void> {
        const pairs = await listStreamParts(client)
        const streamIds = [...new Set(pairs.map((p) => p.streamId))]
        const limit = pLimit(CLASSIFY_CONCURRENCY)
        const classified = await Promise.all(streamIds.map((sid) => limit(() => this.classify(sid))))

        const errors = classified.filter((c) => c.state === 'error')
        if (errors.length > 0) {
            logger.warn('Orphan sweep aborted: streams errored for a reason other than not-found (unstable RPC)', { errorCount: errors.length })
            return
        }
        const deleted = classified.filter((c) => c.state === 'deleted').map((c) => c.sid)
        const fraction = streamIds.length > 0 ? deleted.length / streamIds.length : 0
        if (fraction > this.config.abortFractionPercent / 100) {
            logger.warn('Orphan sweep aborted: suspiciously many streams look deleted', {
                deleted: deleted.length,
                total: streamIds.length,
                abortFractionPercent: this.config.abortFractionPercent
            })
            return
        }
        if (deleted.length === 0) {
            return
        }

        const deletedSet = new Set(deleted)
        const graceMs = this.config.graceDays * DAY_MS
        const now = Date.now()
        const candidates: { streamId: string, partition: number, bucketId: unknown, dateCreate: Date }[] = []
        for (const { streamId, partition } of pairs.filter((p) => deletedSet.has(p.streamId))) {
            const buckets = await client.execute(
                'SELECT id, date_create FROM bucket WHERE stream_id = ? AND partition = ?',
                [streamId, partition],
                { prepare: true }
            )
            for (const bucket of buckets.rows) {
                if (candidates.length >= this.config.bucketDeleteLimit) {
                    break
                }
                const maxRs = await client.execute(
                    'SELECT MAX(ts) AS m FROM stream_data WHERE stream_id = ? AND partition = ? AND bucket_id = ?',
                    [streamId, partition, bucket.id],
                    { prepare: true }
                )
                const maxTs = maxRs.rows[0]?.m
                const newest = maxTs ? new Date(maxTs).getTime() : (bucket.date_create ? new Date(bucket.date_create).getTime() : 0)
                if (now - newest >= graceMs) {
                    candidates.push({ streamId, partition, bucketId: bucket.id, dateCreate: bucket.date_create })
                }
            }
        }

        const DELETE_BUCKET = 'DELETE FROM bucket WHERE stream_id = ? AND partition = ? AND date_create = ?'
        const DELETE_DATA = 'DELETE FROM stream_data WHERE stream_id = ? AND partition = ? AND bucket_id = ?'
        for (const candidate of candidates) {
            await client.batch([
                { query: DELETE_BUCKET, params: [candidate.streamId, candidate.partition, candidate.dateCreate] },
                { query: DELETE_DATA, params: [candidate.streamId, candidate.partition, candidate.bucketId] }
            ], { prepare: true })
        }
        if (candidates.length > 0) {
            logger.info('Orphan sweep deleted buckets of on-chain-deleted streams', { buckets: candidates.length, streams: deleted.length })
        }
    }

    async destroy(): Promise<void> {
        this.stop()
        if (this.cassandraClient !== undefined) {
            await this.cassandraClient.shutdown()
            this.cassandraClient = undefined
        }
    }
}
