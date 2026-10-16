'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ATTACHMENT_REFUSAL, planResumeNudge } = require('../../src/main/resume-nudge.js');

const typed = (content, extra = {}) => ({
  type: 'user',
  origin: { kind: 'human' },
  promptSource: 'typed',
  message: { role: 'user', content },
  ...extra,
});

test('an unanswered typed human tail plans exact redelivery', () => {
  const text = 'Please answer this exact question.\nKeep the second line.';
  assert.deepEqual(planResumeNudge([
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] } },
    typed(text),
  ]), { kind: 'redeliver', text });
});

test('a clean assistant end_turn keeps the plain resume nudge', () => {
  assert.deepEqual(planResumeNudge([
    typed('Already answered'),
    { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] } },
  ]), { kind: 'nudge' });
});

test('a trailing isMeta user record keeps the plain nudge and cannot loop', () => {
  assert.deepEqual(planResumeNudge([
    typed('Old unanswered question'),
    { type: 'user', isMeta: true, message: { role: 'user', content: 'Continue from where you left off.' } },
  ]), { kind: 'nudge' });
});

test('a long typed message is redelivered without truncation', () => {
  const text = `Start\n${'0123456789'.repeat(20000)}\nEnd`;
  assert.deepEqual(planResumeNudge([typed([{ type: 'text', text }])]), { kind: 'redeliver', text });
});

// Claude Code 2.1.300 writes a copy of each API request into the transcript
// (`api-request`, plus `api-request-blob` records carrying message objects
// whose role is user, assistant or system). A copy is not a conversation turn:
// a stored assistant message must not read as a reply, and a stored user one
// must not hide the typed message it copies (2026-10-15 CLI review).
test('a stored request copy is not a conversation turn', () => {
  const text = 'Typed just before the session died.';
  const blob = (role, content) => ({ type: 'api-request-blob', hash: `h-${role}`, message: { role, content } });
  assert.deepEqual(planResumeNudge([
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] } },
    typed(text),
    blob('user', [{ type: 'text', text }]),
    blob('system', 'Output style reminder'),
    { type: 'api-request', id: 'req-1', querySource: 'repl_main_thread' },
  ]), { kind: 'redeliver', text });
  assert.deepEqual(planResumeNudge([
    typed(text),
    blob('assistant', [{ type: 'text', text: 'A reply that was only ever sent, never received' }]),
  ]), { kind: 'redeliver', text });
});

test('an image-bearing message refuses honestly instead of sending a nudge', () => {
  assert.deepEqual(planResumeNudge([typed([
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
    { type: 'text', text: 'What is in this image?' },
  ])]), { kind: 'refuse', text: ATTACHMENT_REFUSAL });
});
