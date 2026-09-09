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
    .arguments('[urls]')
    .option('-c, --config <file>', 'node config file the key is read from')
    .option('--print-address', 'print the node address derived from the key, then exit')
    .action(async (urls: string | undefined, options: { config?: string, printAddress?: boolean }) => {
        const config = readConfigAndMigrateIfNeeded(options.config)
        const client = new StreamrClient(config.client)
        try {
            const nodeAddress = await client.getUserId()
            if (options.printAddress === true) {
                process.stdout.write(nodeAddress)
                return
            }
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
            if (urls !== undefined && urls.trim() !== '') {
                await client.setStorageNodeMetadata({ urls: urls.split(',').map((url) => url.trim()) })
                const metadata = await client.getStorageNodeMetadata(nodeAddress)
                console.info(`Registered ${nodeAddress} with URLs: ${metadata.urls.join(', ')}`)
            } else {
                console.info(`Assignment stream ready for ${nodeAddress}. No URL given, so the node is not registered for reads yet.`)
            }
        } finally {
            await client.destroy()
        }
    })

program.parseAsync().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
})
