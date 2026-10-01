/**
 * "One line per turn" for the official chat page. DSH's compact transcript already folds a finished turn's
 * reasoning, tool calls and in-turn context into one control row; what stays outside that group is the
 * system-prompt row and the context rows placed before the opening user message (memory recall, time
 * snapshots). This preference hides those rows too, by a data attribute on <html> that styles.css matches.
 * It is per browser (localStorage), and the rows remain readable in the Trajectory view.
 */
export const CHAT_FOLD_KEY = 'nexus.chatFold';
export const CHAT_FOLD_ATTRIBUTE = 'data-nexus-chat-fold';

export function readChatFold(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): boolean {
  try { return storage?.getItem(CHAT_FOLD_KEY) !== 'off'; } catch { return true; }
}

export function writeChatFold(value: boolean, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  try { storage?.setItem(CHAT_FOLD_KEY, value ? 'on' : 'off'); } catch { /* private mode or quota: the attribute still applies for this page */ }
}

export function applyChatFold(value: boolean, root: Element | undefined = safeRoot()): void {
  root?.setAttribute(CHAT_FOLD_ATTRIBUTE, value ? 'on' : 'off');
}

function safeStorage(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; }
}

function safeRoot(): Element | undefined {
  return typeof document === 'undefined' ? undefined : document.documentElement;
}
