import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  deleteTask,
  getAllChats,
  getLatestMessage,
  getMessageFromMe,
  getMessagesByReaction,
  getMessagesSince,
  getNewMessages,
  getReactionsForMessage,
  getReactionsByUser,
  getReactionStats,
  getTaskById,
  storeChatMetadata,
  storeMessage,
  storeReaction,
  updateTask,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('tg:100', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'tg:100',
      sender: 'tg:123',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'tg:100',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('tg:123');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('tg:100', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'tg:100',
      sender: 'tg:111',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'tg:100',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('tg:100', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'tg:100',
      sender: 'tg:1',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'tg:100',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('tg:100', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'tg:100',
      sender: 'tg:123',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'tg:100',
      sender: 'tg:123',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'tg:100',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('tg:100', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'tg:100',
      sender: 'tg:10',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'tg:100',
      sender: 'tg:11',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'tg:100',
      sender: 'tg:12',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'tg:100',
      sender: 'tg:13',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'tg:100',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'tg:100',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('tg:100', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'tg:100',
      sender: 'tg:12',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'tg:100',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('tg:101', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('tg:102', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'tg:101',
      sender: 'tg:50',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'tg:102',
      sender: 'tg:50',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'tg:101',
      sender: 'tg:50',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'tg:101',
      sender: 'tg:50',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['tg:101', 'tg:102'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['tg:101', 'tg:102'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('tg:100', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('tg:100');
    expect(chats[0].name).toBe('tg:100');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('tg:100', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('tg:100', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('tg:100', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('tg:100', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('tg:100', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'tg:100',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'tg:100',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'tg:100',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- getLatestMessage ---

describe('getLatestMessage', () => {
  it('returns the most recent message for a chat', () => {
    storeChatMetadata('tg:100', '2024-01-01T00:00:00.000Z');
    store({
      id: 'old',
      chat_jid: 'tg:100',
      sender: 'tg:60',
      sender_name: 'A',
      content: 'old',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'new',
      chat_jid: 'tg:100',
      sender: 'tg:61',
      sender_name: 'B',
      content: 'new',
      timestamp: '2024-01-01T00:00:02.000Z',
    });

    const latest = getLatestMessage('tg:100');
    expect(latest).toEqual({ id: 'new', fromMe: false });
  });

  it('returns fromMe: true for own messages', () => {
    storeChatMetadata('tg:100', '2024-01-01T00:00:00.000Z');
    store({
      id: 'mine',
      chat_jid: 'tg:100',
      sender: 'tg:1',
      sender_name: 'Me',
      content: 'my msg',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: true,
    });

    const latest = getLatestMessage('tg:100');
    expect(latest).toEqual({ id: 'mine', fromMe: true });
  });

  it('returns undefined for empty chat', () => {
    expect(getLatestMessage('tg:999')).toBeUndefined();
  });
});

// --- getMessageFromMe ---

describe('getMessageFromMe', () => {
  it('returns true for own messages', () => {
    storeChatMetadata('tg:100', '2024-01-01T00:00:00.000Z');
    store({
      id: 'mine',
      chat_jid: 'tg:100',
      sender: 'tg:1',
      sender_name: 'Me',
      content: 'my msg',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: true,
    });

    expect(getMessageFromMe('mine', 'tg:100')).toBe(true);
  });

  it('returns false for other messages', () => {
    storeChatMetadata('tg:100', '2024-01-01T00:00:00.000Z');
    store({
      id: 'theirs',
      chat_jid: 'tg:100',
      sender: 'tg:60',
      sender_name: 'A',
      content: 'their msg',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    expect(getMessageFromMe('theirs', 'tg:100')).toBe(false);
  });

  it('returns false for nonexistent message', () => {
    expect(getMessageFromMe('nonexistent', 'tg:100')).toBe(false);
  });
});

// --- storeReaction ---

describe('storeReaction', () => {
  it('stores and retrieves a reaction', () => {
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'tg:100',
      reactor_jid: 'tg:50',
      reactor_name: 'Alice',
      emoji: '👍',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const reactions = getReactionsForMessage('msg-1', 'tg:100');
    expect(reactions).toHaveLength(1);
    expect(reactions[0].emoji).toBe('👍');
    expect(reactions[0].reactor_name).toBe('Alice');
  });

  it('upserts on same reactor + message', () => {
    const base = {
      message_id: 'msg-1',
      message_chat_jid: 'tg:100',
      reactor_jid: 'tg:50',
      reactor_name: 'Alice',
      timestamp: '2024-01-01T00:00:01.000Z',
    };
    storeReaction({ ...base, emoji: '👍' });
    storeReaction({
      ...base,
      emoji: '❤️',
      timestamp: '2024-01-01T00:00:02.000Z',
    });

    const reactions = getReactionsForMessage('msg-1', 'tg:100');
    expect(reactions).toHaveLength(1);
    expect(reactions[0].emoji).toBe('❤️');
  });

  it('removes reaction when emoji is empty', () => {
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'tg:100',
      reactor_jid: 'tg:50',
      emoji: '👍',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'tg:100',
      reactor_jid: 'tg:50',
      emoji: '',
      timestamp: '2024-01-01T00:00:02.000Z',
    });

    expect(getReactionsForMessage('msg-1', 'tg:100')).toHaveLength(0);
  });
});

// --- getReactionsForMessage ---

describe('getReactionsForMessage', () => {
  it('returns multiple reactions ordered by timestamp', () => {
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'tg:100',
      reactor_jid: 'tg:61',
      emoji: '❤️',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'tg:100',
      reactor_jid: 'tg:60',
      emoji: '👍',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const reactions = getReactionsForMessage('msg-1', 'tg:100');
    expect(reactions).toHaveLength(2);
    expect(reactions[0].reactor_jid).toBe('tg:60');
    expect(reactions[1].reactor_jid).toBe('tg:61');
  });

  it('returns empty array for message with no reactions', () => {
    expect(getReactionsForMessage('nonexistent', 'tg:100')).toEqual([]);
  });
});

// --- getMessagesByReaction ---

describe('getMessagesByReaction', () => {
  beforeEach(() => {
    storeChatMetadata('tg:100', '2024-01-01T00:00:00.000Z');
    store({
      id: 'msg-1',
      chat_jid: 'tg:100',
      sender: 'tg:70',
      sender_name: 'Author',
      content: 'bookmarked msg',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'tg:100',
      reactor_jid: 'tg:50',
      emoji: '📌',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
  });

  it('joins reactions with messages', () => {
    const results = getMessagesByReaction('tg:50', '📌');
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('bookmarked msg');
    expect(results[0].sender_name).toBe('Author');
  });

  it('filters by chatJid when provided', () => {
    const results = getMessagesByReaction(
      'tg:50',
      '📌',
      'tg:100',
    );
    expect(results).toHaveLength(1);

    const empty = getMessagesByReaction(
      'tg:50',
      '📌',
      'tg:200',
    );
    expect(empty).toHaveLength(0);
  });

  it('returns empty when no matching reactions', () => {
    expect(getMessagesByReaction('tg:50', '🔥')).toHaveLength(0);
  });
});

// --- getReactionsByUser ---

describe('getReactionsByUser', () => {
  it('returns reactions for a user ordered by timestamp desc', () => {
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'tg:100',
      reactor_jid: 'tg:50',
      emoji: '👍',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    storeReaction({
      message_id: 'msg-2',
      message_chat_jid: 'tg:100',
      reactor_jid: 'tg:50',
      emoji: '❤️',
      timestamp: '2024-01-01T00:00:02.000Z',
    });

    const reactions = getReactionsByUser('tg:50');
    expect(reactions).toHaveLength(2);
    expect(reactions[0].emoji).toBe('❤️'); // newer first
    expect(reactions[1].emoji).toBe('👍');
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      storeReaction({
        message_id: `msg-${i}`,
        message_chat_jid: 'tg:100',
        reactor_jid: 'tg:50',
        emoji: '👍',
        timestamp: `2024-01-01T00:00:0${i}.000Z`,
      });
    }

    expect(getReactionsByUser('tg:50', 3)).toHaveLength(3);
  });

  it('returns empty for user with no reactions', () => {
    expect(getReactionsByUser('tg:999')).toEqual([]);
  });
});

// --- getReactionStats ---

describe('getReactionStats', () => {
  beforeEach(() => {
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'tg:100',
      reactor_jid: 'tg:60',
      emoji: '👍',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    storeReaction({
      message_id: 'msg-2',
      message_chat_jid: 'tg:100',
      reactor_jid: 'tg:61',
      emoji: '👍',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'tg:100',
      reactor_jid: 'tg:62',
      emoji: '❤️',
      timestamp: '2024-01-01T00:00:03.000Z',
    });
    storeReaction({
      message_id: 'msg-1',
      message_chat_jid: 'tg:200',
      reactor_jid: 'tg:60',
      emoji: '🔥',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns global stats ordered by count desc', () => {
    const stats = getReactionStats();
    expect(stats[0]).toEqual({ emoji: '👍', count: 2 });
    expect(stats).toHaveLength(3);
  });

  it('filters by chatJid', () => {
    const stats = getReactionStats('tg:100');
    expect(stats).toHaveLength(2);
    expect(stats.find((s) => s.emoji === '🔥')).toBeUndefined();
  });

  it('returns empty for chat with no reactions', () => {
    expect(getReactionStats('tg:300')).toEqual([]);
  });
});
