import { createHmac, randomBytes } from 'node:crypto';
import { safeText, fail } from './safety.mjs';

// A public cursor must not provide a dictionary verifier for redacted secrets.
// Keep the evidence key process-local, like the cursor signing key.
const evidenceKey = randomBytes(32);

export function messageText(item) {
  if (item.type === 'agentMessage') return typeof item.text === 'string' ? item.text : '';
  return Array.isArray(item.content) ? item.content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';
}

export function messageFingerprint(messages, nextCursor) {
  return createHmac('sha256', evidenceKey).update(JSON.stringify([messages.map(({ item, turnId }) =>
    [turnId, item.id, item.type, item.phase ?? null, messageText(item)]), nextCursor])).digest('hex');
}

// Redact the entire message before splitting; a cursor can never select the
// unlabelled tail of a credential. Budget both text characters and JSON bytes.
export function messagePage(messages, { index = 0, offset = 0, maxChars }) {
  return paginateMessages(messages, { index, offset, maxChars }, true);
}

// Only for structured data whose individual fields have already been sanitized.
// Redacting serialized JSON as prose can consume its quotes and corrupt it.
export function sanitizedMessagePage(messages, options) {
  return paginateMessages(messages, options, false);
}

function paginateMessages(messages, { index = 0, offset = 0, maxChars }, redact) {
  if (!Number.isSafeInteger(index) || index < 0 || (index >= messages.length && (index !== 0 || offset !== 0)) ||
      !Number.isSafeInteger(offset) || offset < 0) fail('INVALID_CURSOR');
  const entries = []; let remaining = maxChars, bytesLeft = 22000;
  for (; index < messages.length && entries.length < 100; index++) {
    const { item, turnId } = messages[index];
    const clean = redact ? safeText(messageText(item), Infinity) : { text: messageText(item), redacted: false };
    if (offset > clean.text.length) fail('INVALID_CURSOR');
    if (!remaining && clean.text.length > offset) break;
    const base = { itemId: item.id, turnId, role: item.type === 'agentMessage' ? 'assistant' : 'user',
      ...(item.type === 'agentMessage' ? { phase: ['commentary', 'final_answer'].includes(item.phase) ? item.phase : null } : {}),
      textOffset: offset, totalTextChars: clean.text.length, redacted: clean.redacted };
    const make = length => ({ ...base, text: clean.text.slice(offset, offset + length), truncated: offset + length < clean.text.length });
    let length = Math.min(remaining, clean.text.length - offset);
    let entry = make(length);
    if (Buffer.byteLength(JSON.stringify(entry)) + 1 > bytesLeft) {
      let low = 0, high = length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(JSON.stringify(make(mid))) + 1 <= bytesLeft) low = mid; else high = mid - 1;
      }
      length = low; entry = make(length);
      if ((!length && clean.text.length > offset) || Buffer.byteLength(JSON.stringify(entry)) + 1 > bytesLeft) break;
    }
    entries.push(entry); remaining -= length; bytesLeft -= Buffer.byteLength(JSON.stringify(entry)) + 1;
    offset += length;
    if (offset < clean.text.length) break;
    offset = 0;
  }
  return { entries, continuation: index < messages.length ? { index, offset } : null };
}

export function latestAssistantExcerpt(items, limit = 3000) {
  const item = [...(items ?? [])].reverse().find(item => item.type === 'agentMessage' && typeof item.text === 'string' && item.text.length);
  const text = safeText(item?.text ?? '', limit);
  return { assistantText: text.text, assistantMessageId: item?.id ?? null,
    assistantTextPhase: ['commentary', 'final_answer'].includes(item?.phase) ? item.phase : null,
    assistantTextTruncated: text.truncated, assistantTextRedacted: text.redacted };
}
