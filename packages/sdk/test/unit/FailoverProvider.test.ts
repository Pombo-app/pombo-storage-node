import { wait } from '@streamr/utils'
import {
    AbstractProvider,
    FallbackProvider,
    Network,
    type PerformActionRequest,
    isError,
    makeError
} from 'ethers'
import { FailoverProvider, isProviderFailure } from '../../src/FailoverProvider'

const CHAIN_ID = 137
const ATTEMPT_TIMEOUT = 50
const CALL_TIMEOUT = 300
const BLOCK_NUMBER = { method: 'getBlockNumber' } as PerformActionRequest

interface Deferred {
    promise: Promise<unknown>
    resolve: (value: unknown) => void
    reject: (err: unknown) => void
}

const deferred = (): Deferred => {
    let resolve!: (value: unknown) => void
    let reject!: (err: unknown) => void
    const promise = new Promise<unknown>((_resolve, _reject) => {
        resolve = _resolve
        reject = _reject
    })
    return { promise, resolve, reject }
}

const serverError = (status: number) => makeError(`server response ${status}`, 'SERVER_ERROR', { request: 'test' })
const timeoutError = () => makeError('timeout', 'TIMEOUT', { operation: 'test', reason: 'timeout' })
const networkError = () => makeError('network error', 'NETWORK_ERROR', { event: 'test' })
const unknownError = () => makeError('upstream overloaded', 'UNKNOWN_ERROR', {})
const revert = () => makeError('execution reverted', 'CALL_EXCEPTION', {
    action: 'call',
    data: null,
    reason: null,
    transaction: { to: null, data: '0x' },
    invocation: null,
    revert: null
})

class FakeProvider extends AbstractProvider {

    calls = 0
    private readonly respond: (req: PerformActionRequest) => Promise<unknown>

    constructor(respond: (req: PerformActionRequest) => Promise<unknown>) {
        super(CHAIN_ID, { cacheTimeout: -1 })
        this.respond = respond
    }

    // eslint-disable-next-line class-methods-use-this
    override async _detectNetwork(): Promise<Network> {
        return Network.from(CHAIN_ID)
    }

    override async _perform<T = any>(req: PerformActionRequest): Promise<T> {
        if (req.method === 'chainId') {
            return BigInt(CHAIN_ID) as T
        }
        this.calls++
        return await this.respond(req) as T
    }
}

const answers = (value: unknown, delay = 0) => new FakeProvider(async () => {
    await wait(delay)
    return value
})
const fails = (err: () => Error, delay = 0) => new FakeProvider(async () => {
    await wait(delay)
    throw err()
})
const hangs = (pending: Deferred) => new FakeProvider(() => pending.promise)

const createProvider = (providers: AbstractProvider[], quorum = 1) => {
    return new FailoverProvider(providers, CHAIN_ID, { quorum, cacheTimeout: -1 }, {
        attemptTimeout: ATTEMPT_TIMEOUT,
        callTimeout: CALL_TIMEOUT
    })
}

// eslint-disable-next-line no-underscore-dangle
const perform = (provider: FailoverProvider, req = BLOCK_NUMBER) => provider._perform(req)

describe('FailoverProvider', () => {

    let hanging: Deferred[]
    let unhandled: unknown[]
    const onUnhandled = (reason: unknown) => unhandled.push(reason)

    const hang = () => {
        const pending = deferred()
        hanging.push(pending)
        return pending
    }

    beforeEach(() => {
        hanging = []
        unhandled = []
        process.on('unhandledRejection', onUnhandled)
        // Keeps the shuffle in list order, so each test decides who goes first
        jest.spyOn(Math, 'random').mockReturnValue(0.999999)
    })

    afterEach(async () => {
        hanging.forEach((pending) => pending.reject(serverError(504)))
        await wait(10)
        process.off('unhandledRejection', onUnhandled)
        jest.restoreAllMocks()
        expect(unhandled).toEqual([])
    })

    it.each([
        ['529', () => serverError(529)],
        ['429', () => serverError(429)],
        ['timeout', timeoutError],
        ['network error', networkError],
        ['JSON-RPC error', unknownError]
    ])('moves on to the next provider after a %s', async (_, err) => {
        const first = fails(err)
        const second = answers(42)
        expect(await perform(createProvider([first, second]))).toBe(42)
        expect(first.calls).toBe(1)
        expect(second.calls).toBe(1)
    })

    it('ends the call on an error that is an answer, without asking another provider', async () => {
        const first = fails(revert)
        const second = answers(42)
        const call = perform(createProvider([first, second]))
        await expect(call).rejects.toSatisfy((err: unknown) => isError(err, 'CALL_EXCEPTION'))
        await wait(ATTEMPT_TIMEOUT * 2)
        expect(second.calls).toBe(0)
    })

    it('asks the next provider when the first one hangs', async () => {
        const first = hangs(hang())
        const second = answers(42)
        const start = Date.now()
        expect(await perform(createProvider([first, second]))).toBe(42)
        expect(Date.now() - start).toBeGreaterThanOrEqual(ATTEMPT_TIMEOUT - 5)
        expect(Date.now() - start).toBeLessThan(CALL_TIMEOUT)
    })

    it('lets a slow first provider win when it answers before the second', async () => {
        const first = answers(1, ATTEMPT_TIMEOUT + 20)
        const second = answers(2, ATTEMPT_TIMEOUT * 3)
        expect(await perform(createProvider([first, second]))).toBe(1)
        expect(second.calls).toBe(1)
    })

    it('keeps waiting for a slow provider when the next one fails', async () => {
        const slow = deferred()
        hanging.push(slow)
        const first = hangs(slow)
        const second = fails(() => serverError(529))
        const call = perform(createProvider([first, second]))
        await wait(ATTEMPT_TIMEOUT * 2)
        expect(second.calls).toBe(1)
        slow.resolve(7)
        expect(await call).toBe(7)
    })

    it('asks each provider once and rejects with the last failure when all fail', async () => {
        const providers = [fails(() => serverError(529)), fails(timeoutError), fails(() => serverError(503))]
        const call = perform(createProvider(providers))
        await expect(call).rejects.toSatisfy((err: unknown) => isError(err, 'SERVER_ERROR') && err.message.includes('503'))
        expect(providers.map((p) => p.calls)).toEqual([1, 1, 1])
    })

    it('fails the call after callTimeout and ignores later answers', async () => {
        const pending = [hang(), hang()]
        const providers = pending.map((p) => hangs(p))
        const start = Date.now()
        const call = perform(createProvider(providers))
        await expect(call).rejects.toSatisfy((err: unknown) => isProviderFailure(err))
        expect(Date.now() - start).toBeGreaterThanOrEqual(CALL_TIMEOUT - 5)
        pending[0].resolve(1)
        pending[1].reject(serverError(529))
        await wait(10)
        expect(providers.map((p) => p.calls)).toEqual([1, 1])
    })

    it('fails over a contract call from a provider that only serves block numbers', async () => {
        const blockNumbersOnly = new FakeProvider(async (req) => {
            if (req.method === 'getBlockNumber') {
                return 94998911
            }
            throw serverError(529)
        })
        const provider = createProvider([blockNumbersOnly, answers('0x2a')])
        expect(await provider.getBlockNumber()).toBe(94998911)
        expect(await provider.call({ to: '0x0000000000000000000000000000000000000001', data: '0x' })).toBe('0x2a')
    })

    it('leaves quorum above 1 and broadcasts to FallbackProvider', async () => {
        const superPerform = jest.spyOn(FallbackProvider.prototype, '_perform').mockResolvedValue('from super')
        const first = answers(42)
        expect(await perform(createProvider([first, answers(42)], 2))).toBe('from super')
        const broadcast = { method: 'broadcastTransaction', signedTransaction: '0x00' } as PerformActionRequest
        expect(await perform(createProvider([first, answers(42)]), broadcast)).toBe('from super')
        expect(superPerform).toHaveBeenCalledTimes(2)
        expect(first.calls).toBe(0)
    })
})
