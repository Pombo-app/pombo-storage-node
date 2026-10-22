import { randomEthereumAddress } from '@streamr/test-utils'
import { until, wait } from '@streamr/utils'
import { AbstractProvider, Interface, Log, makeError } from 'ethers'
import range from 'lodash/range'
import {
    ChainEventPoller,
    type EventListenerDefinition,
    POLLS_SINCE_LAST_FROM_BLOCK_UPDATE_THRESHOLD
} from './../../src/contracts/ChainEventPoller'
import { ProviderHealth } from '../../src/ProviderHealth'

const INITIAL_BLOCK_NUMBER = 123
const CONTRACT_ADDRESS = randomEthereumAddress()

const createAbi = (eventName: string) => {
    return [{
        type: 'event',
        name: eventName,
        anonymous: false,
        inputs: [{
            indexed: false,
            internalType: 'string',
            name: 'param1',
            type: 'string'
        },
        {
            indexed: false,
            internalType: 'string',
            name: 'param2',
            type: 'string'
        }]
    }]
}

const createEventLogItem = (
    eventName: string,
    eventArgs: any[],
    blockNumber: number
): Partial<Log> => {
    const contractInterface = new Interface(createAbi(eventName))
    return {
        blockNumber,
        address: CONTRACT_ADDRESS,
        ...contractInterface.encodeEventLog(eventName, eventArgs)
    }
}

const ATTEMPT_TIMEOUT = 50

const createChainEventPoller = (provider: AbstractProvider | AbstractProvider[], pollInterval: number) => {
    const providers = Array.isArray(provider) ? provider : [provider]
    const health = new ProviderHealth(providers)
    return new ChainEventPoller(
        { getSubProviders: () => providers, getProviderHealth: () => health } as any,
        { contracts: { pollInterval }, _timeouts: { jsonRpcAttemptTimeout: ATTEMPT_TIMEOUT } } as any
    )
}

const serverError = () => makeError('server response 529', 'SERVER_ERROR', { request: 'test' })

describe('ChainEventPoller', () => {

    it('happy path', async () => {
        const EVENT_NAME = 'TestEventName'
        const CONTRACT_INTERFACE_FRAGMENT = new Interface(createAbi(EVENT_NAME)).getEvent(EVENT_NAME)!
        const EVENT_ARGS = [ 'mock-arg1', 'mock-arg2' ]
        const POLL_INTERVAL = 100
        let blockNumber = INITIAL_BLOCK_NUMBER
        const provider: Partial<AbstractProvider> = {
            getLogs: jest.fn().mockImplementation(async () => {
                const result = [createEventLogItem(EVENT_NAME, EVENT_ARGS, blockNumber)]
                blockNumber++
                return result
            }),
            getBlockNumber: jest.fn().mockImplementation(async () => {
                return blockNumber
            })
        }
        const poller = createChainEventPoller(provider as any, POLL_INTERVAL)

        const listener1 = jest.fn()
        poller.on({
            onEvent: listener1,
            contractInterfaceFragment: CONTRACT_INTERFACE_FRAGMENT,
            contractAddress: CONTRACT_ADDRESS
        })

        // poller starts
        await until(() => listener1.mock.calls.length === 1)
        expect(provider.getBlockNumber).toHaveBeenCalledTimes(1)
        expect(provider.getLogs).toHaveBeenCalledTimes(1)
        expect(provider.getLogs).toHaveBeenCalledWith({
            address: [CONTRACT_ADDRESS],
            topics: [[CONTRACT_INTERFACE_FRAGMENT.topicHash]],
            fromBlock: INITIAL_BLOCK_NUMBER
        })
        expect(listener1).toHaveBeenCalledTimes(1)
        expect(listener1).toHaveBeenCalledWith(EVENT_ARGS, INITIAL_BLOCK_NUMBER)
        await until(() => listener1.mock.calls.length === 2)
        expect(provider.getBlockNumber).toHaveBeenCalledTimes(1)
        expect(provider.getLogs).toHaveBeenCalledTimes(2)
        expect(provider.getLogs).toHaveBeenNthCalledWith(
            2,
            {
                address: [CONTRACT_ADDRESS],
                topics: [[CONTRACT_INTERFACE_FRAGMENT.topicHash]],
                fromBlock: INITIAL_BLOCK_NUMBER + 1
            }
        )
        expect(listener1).toHaveBeenCalledTimes(2)
        expect(listener1).toHaveBeenNthCalledWith(2, EVENT_ARGS, INITIAL_BLOCK_NUMBER + 1)

        poller.off({
            onEvent: listener1,
            contractInterfaceFragment: CONTRACT_INTERFACE_FRAGMENT,
            contractAddress: CONTRACT_ADDRESS
        })

        // poller stops
        await wait(1.5 * POLL_INTERVAL)
        expect(provider.getBlockNumber).toHaveBeenCalledTimes(1)
        expect(provider.getLogs).toHaveBeenCalledTimes(2)
        expect(listener1).toHaveBeenCalledTimes(2)

        const listener2 = jest.fn()
        poller.on({
            onEvent: listener2,
            contractInterfaceFragment: CONTRACT_INTERFACE_FRAGMENT,
            contractAddress: CONTRACT_ADDRESS
        })

        // poller restarts
        await until(() => listener2.mock.calls.length === 1)
        expect(provider.getBlockNumber).toHaveBeenCalledTimes(2)
        expect(provider.getLogs).toHaveBeenCalledTimes(3)
        expect(listener2).toHaveBeenCalledTimes(1)
        expect(listener2).toHaveBeenCalledWith(EVENT_ARGS, INITIAL_BLOCK_NUMBER + 2)

        poller.off({
            onEvent: listener2,
            contractInterfaceFragment: CONTRACT_INTERFACE_FRAGMENT,
            contractAddress: CONTRACT_ADDRESS
        })

        // poller stops
        await wait(1.5 * POLL_INTERVAL)
        expect(provider.getBlockNumber).toHaveBeenCalledTimes(2)
        expect(provider.getLogs).toHaveBeenCalledTimes(3)
        expect(listener2).toHaveBeenCalledTimes(1)
    })

    it('multiple events and listeners', async () => {
        const EVENT_NAME_1 = 'TestEventName1'
        const EVENT_NAME_2 = 'TestEventName2'
        const CONTRACT_INTERFACE_FRAGMENT_1 = new Interface(createAbi(EVENT_NAME_1)).getEvent(EVENT_NAME_1)!
        const CONTRACT_INTERFACE_FRAGMENT_2 = new Interface(createAbi(EVENT_NAME_2)).getEvent(EVENT_NAME_2)!
        const POLL_INTERVAL = 100
        const provider: Partial<AbstractProvider> = {
            getLogs: jest.fn().mockImplementation(async () => {
                return [
                    createEventLogItem(EVENT_NAME_1, ['arg-foo1', ''], 150),
                    createEventLogItem(EVENT_NAME_1, ['arg-foo2', ''], 155),
                    createEventLogItem(EVENT_NAME_2, ['arg-bar', ''], 152)
                ]
            }),
            getBlockNumber: jest.fn().mockImplementation(async () => {
                return 123
            })
        }
        const poller = createChainEventPoller(provider as any, POLL_INTERVAL)

        const listener1 = jest.fn()
        const listener2 = jest.fn()
        const listener3 = jest.fn()
        poller.on({
            onEvent: listener1,
            contractInterfaceFragment: CONTRACT_INTERFACE_FRAGMENT_1,
            contractAddress: CONTRACT_ADDRESS,
        })
        poller.on({
            onEvent: listener2,
            contractInterfaceFragment: CONTRACT_INTERFACE_FRAGMENT_2,
            contractAddress: CONTRACT_ADDRESS
        })
        poller.on({
            onEvent: listener3,
            contractInterfaceFragment: CONTRACT_INTERFACE_FRAGMENT_2,
            contractAddress: CONTRACT_ADDRESS
        })

        await until(() => {
            return (listener1.mock.calls.length > 0) && (listener2.mock.calls.length > 0) && (listener3.mock.calls.length > 0)
        })
        expect(provider.getLogs).toHaveBeenNthCalledWith(
            1,
            {
                address: [CONTRACT_ADDRESS],
                topics: [[CONTRACT_INTERFACE_FRAGMENT_1.topicHash, CONTRACT_INTERFACE_FRAGMENT_2.topicHash]],
                fromBlock: INITIAL_BLOCK_NUMBER
            }
        )
        expect(listener1).toHaveBeenCalledTimes(2)
        expect(listener1).toHaveBeenCalledWith(['arg-foo1', ''], 150)
        expect(listener1).toHaveBeenCalledWith(['arg-foo2', ''], 155)
        expect(listener2).toHaveBeenCalledTimes(1)
        expect(listener2).toHaveBeenCalledWith(['arg-bar', ''], 152)
        expect(listener3).toHaveBeenCalledTimes(1)
        expect(listener3).toHaveBeenCalledWith(['arg-bar', ''], 152)

        await wait(1.5 * POLL_INTERVAL)
        expect(provider.getLogs).toHaveBeenNthCalledWith(
            2,
            {
                address: [CONTRACT_ADDRESS],
                topics: [[CONTRACT_INTERFACE_FRAGMENT_1.topicHash, CONTRACT_INTERFACE_FRAGMENT_2.topicHash]],
                fromBlock: 155 + 1
            }
        )

        poller.off({
            onEvent: listener1,
            contractInterfaceFragment: CONTRACT_INTERFACE_FRAGMENT_1,
            contractAddress: CONTRACT_ADDRESS,
        })
        poller.off({
            onEvent: listener2,
            contractInterfaceFragment: CONTRACT_INTERFACE_FRAGMENT_2,
            contractAddress: CONTRACT_ADDRESS
        })
        poller.off({
            onEvent: listener3,
            contractInterfaceFragment: CONTRACT_INTERFACE_FRAGMENT_2,
            contractAddress: CONTRACT_ADDRESS
        })
    })

    describe('several providers', () => {

        const EVENT_NAME = 'TestEventName'
        const CONTRACT_INTERFACE_FRAGMENT = new Interface(createAbi(EVENT_NAME)).getEvent(EVENT_NAME)!
        const POLL_INTERVAL = 20
        let poller: ChainEventPoller
        let definition: EventListenerDefinition<any[]>

        const listen = () => {
            const listener = jest.fn()
            definition = {
                onEvent: listener,
                contractInterfaceFragment: CONTRACT_INTERFACE_FRAGMENT,
                contractAddress: CONTRACT_ADDRESS
            }
            poller.on(definition)
            return listener
        }

        const hangs = () => new Promise<never>(() => {})

        beforeEach(() => {
            // Keeps the shuffle in list order, so each test decides who goes first
            jest.spyOn(Math, 'random').mockReturnValue(0.999999)
        })

        afterEach(() => {
            poller.off(definition)
            jest.restoreAllMocks()
        })

        it('reads the start block from the next provider when the first one hangs', async () => {
            const first: Partial<AbstractProvider> = {
                getBlockNumber: jest.fn().mockImplementation(hangs),
                getLogs: jest.fn().mockResolvedValue([])
            }
            const second: Partial<AbstractProvider> = {
                getBlockNumber: jest.fn().mockResolvedValue(INITIAL_BLOCK_NUMBER),
                getLogs: jest.fn().mockResolvedValue([])
            }
            poller = createChainEventPoller([first, second] as any, POLL_INTERVAL)
            const start = Date.now()
            listen()
            await until(() => (first.getLogs as jest.Mock).mock.calls.length > 0)
            expect(Date.now() - start).toBeLessThan(ATTEMPT_TIMEOUT * 3)
            expect(second.getBlockNumber).toHaveBeenCalledTimes(1)
            expect(first.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: INITIAL_BLOCK_NUMBER }))
        })

        it('polls the next provider in the same tick when one fails', async () => {
            const first: Partial<AbstractProvider> = {
                getBlockNumber: jest.fn().mockResolvedValue(INITIAL_BLOCK_NUMBER),
                getLogs: jest.fn().mockRejectedValue(serverError())
            }
            const second: Partial<AbstractProvider> = {
                getBlockNumber: jest.fn().mockResolvedValue(INITIAL_BLOCK_NUMBER),
                getLogs: jest.fn().mockResolvedValue([createEventLogItem(EVENT_NAME, ['a', 'b'], INITIAL_BLOCK_NUMBER)])
            }
            poller = createChainEventPoller([first, second] as any, 5000)
            const listener = listen()
            await until(() => listener.mock.calls.length > 0)
            expect(listener).toHaveBeenCalledWith(['a', 'b'], INITIAL_BLOCK_NUMBER)
            expect(first.getLogs).toHaveBeenCalledTimes(1)
            expect(second.getLogs).toHaveBeenCalledTimes(1)
        })

        it('stops asking a provider that hangs twice in a row', async () => {
            const first: Partial<AbstractProvider> = {
                getBlockNumber: jest.fn().mockResolvedValue(INITIAL_BLOCK_NUMBER),
                getLogs: jest.fn().mockImplementation(hangs)
            }
            const second: Partial<AbstractProvider> = {
                getBlockNumber: jest.fn().mockResolvedValue(INITIAL_BLOCK_NUMBER),
                getLogs: jest.fn().mockResolvedValue([])
            }
            poller = createChainEventPoller([first, second] as any, POLL_INTERVAL)
            listen()
            await until(() => (second.getLogs as jest.Mock).mock.calls.length >= 6, 5000)
            expect(first.getLogs).toHaveBeenCalledTimes(2)
        })

        it('reads the block number and the logs of a tick from the same provider', async () => {
            const calls: string[] = []
            const provider = (name: string, logs: () => Promise<Log[]>): Partial<AbstractProvider> => ({
                getBlockNumber: jest.fn().mockImplementation(async () => {
                    calls.push(`${name}.getBlockNumber`)
                    return INITIAL_BLOCK_NUMBER
                }),
                getLogs: jest.fn().mockImplementation(async () => {
                    calls.push(`${name}.getLogs`)
                    return logs()
                })
            })
            let firstPolls = 0
            const first = provider('first', async () => {
                // Healthy until the tick that also asks for the block number
                if (++firstPolls > POLLS_SINCE_LAST_FROM_BLOCK_UPDATE_THRESHOLD) {
                    throw serverError()
                }
                return []
            })
            const second = provider('second', async () => [])
            poller = createChainEventPoller([first, second] as any, 1)
            listen()
            await until(() => calls.includes('second.getLogs'), 5000)
            const tick = calls.slice(calls.lastIndexOf('first.getBlockNumber')).slice(0, 4)
            expect(tick).toEqual(['first.getBlockNumber', 'first.getLogs', 'second.getBlockNumber', 'second.getLogs'])
        })
    })

    describe('explicit block number fetching', () => {

        const EVENT_NAME = 'TestEventName'
        const CONTRACT_INTERFACE_FRAGMENT = new Interface(createAbi(EVENT_NAME)).getEvent(EVENT_NAME)!
        const POLL_INTERVAL = 10
        let invocationHistory: string[]
        let onGetBlockNumber: (nthCall: number) => number
        let onGetLogs: (nthCall: number) => Log[]
        let poller: ChainEventPoller

        beforeEach(() => {
            invocationHistory = []
            let getBlockNumberCallCount = 0
            let queryFilterCallCount = 0
            const provider: Partial<AbstractProvider> = {
                getLogs: jest.fn().mockImplementation(async (filter: { fromBlock: number }) => {
                    invocationHistory.push(`getLogs(fromBlock=${filter.fromBlock})`)
                    return onGetLogs(queryFilterCallCount++)
                }),
                getBlockNumber: jest.fn().mockImplementation(async () => {
                    invocationHistory.push('getBlockNumber()')
                    return onGetBlockNumber(getBlockNumberCallCount++)
                })
            }
            poller = createChainEventPoller(provider as any, POLL_INTERVAL)
        })

        it('when no events, fetches block number explicitly after every POLLS_SINCE_LAST_FROM_BLOCK_UPDATE_THRESHOLD', async () => {
            let currentRpcBlockNumber = INITIAL_BLOCK_NUMBER
            onGetBlockNumber = () => {
                return currentRpcBlockNumber++
            }
            onGetLogs = () => []
            const listener = () => {}
            poller.on({
                onEvent: listener,
                contractInterfaceFragment: CONTRACT_INTERFACE_FRAGMENT,
                contractAddress: CONTRACT_ADDRESS,
            })
            const expectedLength = 3 * POLLS_SINCE_LAST_FROM_BLOCK_UPDATE_THRESHOLD + 6
            await until(() => invocationHistory.length >= expectedLength)
            expect(invocationHistory.slice(0, expectedLength)).toEqual([
                'getBlockNumber()',
                ...range(POLLS_SINCE_LAST_FROM_BLOCK_UPDATE_THRESHOLD).map(() => `getLogs(fromBlock=${INITIAL_BLOCK_NUMBER})`),
                'getBlockNumber()',
                `getLogs(fromBlock=${INITIAL_BLOCK_NUMBER})`,
                ...range(POLLS_SINCE_LAST_FROM_BLOCK_UPDATE_THRESHOLD).map(() => `getLogs(fromBlock=${INITIAL_BLOCK_NUMBER + 2})`),
                'getBlockNumber()',
                `getLogs(fromBlock=${INITIAL_BLOCK_NUMBER + 2})`,
                ...range(POLLS_SINCE_LAST_FROM_BLOCK_UPDATE_THRESHOLD).map(() => `getLogs(fromBlock=${INITIAL_BLOCK_NUMBER + 3})`),
                'getBlockNumber()',
            ])
            poller.off({
                onEvent: listener,
                contractInterfaceFragment: CONTRACT_INTERFACE_FRAGMENT,
                contractAddress: CONTRACT_ADDRESS,
            })
        })

        // TODO: test other cases
    })
})
