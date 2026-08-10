export type TerminalRecipientState = "SENT" | "FAILED" | "DELIVERY_UNKNOWN_UNRESOLVED" | "CANCELLED" | string;

export function campaignCompletionSummary(states: TerminalRecipientState[]) {
  const sent = states.filter((state) => state === "SENT").length;
  const failed = states.filter((state) => state === "FAILED").length;
  const safetyCancelled = states.filter((state) => state === "CANCELLED").length;
  const unresolved = states.filter((state) => state === "DELIVERY_UNKNOWN_UNRESOLVED").length;
  const otherTerminal = states.length - sent - failed - safetyCancelled - unresolved;
  const completedSuccessfully = states.length > 0 && sent === states.length;
  return { completedSuccessfully, sent, failed, safetyCancelled, unresolved, otherTerminal, terminalRecipients: states.length };
}
