export type TerminalRecipientState = "SENT" | "FAILED" | "DELIVERY_UNKNOWN_UNRESOLVED" | "CANCELLED" | string;
export const TERMINAL_RECIPIENT_STATES = ["SENT", "RESTRICTED", "FAILED", "DELIVERY_UNKNOWN_UNRESOLVED", "CANCELLED"] as const;

export function allFrozenRecipientsTerminal(states: TerminalRecipientState[]): boolean {
  const terminal = new Set<string>(TERMINAL_RECIPIENT_STATES);
  return states.length > 0 && states.every((state) => terminal.has(state));
}

export function campaignCompletionSummary(states: TerminalRecipientState[]) {
  const sent = states.filter((state) => state === "SENT").length;
  const failed = states.filter((state) => state === "FAILED").length;
  const restricted = states.filter((state) => state === "RESTRICTED").length;
  const safetyCancelled = states.filter((state) => state === "CANCELLED").length;
  const unresolved = states.filter((state) => state === "DELIVERY_UNKNOWN_UNRESOLVED").length;
  const otherTerminal = states.length - sent - failed - restricted - safetyCancelled - unresolved;
  const completedSuccessfully = states.length > 0 && sent === states.length;
  return { completedSuccessfully, sent, restricted, failed, safetyCancelled, unresolved, otherTerminal, terminalRecipients: states.length };
}
