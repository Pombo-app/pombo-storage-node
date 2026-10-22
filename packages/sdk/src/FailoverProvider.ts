import {
    AbstractProvider,
    FallbackProvider,
    type FallbackProviderOptions,
    type Networkish,
    type PerformActionRequest,
    isError,
    makeError
} from 'ethers'
import { ProviderHealth } from './ProviderHealth'

const PROVIDER_FAILURES = ['SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR', 'UNKNOWN_ERROR'] as const

export const isProviderFailure = (err: unknown): boolean => {
    return PROVIDER_FAILURES.some((code) => isError(err, code))
}

const asError = (err: unknown): Error => (err instanceof Error) ? err : new Error(String(err))

export interface FailoverTimeouts {
    /** Without an answer by then, the next provider is asked too; the slow one may still win. */
    attemptTimeout: number
    /** The whole call fails after this, whatever is still pending. */
    callTimeout: number
}

/**
 * With quorum 1 the first answer from any provider wins: a transport failure or a slow provider
 * must not decide the call, but an error that is an answer (a revert) ends it.
 */
export class FailoverProvider extends FallbackProvider {

    private readonly providers: readonly AbstractProvider[]
    private readonly timeouts: FailoverTimeouts
    private readonly health: ProviderHealth

    constructor(
        providers: AbstractProvider[],
        network: Networkish,
        options: FallbackProviderOptions,
        timeouts: FailoverTimeouts,
        health: ProviderHealth = new ProviderHealth(providers)
    ) {
        super(providers, network, options)
        this.providers = providers
        this.timeouts = timeouts
        this.health = health
    }

    override async _perform<T = any>(req: PerformActionRequest): Promise<T> {
        if (this.quorum !== 1 || req.method === 'broadcastTransaction') {
            // eslint-disable-next-line no-underscore-dangle
            return super._perform(req)
        }
        return this.performWithFailover(req)
    }

    private performWithFailover<T>(req: PerformActionRequest): Promise<T> {
        const queue = this.health.order(this.providers)
        return new Promise<T>((resolve, reject) => {
            let pending = 0
            let settled = false
            let lastFailure: Error | undefined
            let attemptTimer: ReturnType<typeof setTimeout> | undefined
            const callTimer = setTimeout(() => {
                settle(() => reject(lastFailure ?? asError(makeError('RPC call timed out', 'TIMEOUT', { operation: req.method, reason: 'timeout' }))))
            }, this.timeouts.callTimeout)
            const settle = (action: () => void) => {
                if (settled) {
                    return
                }
                settled = true
                clearTimeout(callTimer)
                clearTimeout(attemptTimer)
                action()
            }
            const launchNext = () => {
                clearTimeout(attemptTimer)
                const provider = queue.shift()
                if (settled || provider === undefined) {
                    return
                }
                pending++
                attemptTimer = setTimeout(launchNext, this.timeouts.attemptTimeout)
                const judge = this.judgeAttempt(provider)
                // eslint-disable-next-line no-underscore-dangle
                this._translatePerform(provider, req).then(
                    (result) => {
                        judge(true)
                        settle(() => resolve(result))
                    },
                    (err: unknown) => {
                        pending--
                        const error = asError(err)
                        if (!isProviderFailure(error)) {
                            judge(true)
                            settle(() => reject(error))
                            return
                        }
                        judge(false)
                        lastFailure = error
                        if (queue.length > 0) {
                            launchNext()
                        } else if (pending === 0) {
                            settle(() => reject(error))
                        }
                    }
                )
            }
            launchNext()
        })
    }

    /** An answer that comes after attemptTimeout is not a success: by then the attempt counted as a failure. */
    private judgeAttempt(provider: AbstractProvider): (answered: boolean) => void {
        let judged = false
        const judge = (answered: boolean) => {
            if (judged) {
                return
            }
            judged = true
            clearTimeout(slowTimer)
            if (answered) {
                this.health.recordSuccess(provider)
            } else {
                this.health.recordFailure(provider)
            }
        }
        const slowTimer = setTimeout(() => judge(false), this.timeouts.attemptTimeout)
        return judge
    }
}
