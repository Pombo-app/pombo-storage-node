import { HttpServerEndpoint } from '../../Plugin'

/**
 * Lets a client tell this node apart from a vanilla Streamr storage node
 * with one request instead of probing each feature. `signedReads` is listed
 * only while the node requires signatures to read gated channels. `version`
 * is the image tag the node was built from, or `dev` outside the published
 * image.
 */
export const createCapabilitiesEndpoint = (signedReadsEnabled: boolean, version: string): HttpServerEndpoint => {
    const features = ['metadata', 'storedAt', 'purge', 'stored']
    if (signedReadsEnabled) {
        features.push('signedReads')
    }
    return {
        path: '/capabilities',
        method: 'get',
        requestHandlers: [(_req, res) => {
            res.status(200).json({
                name: 'pombo-storage-node',
                version,
                features
            })
        }]
    }
}
