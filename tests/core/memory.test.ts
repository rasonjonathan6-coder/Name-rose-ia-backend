import { beforeEach, describe, expect, it } from 'vitest';
import { ClientMemoryStore } from '@/core/memory/store';
import type { ConversationRef } from '@/shared/types';

const OPTS = { enabled: true, retentionDays: 90, maxRecentMessages: 4, autoSummarizeAfter: 3 };

function conv(overrides: Partial<ConversationRef> = {}): ConversationRef {
  return {
    id: 'generic:client-a',
    platform: 'generic',
    clientId: 'client-a',
    displayName: 'Alice',
    conversationId: 'conv-1',
    url: 'https://example.com/chat',
    language: null,
    ...overrides,
  };
}

function store(opts = OPTS) {
  return new ClientMemoryStore(() => opts);
}

describe('ClientMemoryStore — isolation', () => {
  it('creates a separate record per clientId', async () => {
    const s = store();
    const a = await s.getOrCreate(conv({ clientId: 'client-a', id: 'generic:client-a' }));
    const b = await s.getOrCreate(conv({ clientId: 'client-b', id: 'generic:client-b', displayName: 'Bob' }));

    await s.recordIncoming(conv({ clientId: 'client-a', id: 'generic:client-a' }), 'I am Alice', 'en');
    await s.recordIncoming(conv({ clientId: 'client-b', id: 'generic:client-b', displayName: 'Bob' }), 'I am Bob', 'en');

    expect(a.id).not.toBe(b.id);

    const aReloaded = await s.getOrCreate(conv({ clientId: 'client-a', id: 'generic:client-a' }));
    expect(aReloaded.recentMessages.map((m) => m.text)).toEqual(['I am Alice']);
    expect(aReloaded.recentMessages.map((m) => m.text)).not.toContain('I am Bob');
  });

  it('does NOT merge two clients that share a display name', async () => {
    const s = store();
    await s.recordIncoming(
      conv({ clientId: 'id-111', id: 'generic:id-111', displayName: 'Sophie' }),
      'first person',
      'en',
    );
    await s.recordIncoming(
      conv({ clientId: 'id-222', id: 'generic:id-222', displayName: 'Sophie' }),
      'second person',
      'en',
    );

    const one = await s.getOrCreate(conv({ clientId: 'id-111', id: 'generic:id-111', displayName: 'Sophie' }));
    const two = await s.getOrCreate(conv({ clientId: 'id-222', id: 'generic:id-222', displayName: 'Sophie' }));

    expect(one.recentMessages.map((m) => m.text)).toEqual(['first person']);
    expect(two.recentMessages.map((m) => m.text)).toEqual(['second person']);
  });

  it('isolates the same clientId across different platforms', async () => {
    const s = store();
    await s.recordIncoming(conv({ platform: 'coomeet', clientId: 'shared', id: 'coomeet:shared' }), 'on coomeet', 'en');
    await s.recordIncoming(conv({ platform: 'flirtify', clientId: 'shared', id: 'flirtify:shared' }), 'on flirtify', 'en');

    const coo = await s.getOrCreate(conv({ platform: 'coomeet', clientId: 'shared', id: 'coomeet:shared' }));
    const fli = await s.getOrCreate(conv({ platform: 'flirtify', clientId: 'shared', id: 'flirtify:shared' }));

    expect(coo.recentMessages[0]!.text).toBe('on coomeet');
    expect(fli.recentMessages[0]!.text).toBe('on flirtify');
  });

  it('keyOf is deterministic and platform-scoped', () => {
    expect(ClientMemoryStore.keyOf('coomeet', 'abc')).toBe('coomeet:abc');
    expect(ClientMemoryStore.keyOf('coomeet', 'abc')).not.toBe(ClientMemoryStore.keyOf('flirtify', 'abc'));
  });
});

describe('ClientMemoryStore — persistence', () => {
  it('recovers a client when they come back later', async () => {
    const s1 = store();
    await s1.recordIncoming(conv(), 'My name is Alice and I live in Lyon', 'en');
    await s1.recordOutgoing(conv(), 'Nice to meet you Alice!', 'en');

    // A fresh store simulates a new page load / service-worker restart.
    const s2 = store();
    const memory = await s2.getOrCreate(conv());
    expect(memory.recentMessages).toHaveLength(2);
    expect(memory.displayName).toBe('Alice');
    expect(memory.language).toBe('en');
  });

  it('returns a non-persisted empty record when memory is disabled', async () => {
    const s = store({ ...OPTS, enabled: false });
    const memory = await s.getOrCreate(conv());
    expect(memory.recentMessages).toHaveLength(0);
    expect(await s.list()).toHaveLength(0);
  });

  it('deletes a single record without touching others', async () => {
    const s = store();
    await s.recordIncoming(conv({ clientId: 'a', id: 'generic:a' }), 'from a', 'en');
    await s.recordIncoming(conv({ clientId: 'b', id: 'generic:b' }), 'from b', 'en');

    await s.clear('generic:a');
    const remaining = await s.list();
    expect(remaining.map((m) => m.id)).toEqual(['generic:b']);
  });

  it('clears all records', async () => {
    const s = store();
    await s.recordIncoming(conv({ clientId: 'a', id: 'generic:a' }), 'x', 'en');
    await s.recordIncoming(conv({ clientId: 'b', id: 'generic:b' }), 'y', 'en');
    await s.clearAll();
    expect(await s.list()).toHaveLength(0);
  });

  it('increments the message count', async () => {
    const s = store();
    for (let i = 0; i < 5; i++) await s.recordIncoming(conv(), `message ${i}`, 'en');
    const memory = await s.getOrCreate(conv());
    expect(memory.metadata.messageCount).toBe(5);
  });
});

describe('ClientMemoryStore — compression', () => {
  it('bounds the recent window to maxRecentMessages', async () => {
    const s = store();
    for (let i = 0; i < 10; i++) await s.recordIncoming(conv(), `distinct message number ${i}`, 'en');
    const memory = await s.getOrCreate(conv());
    expect(memory.recentMessages).toHaveLength(4);
    // The newest messages survive; the oldest are dropped from the raw window.
    expect(memory.recentMessages[3]!.text).toBe('distinct message number 9');
  });

  it('flags that a summary is needed once the window overflows', async () => {
    const s = store();
    let result = await s.recordIncoming(conv(), 'first', 'en');
    expect(result.needsSummary).toBe(false);
    for (let i = 0; i < 5; i++) result = await s.recordIncoming(conv(), `filler message ${i}`, 'en');
    expect(result.needsSummary).toBe(true);
  });

  it('applies a summary and shrinks the raw window', async () => {
    const s = store();
    for (let i = 0; i < 8; i++) await s.recordIncoming(conv(), `message ${i}`, 'en');
    const before = await s.getOrCreate(conv());
    const after = await s.applySummary(before, 'Alice is a nurse from Lyon who likes hiking.');
    expect(after.summary).toContain('nurse');
    expect(after.recentMessages.length).toBeLessThanOrEqual(4);
    expect(after.metadata.tokensSaved).toBe(1);
  });

  it('keeps the summary across a reload', async () => {
    const s = store();
    for (let i = 0; i < 8; i++) await s.recordIncoming(conv(), `message ${i}`, 'en');
    const before = await s.getOrCreate(conv());
    await s.applySummary(before, 'Durable summary text.');

    const s2 = store();
    const reloaded = await s2.getOrCreate(conv());
    expect(reloaded.summary).toBe('Durable summary text.');
  });

  it('collapses an immediate repeat instead of duplicating it', async () => {
    const s = store();
    await s.recordIncoming(conv(), 'Hello there my friend', 'en');
    await s.recordIncoming(conv(), 'Hello there my friend', 'en');
    const memory = await s.getOrCreate(conv());
    expect(memory.recentMessages).toHaveLength(1);
    expect(memory.metadata.messageCount).toBe(1);
  });
});

describe('ClientMemoryStore — facts', () => {
  it('merges new facts', async () => {
    const s = store();
    const memory = await s.getOrCreate(conv());
    const updated = await s.mergeFacts(memory, [
      { key: 'city', value: 'Lyon', weight: 0.6 },
      { key: 'job', value: 'nurse', weight: 0.5 },
    ]);
    expect(updated.importantFacts).toHaveLength(2);
  });

  it('reinforces a restated fact rather than duplicating it', async () => {
    const s = store();
    let memory = await s.getOrCreate(conv());
    memory = await s.mergeFacts(memory, [{ key: 'city', value: 'Lyon', weight: 0.5 }]);
    memory = await s.mergeFacts(memory, [{ key: 'city', value: 'Lyon', weight: 0.5 }]);

    expect(memory.importantFacts).toHaveLength(1);
    expect(memory.importantFacts[0]!.weight).toBeGreaterThan(0.5);
  });

  it('deduplicates facts with different keys but the same value', async () => {
    const s = store();
    let memory = await s.getOrCreate(conv());
    memory = await s.mergeFacts(memory, [{ key: 'city', value: 'Lyon', weight: 0.5 }]);
    memory = await s.mergeFacts(memory, [{ key: 'location', value: 'Lyon', weight: 0.5 }]);
    expect(memory.importantFacts).toHaveLength(1);
  });

  it('keeps the higher-weight value when a fact is restated with more detail', async () => {
    const s = store();
    let memory = await s.getOrCreate(conv());
    memory = await s.mergeFacts(memory, [{ key: 'job', value: 'nurse', weight: 0.5 }]);
    memory = await s.mergeFacts(memory, [{ key: 'job', value: 'nurse at the general hospital', weight: 0.6 }]);
    expect(memory.importantFacts[0]!.value).toContain('general hospital');
  });

  it('caps the fact list', async () => {
    const s = store();
    let memory = await s.getOrCreate(conv());
    const many = Array.from({ length: 60 }, (_, i) => ({ key: `k${i}`, value: `value number ${i}`, weight: 0.5 }));
    memory = await s.mergeFacts(memory, many);
    expect(memory.importantFacts.length).toBeLessThanOrEqual(40);
  });

  it('ignores empty fact values', async () => {
    const s = store();
    const memory = await s.getOrCreate(conv());
    const updated = await s.mergeFacts(memory, [{ key: 'x', value: '   ', weight: 0.5 }]);
    expect(updated.importantFacts).toHaveLength(0);
  });
});

describe('ClientMemoryStore — topics and context window', () => {
  it('extracts topics from client messages', async () => {
    const s = store();
    await s.recordIncoming(conv(), 'I really enjoy photography and travelling', 'en');
    const memory = await s.getOrCreate(conv());
    expect(memory.topics.length).toBeGreaterThan(0);
    expect(memory.topics.some((t) => t.includes('photography') || t.includes('travelling'))).toBe(true);
  });

  it('bounds the context window', async () => {
    const s = store();
    for (let i = 0; i < 4; i++) await s.recordIncoming(conv(), `message ${i}`, 'en');
    const memory = await s.getOrCreate(conv());
    expect(s.buildContextWindow(memory, 2)).toHaveLength(2);
  });
});
