import { describe, expect, it } from 'vitest';
import domains from 'free-email-domains';
import { isConsumerDomain } from './consumerDomains';

describe('the pinned consumer-domain list', () => {
  it('recognizes common providers and keeps business domains separate', () => {
    for (const value of ['gmail.com', 'outlook.com', 'yahoo.com', 'GMAIL.COM'])
      expect(isConsumerDomain(value), value).toBe(true);
    expect(isConsumerDomain('acme.example')).toBe(false);
  });
  it('ships lowercase ASCII domain data', () => {
    expect(domains.length).toBeGreaterThan(100);
    for (const domain of domains) expect(domain).toMatch(/^[a-z0-9.-]+$/);
  });
});
