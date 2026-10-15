import { expect, it } from 'vitest';
import { makeEntry } from '@/test/factories';
import { libraryCards } from './LibraryIndex';
const now = new Date(2026, 6, 28, 12);
it.each(['Agent', 'Skill'])(
  '%s cards read lists, malformed sets and passed once distinctly',
  (type) => {
    const card = (schedule: unknown) =>
      libraryCards(
        type === 'Agent' ? 'agent' : 'skill',
        [
          makeEntry({
            path: `records/${type.toLowerCase()}/a.md`,
            type,
            title: 'A',
            properties: { schedule } as never,
          }),
        ],
        now,
      )[0];
    expect(card(['monthly last 18:00', 'weekdays 08:30']).duty).toEqual({
      on: true,
      reason: 'Monthly on the last day at 18:00; Every weekday at 08:30',
    });
    expect(card(['daily 09:00', 'bad']).duty).toEqual({
      on: false,
      reason: 'Schedule not understood',
    });
    expect(card('once 2026-07-27 09:00').duty).toEqual({
      on: false,
      reason: 'Its one time has passed — runs only when you ask',
    });
  },
);
