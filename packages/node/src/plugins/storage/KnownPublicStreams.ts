import { Logger } from '@streamr/utils'
import { readFileSync, renameSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

const logger = new Logger('KnownPublicStreams')

export const DEFAULT_KNOWN_PUBLIC_STREAMS_FILE = path.join(os.homedir(), '.streamr', 'known-public-streams.json')
const SAVE_DELAY_MS = 5 * 1000

const load = (file: string): string[] => {
    let content: string
    try {
        content = readFileSync(file, 'utf8')
    } catch {
        return []
    }
    try {
        const parsed = JSON.parse(content)
        if (Array.isArray(parsed) && parsed.every((id) => typeof id === 'string')) {
            return parsed
        }
    } catch {
        // fall through
    }
    logger.warn('Ignoring an unreadable list of public streams', { file })
    return []
}

/**
 * The streams whose latest answer from the chain was: no Pombo gate and public
 * SUBSCRIBE. Kept on disk, when given a file, so the answer outlives a restart.
 */
export class KnownPublicStreams {

    private readonly file?: string
    private readonly streams: Set<string>
    private saveTimeout?: NodeJS.Timeout

    constructor(file?: string) {
        this.file = file
        this.streams = new Set((file !== undefined) ? load(file) : [])
    }

    has(streamId: string): boolean {
        return this.streams.has(streamId)
    }

    set(streamId: string, isPublic: boolean): void {
        if (isPublic === this.streams.has(streamId)) {
            return
        }
        if (isPublic) {
            this.streams.add(streamId)
        } else {
            this.streams.delete(streamId)
        }
        this.scheduleSave()
    }

    flush(): void {
        if (this.saveTimeout !== undefined) {
            clearTimeout(this.saveTimeout)
            this.saveTimeout = undefined
            this.save()
        }
    }

    private scheduleSave(): void {
        if ((this.file !== undefined) && (this.saveTimeout === undefined)) {
            this.saveTimeout = setTimeout(() => {
                this.saveTimeout = undefined
                this.save()
            }, SAVE_DELAY_MS)
        }
    }

    private save(): void {
        const tmpFile = `${this.file!}.tmp`
        try {
            writeFileSync(tmpFile, JSON.stringify([...this.streams]))
            renameSync(tmpFile, this.file!)
        } catch (err) {
            logger.warn('Could not save the list of public streams', { err, file: this.file })
        }
    }
}
