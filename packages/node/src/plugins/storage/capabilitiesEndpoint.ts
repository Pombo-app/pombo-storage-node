import { HttpServerEndpoint } from '../../Plugin'

/**
 * Lets a client tell this node apart from a vanilla Streamr storage node
 * with one request instead of probing each feature.
 */
export const createCapabilitiesEndpoint = (): HttpServerEndpoint => {
    return {
        path: '/capabilities',
        method: 'get',
        requestHandlers: [(_req, res) => {
            res.status(200).json({
                name: 'pombo-storage-node',
                features: ['metadata', 'storedAt', 'purge']
            })
        }]
    }
}
