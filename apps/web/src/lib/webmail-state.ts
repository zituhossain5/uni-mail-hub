export function unseenChange(wasSeen: boolean, isSeen: boolean): number {
  return Number(!isSeen) - Number(!wasSeen);
}

/** A paged conversation cannot be declared read when older messages are unknown. */
export function conversationFlags(items: { isSeen: boolean; isFlagged: boolean }[], hasEarlier: boolean) {
  return {
    unread: items.some(item => !item.isSeen) ? true : hasEarlier ? null : false,
    flagged: items.some(item => item.isFlagged) ? true : hasEarlier ? null : false,
  };
}

export function plainTextLines(body: string) {
  const lines = body.split('\n');
  return lines.map((line, index) => ({ text: line + (index < lines.length - 1 ? '\n' : ''), quoted: /^\s*>/.test(line) }));
}
