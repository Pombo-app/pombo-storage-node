import { Client, errors } from 'cassandra-driver'
import { CassandraWatchdog } from '../../../../src/plugins/storage/CassandraWatchdog'

const noHost = () => new errors.NoHostAvailableError({})
const timeout = () => new errors.OperationTimedOutError('The host did not reply before timeout 12000 ms')

describe('CassandraWatchdog', () => {

    let results: (Error | undefined)[]
    let onUnreachable: jest.Mock
    let watchdog: CassandraWatchdog

    const checkAt = async (secondsFromStart: number, result?: Error) => {
        jest.setSystemTime(secondsFromStart * 1000)
        results.push(result)
        await watchdog.check()
    }

    beforeEach(() => {
        jest.useFakeTimers()
        results = []
        onUnreachable = jest.fn()
        const client = {
            execute: async () => {
                const result = results.shift()
                if (result !== undefined) {
                    throw result
                }
                return { rows: [] }
            }
        } as unknown as Client
        watchdog = new CassandraWatchdog(client, { checkIntervalMs: 30000, maxUnreachableMs: 120000, onUnreachable })
    })

    afterEach(() => {
        watchdog.stop()
        jest.useRealTimers()
    })

    it('gives up once no host has been usable for the maximum time', async () => {
        await checkAt(0, noHost())
        await checkAt(60, noHost())
        expect(onUnreachable).not.toHaveBeenCalled()
        await checkAt(120, noHost())
        expect(onUnreachable).toHaveBeenCalledTimes(1)
    })

    it('does not count timeouts, which mean a connection still exists', async () => {
        await checkAt(0, noHost())
        await checkAt(60, timeout())
        await checkAt(150, noHost())
        expect(onUnreachable).not.toHaveBeenCalled()
    })

    it('starts counting again after a successful query', async () => {
        await checkAt(0, noHost())
        await checkAt(90)
        await checkAt(150, noHost())
        await checkAt(200, noHost())
        expect(onUnreachable).not.toHaveBeenCalled()
    })

    it('checks on its own interval once started', async () => {
        const check = jest.spyOn(watchdog, 'check')
        watchdog.start()
        await jest.advanceTimersByTimeAsync(95000)
        expect(check).toHaveBeenCalledTimes(3)
    })
})
