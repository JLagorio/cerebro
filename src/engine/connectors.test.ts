import { describe, expect, it } from 'vitest';
import { parseConnectors, serializeConnectors } from './connectors';

describe('connectors config', () => {
  it('round-trips both transports and preserves unmodeled keys', () => {
    const raw = JSON.stringify({
      servers: {
        jira: {
          transport: 'http',
          url: 'https://jira/mcp',
          headers: { Authorization: 'Bearer t' },
          enabled: true,
        },
        linear: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@linear/mcp'],
          env: { KEY: 'v' },
          enabled: false,
        },
      },
    });
    const specs = parseConnectors(raw);
    expect(specs.map((s) => s.name)).toEqual(['jira', 'linear']);
    expect(specs[0].extra).toEqual({ headers: { Authorization: 'Bearer t' } });
    expect(specs[1].args).toEqual(['-y', '@linear/mcp']);

    const reparsed = JSON.parse(serializeConnectors(specs));
    expect(reparsed.servers.jira.headers.Authorization).toBe('Bearer t');
    expect(reparsed.servers.linear.env.KEY).toBe('v');
    expect(reparsed.servers.linear.enabled).toBe(false);
  });

  it('shows an empty list for absent or broken config', () => {
    expect(parseConnectors('')).toEqual([]);
    expect(parseConnectors('{not json')).toEqual([]);
    expect(parseConnectors('{"servers": 3}')).toEqual([]);
  });

  it('treats anything but explicit enabled: true as off', () => {
    const specs = parseConnectors('{"servers": {"a": {"transport": "http", "url": "u"}}}');
    expect(specs[0].enabled).toBe(false);
  });
});
