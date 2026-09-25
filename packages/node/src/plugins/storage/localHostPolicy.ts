import { lookup } from 'dns/promises'
import { policies } from 'cassandra-driver'

export type LoadBalancingPolicyFactory = () => policies.loadBalancing.LoadBalancingPolicy

// With a peer as contact point, a restart of the local Cassandra moves the control connection to the
// peer, and the driver (4.8) re-adds this host under its peer-side address with a pool that never opens.
export const cassandraContactPoints = (hosts: string[], pinToLocal: boolean): string[] => (pinToLocal ? [hosts[0]] : [...hosts])

const ipOf = (address: string): string => address.substring(0, address.lastIndexOf(':'))

// hosts[0] is the Cassandra on this machine. The driver finds the rest of the ring through
// system.peers, so the other hosts are excluded by the address it knows them by (rpc address).
export const createLocalHostPolicyFactory = async (hosts: string[], localDc: string): Promise<LoadBalancingPolicyFactory> => {
    const otherHosts = await Promise.all(hosts.slice(1).map(async (host) => (await lookup(host)).address))
    const excluded = new Set(otherHosts)
    return () => new policies.loadBalancing.DefaultLoadBalancingPolicy({
        localDc,
        filter: (host) => !excluded.has(ipOf(host.address))
    })
}
