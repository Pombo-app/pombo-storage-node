#!/usr/bin/env node
import { StreamrClient, formStorageNodeAssignmentStreamId } from '@streamr/sdk'
import { program } from 'commander'
import pkg from '../package.json'
import { readConfigAndMigrateIfNeeded } from '../src/config/migration'

program
    .version(pkg.version)
    .name('streamr-storage-node-register')
    .description(
        'Prepare a storage node: create its assignment stream if missing and register its public URL(s). '
        + 'The node key is read from the config file.'
    )
    .arguments('<urls>')
    .option('-c, --config <file>', 'node config file the key is read from')
    .action(async (urls: string, options: { config?: string }) => {
        const config = readConfigAndMigrateIfNeeded(options.config)
        const client = new StreamrClient(config.client)
        try {
            const nodeAddress = await client.getUserId()
            const assignmentStreamId = formStorageNodeAssignmentStreamId(nodeAddress)
            try {
                await client.getStream(assignmentStreamId)
                console.info(`Assignment stream already exists: ${assignmentStreamId}`)
            } catch (err: any) {
                if (err?.code === 'STREAM_NOT_FOUND') {
                    await client.createStream({ id: assignmentStreamId, partitions: 1 })
                    console.info(`Created assignment stream: ${assignmentStreamId}`)
                } else {
                    throw err
                }
            }
            await client.setStorageNodeMetadata({ urls: urls.split(',').map((url) => url.trim()) })
            const metadata = await client.getStorageNodeMetadata(nodeAddress)
            console.info(`Registered ${nodeAddress} with URLs: ${metadata.urls.join(', ')}`)
        } finally {
            await client.destroy()
        }
    })

program.parseAsync().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
})
