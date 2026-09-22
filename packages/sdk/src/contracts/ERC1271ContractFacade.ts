import { BrandedString, EthereumAddress, EcdsaSecp256k1Evm, MapWithTtl, toUserId, UserID } from '@streamr/utils'
import { Lifecycle, scoped } from 'tsyringe'
import { RpcProviderSource } from '../RpcProviderSource'
import { StreamrClientError } from '../StreamrClientError'
import type { IERC1271 as ERC1271Contract } from '../ethereumArtifacts/IERC1271'
import ERC1271ContractArtifact from '../ethereumArtifacts/IERC1271Abi.json'
import { createLazyMap, Mapping } from '../utils/Mapping'
import { ContractFactory } from './ContractFactory'

export const SUCCESS_MAGIC_VALUE = '0x1626ba7e' // Magic value for success as defined by ERC-1271

export type CacheKey = BrandedString<string>

const CACHE_TTL = 10 * 60 * 1000
/**
 * A refusal is remembered for seconds. An account publishes the moment it pays
 * its way past a gate, and a held "no" drops everything it writes until the
 * entry expires.
 */
const DENIAL_TTL = 20 * 1000 // 10 minutes

const signingUtil = new EcdsaSecp256k1Evm()

function formCacheKey(contractAddress: EthereumAddress, signerUserId: UserID): CacheKey {
    return `${contractAddress}_${signerUserId}` as CacheKey
}

@scoped(Lifecycle.ContainerScoped)
export class ERC1271ContractFacade {

    private readonly contractsByAddress: Mapping<EthereumAddress, ERC1271Contract>
    private readonly publisherCache = new MapWithTtl<CacheKey, boolean>(
        (isValid) => (isValid ? CACHE_TTL : DENIAL_TTL))

    constructor(
        contractFactory: ContractFactory,
        rpcProviderSource: RpcProviderSource
    ) {
        this.contractsByAddress = createLazyMap<EthereumAddress, ERC1271Contract>({
            valueFactory: async (address) => {
                return contractFactory.createReadContract(
                    address,
                    ERC1271ContractArtifact,
                    rpcProviderSource.getProvider(),
                    'erc1271Contract'
                ) as ERC1271Contract
            }
        })
    }

    async isValidSignature(contractAddress: EthereumAddress, payload: Uint8Array, signature: Uint8Array): Promise<boolean> {
        const recoveredSignerUserId = toUserId(signingUtil.recoverSignerUserId(signature, payload))
        const cacheKey = formCacheKey(contractAddress, recoveredSignerUserId)
        const cachedValue = this.publisherCache.get(cacheKey)
        if (cachedValue !== undefined) {
            return cachedValue
        } else {
            let result: string
            try {
                const contract = await this.contractsByAddress.get(contractAddress)
                result = await contract.isValidSignature(signingUtil.keccakHash(payload), signature)
            } catch (err) {
                // Not an answer about the signature: the caller decides what an
                // unreachable chain means, and must not read it as a refusal.
                const reason = (err instanceof Error) ? err.message : String(err)
                throw new StreamrClientError(
                    `Could not ask ${contractAddress} whether the signature is valid: ${reason}`, 'CHAIN_UNAVAILABLE')
            }
            const isValid = result === SUCCESS_MAGIC_VALUE
            this.publisherCache.set(cacheKey, isValid)
            return isValid
        }
    }
}
