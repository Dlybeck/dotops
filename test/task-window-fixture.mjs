// Legacy fixture helper: windows no longer exist in the product.
export async function openTestWindow() { return { windowId: undefined }; }
export async function taskSend(adapter, raw) {
  const { deadlineSeconds, windowId, ...args } = raw;
  return adapter.call('codex_chat_send', args);
}
