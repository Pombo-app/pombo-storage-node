import type { Provider } from 'ethers'
import { AbstractProvider, FetchRequest } from 'ethers'
import { Lifecycle, inject, scoped } from 'tsyringe'
import { ConfigInjectionToken, type StrictStreamrClientConfig } from './ConfigTypes'
import { FailoverProvider } from './FailoverProvider'
import { ProviderHealth } from './ProviderHealth'
import { LoggingJsonRpcProvider } from './utils/LoggingJsonRpcProvider'
import { config as CHAIN_CONFIG } from '@streamr/config'

// Only the host goes to the logs: the path of an RPC URL may carry an API key
const hostOf = (url: string): string | undefined => {
    try {
        return new URL(url).host
    } catch {
        return undefined
    }
}

function isDevChain(config: Pick<StrictStreamrClientConfig, 'contracts'>): boolean {
    return config.contracts.ethereumNetwork.chainId === CHAIN_CONFIG.dev2.id
}

const formJsonRpcApiProviderOptions = (config: Pick<StrictStreamrClientConfig, 'contracts'>) => {
    return {
        staticNetwork: true,
        batchStallTime: isDevChain(config) ? 0 : undefined, // Don't batch requests, send them immediately
        cacheTimeout: isDevChain(config) ? -1 : undefined   // Do not employ result caching
    }
}

@scoped(Lifecycle.ContainerScoped)
export class RpcProviderSource {
    private readonly config: Pick<StrictStreamrClientConfig, 'contracts' | '_timeouts'>
    private provider?: Provider
    private subProviders?: AbstractProvider[]
    private health?: ProviderHealth

    constructor(@inject(ConfigInjectionToken) config: Pick<StrictStreamrClientConfig, 'contracts' | '_timeouts'>) {
        this.config = config
    }

    getProvider(): Provider {
        if (this.provider === undefined) {
            const providers = this.getSubProviders()
            // eslint-disable-next-line no-underscore-dangle
            const timeouts = this.config._timeouts
            this.provider = new FailoverProvider(providers, this.config.contracts.ethereumNetwork.chainId, {
                quorum: Math.min(this.config.contracts.rpcQuorum, this.config.contracts.rpcs.length),
                cacheTimeout: formJsonRpcApiProviderOptions(this.config).cacheTimeout
            }, {
                attemptTimeout: timeouts.jsonRpcAttemptTimeout,
                callTimeout: timeouts.jsonRpcTimeout
            }, this.getProviderHealth())
        }
        return this.provider
    }

    getProviderHealth(): ProviderHealth {
        this.health ??= new ProviderHealth(this.getSubProviders(), this.config.contracts.rpcs.map((c, i) => hostOf(c.url) ?? `#${i}`))
        return this.health
    }

    /**
     * Use this method only if you need access each provider separately. In most cases it is better to use
     * the `getProvider` method as it provides better fail-safety.
     */
    getSubProviders(): AbstractProvider[] {
        this.subProviders ??= this.config.contracts.rpcs.map((c) => {
            const f = new FetchRequest(c.url)
            f.retryFunc = async () => false
            // eslint-disable-next-line no-underscore-dangle
            f.timeout = this.config._timeouts.jsonRpcTimeout
            const opts = formJsonRpcApiProviderOptions(this.config)
            return new LoggingJsonRpcProvider(f, this.config.contracts.ethereumNetwork.chainId, opts)
        })
        return this.subProviders
    }
}
