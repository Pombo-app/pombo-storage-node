import { AbstractProvider } from 'ethers'
import { ProviderHealth } from '../../src/ProviderHealth'

const SECOND = 1000
const MINUTE = 60 * SECOND

describe('ProviderHealth', () => {

    let now: number
    let a: AbstractProvider
    let b: AbstractProvider
    let c: AbstractProvider
    let health: ProviderHealth

    const failTwice = (provider: AbstractProvider) => {
        health.recordFailure(provider)
        health.recordFailure(provider)
    }

    beforeEach(() => {
        now = 1000000
        a = new AbstractProvider(137)
        b = new AbstractProvider(137)
        c = new AbstractProvider(137)
        health = new ProviderHealth([a, b, c], ['a', 'b', 'c'], () => now)
        // Keeps the shuffle in list order
        jest.spyOn(Math, 'random').mockReturnValue(0.999999)
    })

    afterEach(() => {
        jest.restoreAllMocks()
    })

    it('keeps a provider in front after a single failure', () => {
        health.recordFailure(a)
        expect(health.order([a, b, c])).toEqual([a, b, c])
    })

    it('sets a provider aside after two failures in a row', () => {
        failTwice(a)
        expect(health.order([a, b, c])).toEqual([b, c, a])
    })

    it('forgets a failure after a success', () => {
        health.recordFailure(a)
        health.recordSuccess(a)
        health.recordFailure(a)
        expect(health.order([a, b, c])).toEqual([a, b, c])
    })

    it('brings a provider back after 30 seconds', () => {
        failTwice(a)
        now += 30 * SECOND - 1
        expect(health.order([a, b, c])).toEqual([b, c, a])
        now += 1
        expect(health.order([a, b, c])).toEqual([a, b, c])
    })

    it('doubles the cooldown each time a provider fails again after coming back, up to 5 minutes', () => {
        failTwice(a)
        const cooldowns = [30 * SECOND]
        for (let i = 0; i < 5; i++) {
            now += cooldowns[cooldowns.length - 1]
            const asideAt = now
            health.recordFailure(a)
            let back = asideAt
            while (health.order([a, b, c])[0] !== a) {
                now += SECOND
                back = now
            }
            cooldowns.push(back - asideAt)
        }
        expect(cooldowns).toEqual([30 * SECOND, 60 * SECOND, 2 * MINUTE, 4 * MINUTE, 5 * MINUTE, 5 * MINUTE])
    })

    it('does not extend the cooldown when a provider set aside fails again', () => {
        failTwice(a)
        now += 20 * SECOND
        health.recordFailure(a)
        now += 10 * SECOND
        expect(health.order([a, b, c])).toEqual([a, b, c])
    })

    it('starts over with 30 seconds after a success', () => {
        failTwice(a)
        now += 30 * SECOND
        health.recordFailure(a)
        now += 60 * SECOND
        health.recordSuccess(a)
        failTwice(a)
        now += 30 * SECOND
        expect(health.order([a, b, c])).toEqual([a, b, c])
    })

    it('still offers every provider when all are set aside, soonest back first', () => {
        failTwice(b)
        now += SECOND
        failTwice(a)
        now += SECOND
        failTwice(c)
        expect(health.order([a, b, c])).toEqual([b, a, c])
    })

    it('treats a provider it does not know as healthy', () => {
        const unknown = new AbstractProvider(137)
        failTwice(a)
        health.recordFailure(unknown)
        health.recordFailure(unknown)
        expect(health.order([a, unknown])).toEqual([unknown, a])
    })
})
