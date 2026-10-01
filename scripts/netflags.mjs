/**
 * Node 20 turned on automatic address-family selection: a hostname that publishes AAAA records is tried over
 * IPv6 first, and this host has no working IPv6 egress, so that attempt is blackholed and every request to
 * such a host — a Cloudflare-fronted model gateway, for one — fails as a transport error while the same URL
 * over IPv4 answers at once. `dns-result-order=ipv4first` alone changes nothing, because the timeout comes
 * from the family autoselection rather than from the order the lookup returned.
 *
 * They travel as NODE_OPTIONS rather than spawn's `execArgv` so DSH's worker threads, and any Node process it
 * starts in turn, inherit them: a turn's model request runs wherever the agent loop runs, not only in the
 * process this script spawns.
 */
// The native safe web fetcher explicitly enables address-family selection in its pinned agent.
// Give each address 2 seconds there; the default 250 ms abandons usable IPv4 connections on this WSL host.
export const networkFlags = ['--no-network-family-autoselection', '--dns-result-order=ipv4first', '--network-family-autoselection-attempt-timeout=2000'];

/** The NODE_OPTIONS value for a child, keeping whatever the parent process was itself started with. */
export function networkNodeOptions(existing = process.env.NODE_OPTIONS ?? '') {
  const kept = existing.split(/\s+/).filter(flag => flag && !networkFlags.includes(flag) && !flag.startsWith('--network-family-autoselection-attempt-timeout='));
  return [...kept, ...networkFlags].join(' ');
}
