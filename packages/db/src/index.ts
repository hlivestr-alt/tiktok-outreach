export * from "@prisma/client";
import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __affiliatePrisma: PrismaClient | undefined;
}

export const prisma = globalThis.__affiliatePrisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalThis.__affiliatePrisma = prisma;

