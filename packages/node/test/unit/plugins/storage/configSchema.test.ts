import { validateConfig } from '../../../../src/config/validateConfig'
import PLUGIN_CONFIG_SCHEMA from '../../../../src/plugins/storage/config.schema.json'

const existingConfig = () => ({
    cassandra: { hosts: ['cassandra', '10.10.0.2'], username: '', password: '', keyspace: 'pombo_storage', datacenter: 'dc1' },
    storageConfig: { refreshInterval: 60000 }
})

describe('storage plugin config schema', () => {

    it('reads in pages of 32 rows when the config does not say', () => {
        const config = existingConfig()
        validateConfig(config, PLUGIN_CONFIG_SCHEMA)
        expect(config).toMatchObject({ read: { fetchSize: 32 } })
    })

    it('pins queries to the local Cassandra when the config does not say', () => {
        const config = existingConfig()
        validateConfig(config, PLUGIN_CONFIG_SCHEMA)
        expect(config).toMatchObject({ cassandra: { pinToLocal: true } })
    })
})
