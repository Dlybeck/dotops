import { z } from 'zod';
import { fail } from '../safety.mjs';
import { uuid } from './native.mjs';

const windowInput = z.object({
  requestId: uuid, threadId: uuid,
  deadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  confirmUserApproval: z.literal(true),
  approvalRef: z.string().trim().min(1).max(240),
}).strict();

export function validateWindows(state) {
  // Version-1 journals migrate additively. Old counters and deadlines stay intact.
  if (state.clockFloor !== undefined && (!Number.isSafeInteger(state.clockFloor) || state.clockFloor < 0)) fail('INVALID_STATE');
  state.taskWindows ??= {};
  if (!state.taskWindows || typeof state.taskWindows !== 'object' || Array.isArray(state.taskWindows)) fail('INVALID_STATE');
  for (const [id, window] of Object.entries(state.taskWindows)) {
    if (!uuid.safeParse(id).success || !windowInput.safeParse({ requestId: id, threadId: window?.threadId,
      deadlineAt: window?.deadlineAt, confirmUserApproval: window?.confirmUserApproval,
      approvalRef: window?.approvalRef }).success || !Number.isSafeInteger(window.startedAt) ||
      window.startedAt >= window.deadlineAt ||
      !state.threads[window.threadId]) fail('INVALID_STATE');
  }
  for (const thread of Object.values(state.threads)) if (thread.windowId && !state.taskWindows[thread.windowId]) fail('INVALID_STATE');
  for (const op of Object.values(state.operations)) if (op.kind === 'send' && op.windowId &&
    (!state.taskWindows[op.windowId] || state.taskWindows[op.windowId].threadId !== op.threadId ||
     state.taskWindows[op.windowId].deadlineAt !== op.deadlineAt)) fail('INVALID_STATE');
}
