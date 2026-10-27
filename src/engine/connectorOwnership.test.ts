// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import cases from '../../shared/policy/connector-ownership-cases.v1.json';
import source from '../../shared/policy/connector-ownership.v1.json?raw';
import {
  CONNECTOR_OWNERSHIP_POLICY,
  connectorOwnership,
  connectorOwnershipReason,
  readConnectorOwnershipPolicy,
} from './connectorOwnership';

type PolicyCase = {
  id: string;
  accepted: boolean;
  raw?: string;
  patch?: Record<string, unknown>;
  value?: unknown;
  probes?: { entry: unknown; expected: string }[];
};

describe('M96.4a shared connector ownership policy', () => {
  it('m96_owner_policy_hashes_to_the_digest_the_Rust_loader_also_asserts', () => {
    const bytes = readFileSync(
      resolve(__dirname, '../../shared/policy/connector-ownership.v1.json'),
    );
    const digest = readFileSync(
      resolve(__dirname, '../../shared/policy/connector-ownership.v1.sha256'),
      'utf8',
    ).trim();
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest);
    expect(source).toBe(bytes.toString('utf8'));
    expect(CONNECTOR_OWNERSHIP_POLICY).not.toBeNull();
    expect(CONNECTOR_OWNERSHIP_POLICY?.format).toBe(1);
    expect(CONNECTOR_OWNERSHIP_POLICY?.artifact_version).toBe(1);
  });

  it.each(cases.entry_cases)('m96_owner_shared_entry_case: $id', (test) => {
    expect(connectorOwnership(test.entry)).toBe(test.expected);
    const reason = connectorOwnershipReason(test.entry);
    if (test.expected === 'cli') expect(reason).toBeNull();
    else {
      const messages = CONNECTOR_OWNERSHIP_POLICY?.messages;
      expect(reason).toBe(test.expected === 'managed' ? messages?.managed : messages?.invalid);
    }
  });

  it.each(cases.policy_cases as PolicyCase[])('m96_owner_shared_policy_case: $id', (test) => {
    let value: unknown = JSON.parse(source);
    if (test.patch !== undefined) Object.assign(value as object, test.patch);
    else if (test.raw === undefined) value = test.value;
    const policy = readConnectorOwnershipPolicy(test.raw ?? JSON.stringify(value));
    expect(policy !== null).toBe(test.accepted);
    if (policy === null) {
      expect(connectorOwnership({}, policy)).toBe('unavailable');
      expect(connectorOwnership({ executionOwner: 'cli' }, policy)).toBe('unavailable');
      expect(connectorOwnershipReason({ url: 'synthetic-raw-route' }, policy)).toBe(
        'Connector ownership policy is unavailable.',
      );
    }
    for (const probe of test.probes ?? []) {
      expect(connectorOwnership(probe.entry, policy)).toBe(probe.expected);
    }
  });

  it('m96_owner_managed_marker_presence_is_checked_without_reading_its_contents', () => {
    expect(connectorOwnership({ secretRef: undefined })).toBe('invalid');
    expect(connectorOwnership({ executionOwner: 'cli', secretRef: undefined })).toBe('invalid');
    expect(connectorOwnership({ executionOwner: 'cerebro', secretRef: undefined })).toBe('managed');
  });
});
