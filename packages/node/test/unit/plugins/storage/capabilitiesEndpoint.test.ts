import express from 'express'
import request from 'supertest'
import { createCapabilitiesEndpoint } from '../../../../src/plugins/storage/capabilitiesEndpoint'

describe('capabilities endpoint', () => {

    const createApp = (signedReadsEnabled: boolean, version: string) => {
        const app = express()
        const endpoint = createCapabilitiesEndpoint(signedReadsEnabled, version)
        app.get(endpoint.path, ...endpoint.requestHandlers)
        return app
    }

    it('names the node, the build it runs and the features it serves', async () => {
        const res = await request(createApp(true, 'v103.3.1-pombo.3')).get('/capabilities')
        expect(res.status).toBe(200)
        expect(res.body).toEqual({
            name: 'pombo-storage-node',
            version: 'v103.3.1-pombo.3',
            features: ['metadata', 'storedAt', 'purge', 'stored', 'signedReads']
        })
    })

    it('omits signedReads while signatures are not required', async () => {
        const res = await request(createApp(false, 'dev')).get('/capabilities')
        expect(res.status).toBe(200)
        expect(res.body.version).toBe('dev')
        expect(res.body.features).not.toContain('signedReads')
    })
})
