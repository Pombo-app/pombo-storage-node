import { Logger } from '@streamr/utils'
import type { AbstractProvider } from 'ethers'

const logger = new Logger('ProviderHealth')

const FAILURES_TO_SET_ASIDE = 2
const FIRST_COOLDOWN = 30 * 1000
const MAX_COOLDOWN = 5 * 60 * 1000

interface State {
    label: string
    failures: number
    cooldown: number
    asideUntil: number
}

const shuffle = <T>(items: readonly T[]): T[] => {
    const result = [...items]
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const swap = result[i]
        result[i] = result[j]
        result[j] = swap
    }
    return result
}

/**
 * Remembers which providers failed recently so that they are asked last. A provider set aside is
 * never excluded: when every provider is set aside, all of them are still asked.
 */
export class ProviderHealth {

    private readonly states = new Map<AbstractProvider, State>()
    private readonly now: () => number

    constructor(providers: readonly AbstractProvider[], labels?: readonly string[], now: () => number = Date.now) {
        providers.forEach((provider, i) => {
            this.states.set(provider, { label: labels?.[i] ?? `#${i}`, failures: 0, cooldown: 0, asideUntil: 0 })
        })
        this.now = now
    }

    /** Healthy providers first, in random order, then the ones set aside, soonest back first. */
    order(providers: readonly AbstractProvider[]): AbstractProvider[] {
        const now = this.now()
        const asideUntil = (provider: AbstractProvider) => this.states.get(provider)?.asideUntil ?? 0
        const healthy = providers.filter((provider) => asideUntil(provider) <= now)
        const aside = providers
            .filter((provider) => asideUntil(provider) > now)
            .sort((a, b) => asideUntil(a) - asideUntil(b))
        return [...shuffle(healthy), ...aside]
    }

    recordSuccess(provider: AbstractProvider): void {
        const state = this.states.get(provider)
        if (state === undefined || state.failures === 0) {
            return
        }
        if (state.cooldown > 0) {
            logger.info('RPC provider is back', { provider: state.label })
        }
        state.failures = 0
        state.cooldown = 0
        state.asideUntil = 0
    }

    recordFailure(provider: AbstractProvider): void {
        const state = this.states.get(provider)
        if (state === undefined) {
            return
        }
        const now = this.now()
        if (state.asideUntil > now) {
            return
        }
        state.failures++
        if (state.failures >= FAILURES_TO_SET_ASIDE) {
            state.cooldown = (state.cooldown === 0) ? FIRST_COOLDOWN : Math.min(state.cooldown * 2, MAX_COOLDOWN)
            state.asideUntil = now + state.cooldown
            logger.info('RPC provider set aside', { provider: state.label, failures: state.failures, cooldown: state.cooldown })
        }
    }
}
