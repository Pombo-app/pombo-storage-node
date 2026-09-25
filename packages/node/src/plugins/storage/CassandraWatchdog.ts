import { Logger } from '@streamr/utils'
import { Client, errors } from 'cassandra-driver'

const logger = new Logger('CassandraWatchdog')

export interface CassandraWatchdogOptions {
    checkIntervalMs: number
    maxUnreachableMs: number
    onUnreachable: () => void
}

/**
 * Gives up on a client that has had no usable Cassandra host for too long. The driver can end
 * up with a host it never reconnects to, and only a fresh client (a restart) gets out of it.
 * Only NoHostAvailableError counts: a timeout means a connection still exists.
 */
export class CassandraWatchdog {

    private readonly client: Client
    private readonly opts: CassandraWatchdogOptions
    private unreachableSince?: number
    private timeout?: NodeJS.Timeout
    private stopped = false

    constructor(client: Client, opts: CassandraWatchdogOptions) {
        this.client = client
        this.opts = opts
    }

    start(): void {
        this.stopped = false
        this.schedule()
    }

    stop(): void {
        this.stopped = true
        clearTimeout(this.timeout)
    }

    async check(): Promise<void> {
        try {
            await this.client.execute('SELECT release_version FROM system.local')
            if (this.unreachableSince !== undefined) {
                logger.info('Cassandra reachable again', { unreachableForMs: Date.now() - this.unreachableSince })
            }
            this.unreachableSince = undefined
        } catch (err) {
            if (!(err instanceof errors.NoHostAvailableError)) {
                this.unreachableSince = undefined
                return
            }
            const now = Date.now()
            this.unreachableSince ??= now
            const unreachableForMs = now - this.unreachableSince
            if (unreachableForMs >= this.opts.maxUnreachableMs) {
                logger.fatal('No usable Cassandra host, exiting so that the node restarts', { unreachableForMs, err })
                this.stop()
                this.opts.onUnreachable()
            } else {
                logger.warn('No usable Cassandra host', { unreachableForMs, err })
            }
        }
    }

    private schedule(): void {
        if (this.stopped) {
            return
        }
        this.timeout = setTimeout(() => this.checkAndSchedule(), this.opts.checkIntervalMs)
    }

    private async checkAndSchedule(): Promise<void> {
        await this.check()
        this.schedule()
    }
}
