import { Host, types } from 'cassandra-driver'
import { cassandraContactPoints, createLocalHostPolicyFactory } from '../../../../src/plugins/storage/localHostPolicy'

const host = (address: string): Host => ({ address, datacenter: 'dc1' }) as unknown as Host

describe('createLocalHostPolicyFactory', () => {

    it('ignores the other listed hosts and keeps the local one, whichever address the driver knows it by', async () => {
        const policy = (await createLocalHostPolicyFactory(['cassandra', '10.10.0.2'], 'dc1'))()
        expect(policy.getDistance(host('10.10.0.2:9042'))).toBe(types.distance.ignored)
        expect(policy.getDistance(host('172.20.0.2:9042'))).toBe(types.distance.local)
        expect(policy.getDistance(host('10.10.0.1:9042'))).toBe(types.distance.local)
    })

    it('keeps every host when only the local one is listed', async () => {
        const policy = (await createLocalHostPolicyFactory(['cassandra'], 'dc1'))()
        expect(policy.getDistance(host('172.20.0.2:9042'))).toBe(types.distance.local)
    })

    it('creates a separate policy for each client', async () => {
        const factory = await createLocalHostPolicyFactory(['cassandra', '10.10.0.2'], 'dc1')
        expect(factory()).not.toBe(factory())
    })
})

describe('cassandraContactPoints', () => {

    it('contacts only the local Cassandra when queries are pinned to it', () => {
        expect(cassandraContactPoints(['cassandra', '10.10.0.2'], true)).toEqual(['cassandra'])
    })

    it('contacts every listed host otherwise', () => {
        expect(cassandraContactPoints(['cassandra', '10.10.0.2'], false)).toEqual(['cassandra', '10.10.0.2'])
    })
})
