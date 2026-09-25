import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { KnownPublicStreams } from '../../../../src/plugins/storage/KnownPublicStreams'

const STREAM = '0x1234567890123456789012345678901234567890/public-1'
const OTHER = '0x1234567890123456789012345678901234567890/other-1'

describe('KnownPublicStreams', () => {

    let dir: string
    let file: string

    beforeEach(() => {
        jest.useFakeTimers()
        dir = mkdtempSync(path.join(os.tmpdir(), 'known-public-'))
        file = path.join(dir, 'known-public-streams.json')
    })

    afterEach(() => {
        jest.useRealTimers()
        rmSync(dir, { recursive: true, force: true })
    })

    it('keeps the latest answer per stream', () => {
        const known = new KnownPublicStreams()
        known.set(STREAM, true)
        expect(known.has(STREAM)).toBe(true)
        expect(known.has(OTHER)).toBe(false)
        known.set(STREAM, false)
        expect(known.has(STREAM)).toBe(false)
    })

    it('saves a few seconds after a change, and a new instance reads it back', () => {
        const known = new KnownPublicStreams(file)
        known.set(STREAM, true)
        known.set(OTHER, true)
        expect(existsSync(file)).toBe(false)
        jest.advanceTimersByTime(5 * 1000)
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([STREAM, OTHER])
        const restarted = new KnownPublicStreams(file)
        expect(restarted.has(STREAM)).toBe(true)
        expect(restarted.has(OTHER)).toBe(true)
    })

    it('saves a stream that stopped being public', () => {
        const known = new KnownPublicStreams(file)
        known.set(STREAM, true)
        known.flush()
        known.set(STREAM, false)
        known.flush()
        expect(new KnownPublicStreams(file).has(STREAM)).toBe(false)
    })

    it('writes nothing when no answer changed', () => {
        const known = new KnownPublicStreams(file)
        known.set(STREAM, false)
        known.flush()
        expect(existsSync(file)).toBe(false)
    })

    it('starts empty when the file is missing or unreadable', () => {
        expect(new KnownPublicStreams(file).has(STREAM)).toBe(false)
        writeFileSync(file, '{not json')
        expect(new KnownPublicStreams(file).has(STREAM)).toBe(false)
        writeFileSync(file, JSON.stringify({ [STREAM]: true }))
        expect(new KnownPublicStreams(file).has(STREAM)).toBe(false)
    })
})
