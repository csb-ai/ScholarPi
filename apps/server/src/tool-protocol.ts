// A provider can occasionally stream an empty tool-call placeholder.
// Keep the raw session unchanged; omit invalid protocol entries from the next
// model context instead of inventing a tool name or matching identifier.
export function repairToolProtocol<T extends { role: string; content?: unknown; toolCallId?: string }>(messages: T[]) {
  let removed = 0;
  const safe = messages.flatMap(message => {
    if (message.role === 'toolResult' && !message.toolCallId?.trim()) {
      removed++;
      return [];
    }
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return [message];
    const content = message.content.filter(block => {
      if (block.type !== 'toolCall' || (block.id?.trim() && block.name?.trim())) return true;
      removed++;
      return false;
    });
    if (content.length === message.content.length) return [message];
    return content.length ? [{ ...message, content }] : [];
  });
  return { messages: safe, removed };
}
