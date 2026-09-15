export function campaignSendAvailability(input: {
  eligibleCount: number;
  selectedCount: number;
  outboundEnabled: boolean;
  outboundReason?: string | null;
}): { canSend: boolean; reason: string | null } {
  if (input.eligibleCount <= 0 || input.selectedCount <= 0) {
    return { canSend: false, reason: "No eligible recipients are available to send" };
  }
  if (!input.outboundEnabled) {
    return { canSend: false, reason: input.outboundReason ?? "Outbound capability is unavailable" };
  }
  return { canSend: true, reason: null };
}
