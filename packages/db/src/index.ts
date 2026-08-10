export * from "@prisma/client";
import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __affiliatePrisma: PrismaClient | undefined;
}

export const prisma = globalThis.__affiliatePrisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalThis.__affiliatePrisma = prisma;

/**
 * Serialize eligibility-affecting work for one creator without blocking other
 * creators in the same shop. Call this only inside a database transaction.
 * Sorting is required when a transaction touches multiple creators so two
 * campaign freezes cannot deadlock by taking the same locks in a different order.
 */
export async function lockCreatorEligibility(
  tx: import("@prisma/client").Prisma.TransactionClient,
  shopId: string,
  creatorIds: Iterable<string>
): Promise<void> {
  for (const creatorId of [...new Set(creatorIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`eligibility-shop:${shopId}`}), hashtext(${`creator:${creatorId}`}))`;
  }
}
