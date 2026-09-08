import { HttpServerEndpoint } from '../../Plugin'

/**
 * Lets a client tell this node apart from a vanilla Streamr storage node
 * with one request instead of probing each feature. `signedReads` is listed
 * only while the node requires signatures to read gated channels.
 */
export const createCapabilitiesEndpoint = (signedReadsEnabled: boolean): HttpServerEndpoint => {
    const features = ['metadata', 'storedAt', 'purge']
    if (signedReadsEnabled) {
        features.push('signedReads')
    }
    return {
        path: '/capabilities',
        method: 'get',
        requestHandlers: [(_req, res) => {
            res.status(200).json({
                name: 'pombo-storage-node',
                features
            })
        }]
    }
}
