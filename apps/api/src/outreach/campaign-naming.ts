import type { Prisma } from "@affiliate/db";

export const CAMPAIGN_NAME_TIME_ZONE = "Asia/Jakarta";

export function campaignDateKeyWib(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CAMPAIGN_NAME_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}${value("month")}${value("day")}`;
}

export async function allocateCampaignName(
  tx: Pick<Prisma.TransactionClient, "$executeRaw" | "campaign">,
  now: Date = new Date()
): Promise<string> {
  const dateKey = campaignDateKeyWib(now);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`outreach-campaign-name:${dateKey}`}))`;
  const names = await tx.campaign.findMany({
    where: { name: { startsWith: `${dateKey}_` } },
    select: { name: true }
  });
  const exactName = new RegExp(`^${dateKey}_(\\d+)$`);
  const highest = names.reduce((maximum, campaign) => {
    const match = exactName.exec(campaign.name);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0);
  return `${dateKey}_${String(highest + 1).padStart(3, "0")}`;
}
