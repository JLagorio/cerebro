import domains from 'free-email-domains';

/** Upstream's pinned data only: no refresh, network or mutable public set. */
const CONSUMER_DOMAINS: ReadonlySet<string> = new Set(domains);
export function isConsumerDomain(domain: string): boolean {
  return CONSUMER_DOMAINS.has(domain.toLowerCase());
}
