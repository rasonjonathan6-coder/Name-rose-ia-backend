import { describe, expect, it } from 'vitest';
import { AutomationStateMachine, STATE_LABELS } from '@/core/automation/state-machine';
import type { GuardInput } from '@/core/automation/state-machine';

const ALLOW: GuardInput = {
  contentAllowed: true,
  rateAllowed: true,
  cooldownReady: true,
  policyAllowed: true,
};

function machine(mode: 'manual' | 'assisted' | 'auto' = 'manual') {
  return new AutomationStateMachine({ mode });
}

describe('AutomationStateMachine — modes', () => {
  it('starts idle in the given mode', () => {
    const m = machine('assisted');
    expect(m.current).toBe('idle');
    expect(m.currentMode).toBe('assisted');
  });

  it('manual mode: insert moves to inserting but never schedules a send', () => {
    const m = machine('manual');
    m.dispatch({ type: 'message', conversationId: 'c1' }, ALLOW);
    m.dispatch({ type: 'generation-succeeded', conversationId: 'c1' });

    const insert = m.dispatch({ type: 'insert', conversationId: 'c1' }, ALLOW);
    expect(insert.action).toBe('insert');

    const inserted = m.dispatch({ type: 'inserted', conversationId: 'c1' }, ALLOW);
    expect(inserted.state).toBe('ready');
    expect(inserted.action).toBe('none');
  });

  it('assisted mode: insert leads to awaiting-confirm, never to a send', () => {
    const m = machine('assisted');
    m.dispatch({ type: 'message', conversationId: 'c1' }, ALLOW);
    m.dispatch({ type: 'generation-succeeded', conversationId: 'c1' });
    m.dispatch({ type: 'insert', conversationId: 'c1' }, ALLOW);

    const res = m.dispatch({ type: 'inserted', conversationId: 'c1' }, ALLOW);
    expect(res.state).toBe('awaiting-confirm');
    expect(res.action).not.toBe('send');
  });

  it('auto mode: insert schedules a delayed send', () => {
    const m = machine('auto');
    m.dispatch({ type: 'message', conversationId: 'c1' }, ALLOW);
    m.dispatch({ type: 'generation-succeeded', conversationId: 'c1' });
    m.dispatch({ type: 'insert', conversationId: 'c1' }, ALLOW);

    const res = m.dispatch({ type: 'inserted', conversationId: 'c1' }, ALLOW);
    expect(res.state).toBe('waiting-delay');
    expect(res.action).toBe('schedule-send');
  });

  it('auto mode: delay elapsed triggers the send', () => {
    const m = machine('auto');
    m.dispatch({ type: 'message', conversationId: 'c1' }, ALLOW);
    m.dispatch({ type: 'generation-succeeded', conversationId: 'c1' });
    m.dispatch({ type: 'insert', conversationId: 'c1' }, ALLOW);
    m.dispatch({ type: 'inserted', conversationId: 'c1' }, ALLOW);

    const res = m.dispatch({ type: 'delay-elapsed', conversationId: 'c1' }, ALLOW);
    expect(res.state).toBe('sending');
    expect(res.action).toBe('send');
  });
});

describe('AutomationStateMachine — safety gates', () => {
  it('refuses to schedule a send when content is blocked', () => {
    const m = machine('auto');
    m.dispatch({ type: 'message', conversationId: 'c1' }, ALLOW);
    m.dispatch({ type: 'generation-succeeded', conversationId: 'c1' });
    m.dispatch({ type: 'insert', conversationId: 'c1' }, ALLOW);

    const res = m.dispatch(
      { type: 'inserted', conversationId: 'c1' },
      { ...ALLOW, contentAllowed: false, contentReason: 'asks for money' },
    );
    expect(res.state).toBe('awaiting-confirm');
    expect(res.reason).toContain('money');
  });

  it('refuses the send when the hourly rate limit is reached', () => {
    const m = machine('auto');
    m.dispatch({ type: 'message', conversationId: 'c1' }, ALLOW);
    m.dispatch({ type: 'generation-succeeded', conversationId: 'c1' });
    m.dispatch({ type: 'insert', conversationId: 'c1' }, ALLOW);

    const res = m.dispatch({ type: 'inserted', conversationId: 'c1' }, { ...ALLOW, rateAllowed: false });
    expect(res.state).toBe('awaiting-confirm');
    expect(res.reason).toContain('limit');
  });

  it('refuses the send when the cooldown has not elapsed', () => {
    const m = machine('auto');
    m.dispatch({ type: 'message', conversationId: 'c1' }, ALLOW);
    m.dispatch({ type: 'generation-succeeded', conversationId: 'c1' });
    m.dispatch({ type: 'insert', conversationId: 'c1' }, ALLOW);

    const res = m.dispatch({ type: 'inserted', conversationId: 'c1' }, { ...ALLOW, cooldownReady: false });
    expect(res.state).toBe('awaiting-confirm');
    expect(res.reason).toContain('delay');
  });

  it('re-checks the gates when the delay elapses', () => {
    const m = machine('auto');
    m.dispatch({ type: 'message', conversationId: 'c1' }, ALLOW);
    m.dispatch({ type: 'generation-succeeded', conversationId: 'c1' });
    m.dispatch({ type: 'insert', conversationId: 'c1' }, ALLOW);
    m.dispatch({ type: 'inserted', conversationId: 'c1' }, ALLOW);

    // Content was fine when inserted but is blocked by the time we send.
    const res = m.dispatch(
      { type: 'delay-elapsed', conversationId: 'c1' },
      { ...ALLOW, contentAllowed: false, contentReason: 'blocked at send time' },
    );
    expect(res.state).toBe('awaiting-confirm');
    expect(res.action).not.toBe('send');
  });

  it('never generates when the policy check fails', () => {
    const m = machine('auto');
    const res = m.dispatch(
      { type: 'message', conversationId: 'c1' },
      { ...ALLOW, policyAllowed: false, policyReason: 'no API key' },
    );
    expect(res.state).toBe('error');
    expect(res.action).toBe('none');
    expect(m.error).toBe('no API key');
  });
});

describe('AutomationStateMachine — stop is absolute', () => {
  it('stop halts from any state', () => {
    for (const mode of ['manual', 'assisted', 'auto'] as const) {
      const m = machine(mode);
      m.dispatch({ type: 'message', conversationId: 'c1' }, ALLOW);
      m.dispatch({ type: 'generation-succeeded', conversationId: 'c1' });
      const res = m.dispatch({ type: 'stop' });
      expect(res.state).toBe('stopped');
      expect(m.isStopped).toBe(true);
    }
  });

  it('a stopped machine ignores new messages and send events', () => {
    const m = machine('auto');
    m.dispatch({ type: 'stop' });

    expect(m.dispatch({ type: 'message', conversationId: 'c1' }, ALLOW).action).toBe('none');
    expect(m.dispatch({ type: 'send', conversationId: 'c1' }, ALLOW).action).toBe('none');
    expect(m.dispatch({ type: 'delay-elapsed', conversationId: 'c1' }, ALLOW).action).toBe('none');
    expect(m.current).toBe('stopped');
  });

  it('only an explicit arm clears the stopped state', () => {
    const m = machine('auto');
    m.dispatch({ type: 'stop' });
    m.dispatch({ type: 'resume' });
    expect(m.current).toBe('stopped');

    m.dispatch({ type: 'arm' });
    expect(m.current).toBe('idle');
    expect(m.isStopped).toBe(false);
  });

  it('a pending auto-send is cancelled when the mode leaves auto', () => {
    const m = machine('auto');
    m.dispatch({ type: 'message', conversationId: 'c1' }, ALLOW);
    m.dispatch({ type: 'generation-succeeded', conversationId: 'c1' });
    m.dispatch({ type: 'insert', conversationId: 'c1' }, ALLOW);
    m.dispatch({ type: 'inserted', conversationId: 'c1' }, ALLOW);
    expect(m.current).toBe('waiting-delay');

    const res = m.dispatch({ type: 'mode-changed', mode: 'assisted' });
    expect(res.state).toBe('ready');
    expect(res.reason).toContain('cancelled');
  });

  it('a pending auto-send is cancelled when the conversation changes', () => {
    const m = machine('auto');
    m.dispatch({ type: 'message', conversationId: 'c1' }, ALLOW);
    m.dispatch({ type: 'generation-succeeded', conversationId: 'c1' });
    m.dispatch({ type: 'insert', conversationId: 'c1' }, ALLOW);
    m.dispatch({ type: 'inserted', conversationId: 'c1' }, ALLOW);

    const res = m.dispatch({ type: 'conversation-changed', conversationId: 'c2' });
    expect(res.state).toBe('idle');
  });

  it('pause blocks generation and resume restores it', () => {
    const m = machine('auto');
    m.dispatch({ type: 'pause' });
    expect(m.dispatch({ type: 'message', conversationId: 'c1' }, ALLOW).action).toBe('none');

    m.dispatch({ type: 'resume' });
    expect(m.dispatch({ type: 'message', conversationId: 'c1' }, ALLOW).action).toBe('generate');
  });

  it('does not start a second generation while one is in flight', () => {
    const m = machine('auto');
    m.dispatch({ type: 'message', conversationId: 'c1' }, ALLOW);
    const second = m.dispatch({ type: 'message', conversationId: 'c1' }, ALLOW);
    expect(second.action).toBe('none');
    expect(second.reason).toContain('already');
  });

  it('counts sends for the rate limiter', () => {
    const m = machine('auto');
    expect(m.totalSent).toBe(0);
    m.dispatch({ type: 'sent', conversationId: 'c1' });
    m.dispatch({ type: 'sent', conversationId: 'c1' });
    expect(m.totalSent).toBe(2);
  });
});

describe('AutomationStateMachine — applyConfig', () => {
  it('disabling automation stops the machine', () => {
    const m = machine('auto');
    m.applyConfig({
      mode: 'auto',
      globalEnabled: false,
      globalPaused: false,
      pausedPlatforms: [],
      pausedConversations: [],
      replyDelayMs: 4000,
      maxAutoMessagesPerHour: 20,
      inactivityMinutes: 10,
      followUpsEnabled: false,
      maxFollowUps: 1,
    });
    expect(m.current).toBe('stopped');
  });

  it('enabling automation arms a stopped machine', () => {
    const m = machine('auto');
    m.dispatch({ type: 'stop' });
    m.applyConfig({
      mode: 'assisted',
      globalEnabled: true,
      globalPaused: false,
      pausedPlatforms: [],
      pausedConversations: [],
      replyDelayMs: 4000,
      maxAutoMessagesPerHour: 20,
      inactivityMinutes: 10,
      followUpsEnabled: false,
      maxFollowUps: 1,
    });
    expect(m.current).toBe('idle');
    expect(m.currentMode).toBe('assisted');
  });
});

describe('STATE_LABELS', () => {
  it('labels every state, with STOPPED prominent', () => {
    expect(STATE_LABELS.stopped).toBe('STOPPED');
    for (const label of Object.values(STATE_LABELS)) expect(label).toBeTruthy();
  });
});
