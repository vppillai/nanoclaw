import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, storeChatMetadata } from './db.js';
import { getAvailableGroups, _setRegisteredGroups } from './index.js';

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  // These test the patterns that will become ownsJid() on the Channel interface

  it('Telegram group JID: starts with tg: prefix', () => {
    const jid = 'tg:12345678';
    expect(jid.startsWith('tg:')).toBe(true);
  });

  it('Telegram DM JID: starts with tg: prefix', () => {
    const jid = 'tg:87654321';
    expect(jid.startsWith('tg:')).toBe(true);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns only groups, excludes DMs', () => {
    storeChatMetadata(
      'tg:101',
      '2024-01-01T00:00:01.000Z',
      'Group 1',
      'telegram',
      true,
    );
    storeChatMetadata(
      'tg:50',
      '2024-01-01T00:00:02.000Z',
      'User DM',
      'telegram',
      false,
    );
    storeChatMetadata(
      'tg:102',
      '2024-01-01T00:00:03.000Z',
      'Group 2',
      'telegram',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.jid)).toContain('tg:101');
    expect(groups.map((g) => g.jid)).toContain('tg:102');
    expect(groups.map((g) => g.jid)).not.toContain('tg:50');
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata(
      'tg:100',
      '2024-01-01T00:00:01.000Z',
      'Group',
      'telegram',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('tg:100');
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata(
      'tg:201',
      '2024-01-01T00:00:01.000Z',
      'Registered',
      'telegram',
      true,
    );
    storeChatMetadata(
      'tg:202',
      '2024-01-01T00:00:02.000Z',
      'Unregistered',
      'telegram',
      true,
    );

    _setRegisteredGroups({
      'tg:201': {
        name: 'Registered',
        folder: 'registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'tg:201');
    const unreg = groups.find((g) => g.jid === 'tg:202');

    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });

  it('returns groups ordered by most recent activity', () => {
    storeChatMetadata(
      'tg:301',
      '2024-01-01T00:00:01.000Z',
      'Old',
      'telegram',
      true,
    );
    storeChatMetadata(
      'tg:302',
      '2024-01-01T00:00:05.000Z',
      'New',
      'telegram',
      true,
    );
    storeChatMetadata(
      'tg:303',
      '2024-01-01T00:00:03.000Z',
      'Mid',
      'telegram',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('tg:302');
    expect(groups[1].jid).toBe('tg:303');
    expect(groups[2].jid).toBe('tg:301');
  });

  it('excludes non-group chats regardless of JID format', () => {
    // Unknown JID format stored without is_group should not appear
    storeChatMetadata(
      'unknown-format-123',
      '2024-01-01T00:00:01.000Z',
      'Unknown',
    );
    // Explicitly non-group with unusual JID
    storeChatMetadata(
      'custom:abc',
      '2024-01-01T00:00:02.000Z',
      'Custom DM',
      'custom',
      false,
    );
    // A real group for contrast
    storeChatMetadata(
      'tg:100',
      '2024-01-01T00:00:03.000Z',
      'Group',
      'telegram',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('tg:100');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});
