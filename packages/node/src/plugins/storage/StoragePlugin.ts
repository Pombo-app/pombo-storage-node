import { type Stream, type StreamMessage, StreamMessageType, StreamrClient, formStorageNodeAssignmentStreamId } from '@streamr/sdk'
import { EthereumAddress, Logger, MetricsContext, executeSafePromise, toEthereumAddress } from '@streamr/utils'
import { Schema } from 'ajv'
import { ApiPluginConfig, Plugin } from '../../Plugin'
import { Storage, startCassandraStorage } from './Storage'
import { IngestValidator } from './IngestValidator'
import { PomboGates } from './PomboGates'
import { SignedRequestVerifier } from './SignedRequest'
import { RetentionScheduler } from './RetentionScheduler'
import { createCapabilitiesEndpoint } from './capabilitiesEndpoint'
import { PurgeAuthorizer, createPurgeEndpoint } from './purgeEndpoint'
import { createSignedReadGuard } from './signedReads'
import { StorageConfig } from './StorageConfig'
import PLUGIN_CONFIG_SCHEMA from './config.schema.json'
import { createDataMetadataEndpoint } from './dataMetadataEndpoint'
import { createDataQueryEndpoint } from './dataQueryEndpoint'
import { createStorageConfigEndpoint } from './storageConfigEndpoint'

const logger = new Logger('StoragePlugin')

export interface StoragePluginConfig extends ApiPluginConfig {
    cassandra: {
        hosts: string[]
        username: string
        password: string
        keyspace: string
        datacenter: string
    }
    storageConfig: {
        refreshInterval: number
    }
    cluster: {
        // If clusterAddress is undefined, the broker's address will be used
        clusterAddress?: EthereumAddress
        clusterSize: number
        myIndexInCluster: number
    }
    bucket: {
        maxBucketSize: number
        maxBucketRecords: number
        checkFullBucketsTimeout: number
    }
    batch: {
        logErrors: boolean
    }
    signedReads: {
        enabled: boolean
    }
    retention: {
        enabled: boolean
        intervalHours: number
        graceDays: number
        abortFractionPercent: number
        bucketDeleteLimit: number
        rowDeleteLimit: number
    }
}

const isStorableMessage = (msg: StreamMessage): boolean => {
    return msg.messageType === StreamMessageType.MESSAGE
}

export class StoragePlugin extends Plugin<StoragePluginConfig> {

    private streamrClient?: StreamrClient
    private cassandra?: Storage
    private storageConfig?: StorageConfig
    private gates?: PomboGates
    private ingestValidator?: IngestValidator
    private signedRequestVerifier?: SignedRequestVerifier
    private retentionScheduler?: RetentionScheduler
    private messageListener?: (msg: StreamMessage) => void

    async start(streamrClient: StreamrClient): Promise<void> {
        this.streamrClient = streamrClient
        const clusterId = this.pluginConfig.cluster.clusterAddress ?? toEthereumAddress(await this.streamrClient.getUserId())
        const assignmentStream = await this.streamrClient.getStream(formStorageNodeAssignmentStreamId(clusterId))
        const metricsContext = await this.streamrClient.getNode().getMetricsContext()
        this.cassandra = await this.startCassandraStorage(metricsContext)
        this.storageConfig = await this.startStorageConfig(clusterId, assignmentStream)
        this.gates = new PomboGates(this.streamrClient)
        this.ingestValidator = new IngestValidator(this.streamrClient, metricsContext, this.gates)
        this.signedRequestVerifier = new SignedRequestVerifier()
        this.messageListener = (msg) => {
            if (isStorableMessage(msg) && this.storageConfig!.hasStreamPart(msg.getStreamPartID())) {
                const receivedAt = Date.now()
                this.ingestValidator!.validate(msg).then((verdict) => {
                    if (verdict.store) {
                        this.cassandra!.store(msg, receivedAt)
                    }
                }, (err) => {
                    logger.warn('Ingest validation failed unexpectedly, storing message', { messageId: msg.messageId, err })
                    this.cassandra!.store(msg, receivedAt)
                })
            }
        }
        const node = this.streamrClient.getNode()
        node.addMessageListener(this.messageListener)
        const signedReadsEnabled = this.pluginConfig.signedReads.enabled
        const readGuard = createSignedReadGuard(signedReadsEnabled, this.gates, this.signedRequestVerifier)
        this.addHttpServerEndpoint(createDataQueryEndpoint(this.cassandra, metricsContext, [readGuard]))
        this.addHttpServerEndpoint(createDataMetadataEndpoint(this.cassandra, [readGuard]))
        this.addHttpServerEndpoint(createStorageConfigEndpoint(this.storageConfig))
        const purgeAuthorizer = new PurgeAuthorizer(this.streamrClient, this.gates)
        this.addHttpServerEndpoint(createPurgeEndpoint(this.cassandra, purgeAuthorizer, this.signedRequestVerifier))
        this.addHttpServerEndpoint(createCapabilitiesEndpoint(signedReadsEnabled))

        // In a cluster the deletes replicate through Cassandra, so retention runs on one node only.
        if (this.pluginConfig.retention.enabled && this.pluginConfig.cluster.myIndexInCluster === 0) {
            this.retentionScheduler = new RetentionScheduler(
                this.streamrClient,
                this.pluginConfig.cassandra,
                this.pluginConfig.retention,
                this.brokerConfig.httpServer.port
            )
            this.retentionScheduler.start()
        }
    }

    async stop(): Promise<void> {
        const node = this.streamrClient!.getNode()
        node.removeMessageListener(this.messageListener!)
        await this.retentionScheduler?.destroy()
        this.signedRequestVerifier!.destroy()
        this.gates!.destroy()
        await Promise.all(Array.from(this.storageConfig!.getStreamParts()).map((streamPart) => node.leave(streamPart)))
        await this.cassandra!.close()
        this.storageConfig!.destroy()
    }

    // eslint-disable-next-line class-methods-use-this
    override getConfigSchema(): Schema {
        return PLUGIN_CONFIG_SCHEMA
    }

    private async startCassandraStorage(metricsContext: MetricsContext): Promise<Storage> {
        const cassandraStorage = await startCassandraStorage({
            contactPoints: [...this.pluginConfig.cassandra.hosts],
            localDataCenter: this.pluginConfig.cassandra.datacenter,
            keyspace: this.pluginConfig.cassandra.keyspace,
            username: this.pluginConfig.cassandra.username,
            password: this.pluginConfig.cassandra.password,
            opts: {
                useTtl: false,
                logErrors: this.pluginConfig.batch.logErrors,
                ...this.pluginConfig.bucket
            }
        })
        cassandraStorage.enableMetrics(metricsContext)
        return cassandraStorage
    }

    private async startStorageConfig(clusterId: EthereumAddress, assignmentStream: Stream): Promise<StorageConfig> {
        const node = this.streamrClient!.getNode()
        const storageConfig = new StorageConfig(
            clusterId,
            this.pluginConfig.cluster.clusterSize,
            this.pluginConfig.cluster.myIndexInCluster,
            this.pluginConfig.storageConfig.refreshInterval,
            this.streamrClient!,
            {
                onStreamPartAdded: async (streamPart) => {
                    try {
                        await node.join(streamPart, { minCount: 1, timeout: 5000 }) // best-effort, can time out
                    } catch (_e) {
                        // no-op
                    }
                    try {
                        await assignmentStream.publish({
                            streamPart
                        })
                        logger.debug('Published message to assignment stream', {
                            assignmentStreamId: assignmentStream.id
                        })
                    } catch (err) {
                        logger.warn('Failed to publish to assignment stream', {
                            assignmentStreamId: assignmentStream.id,
                            err
                        })
                    }
                },
                onStreamPartRemoved: (streamPart) => {
                    executeSafePromise(() => node.leave(streamPart))
                }
            }
        )
        await storageConfig.start()
        return storageConfig
    }
}
