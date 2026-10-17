// Replays shared/policy/mail.v1.json with src-tauri/src/mail/address.rs.
import { expect, it } from 'vitest';
import { MAIL } from './mailPolicy';
import { normalizeAddress, parseMailbox, domainOf } from './mailAddress';

it('replays the shared mailbox cases', () => {
  for (const row of MAIL.address_cases) {
    expect(normalizeAddress(row.raw), row.raw).toBe(row.address);
    expect(domainOf(row.raw), row.raw).toBe(row.address?.split('@')[1] ?? null);
  }
  for (const row of MAIL.mailbox_cases) {
    expect(parseMailbox(row.raw, MAIL.limits.name_chars), row.raw).toEqual(
      row.address === null ? null : { address: row.address, name: row.name },
    );
  }
});
