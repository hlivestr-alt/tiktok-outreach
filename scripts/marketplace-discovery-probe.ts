import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import type { CreatorCandidate } from "@affiliate/domain";
import {
  decryptTikTokToken,
  RealTikTokReadOnlyAffiliateAdapter,
  TikTokApiError,
  TikTokReadOnlyHttpClient,
  type TikTokDiagnostics
} from "@affiliate/tiktok-adapter/read-only";

export const MARKETPLACE_PATH = "/affiliate_seller/202508/marketplace_creators/search";
export const API_VERSION = "202508";
export const PAGE_SIZE = 20;
export const MIN_FOLLOWERS = 1000;
export const MAX_FOLLOWERS = 1500;
const MAX_OUTPUT_CREATORS = 20;

type ProbeMode = "SINGLE" | "PAGINATED";
type RequestMode = "NEW_SEARCH" | "CONTINUATION";

export type ProbeRequestInput = {
  page: number;
  pageSize: 20;
  searchKey?: string;
  pageToken?: string;
};

export type ProbeRequestDiagnostic = {
  timestamp: string;
  durationMs: number;
  httpStatus?: number;
  providerCode?: number;
  requestId?: string;
};

export type ProbeRequestSuccess = ProbeRequestDiagnostic & {
  creators: CreatorCandidate[];
  searchKey?: string;
  nextPageToken?: string;
};

export class ProbeRequestFailure extends Error {
  constructor(
    readonly diagnostic: ProbeRequestDiagnostic,
    message: string
  ) {
    super(message);
  }
}

export type ProbeRequest = (input: ProbeRequestInput) => Promise<ProbeRequestSuccess>;

export type RequestRecord = {
  page: number;
  requestMode: RequestMode;
  timestamp: string;
  durationMs: number;
  httpStatus?: number;
  providerCode?: number;
  requestId?: string;
  creatorsReturned: number;
  searchKeyPresent: boolean;
  pageTokenInputPresent: boolean;
  nextPageTokenPresent: boolean;
  localMatchingCount: number;
  totalUniqueMatches: number;
};

export type SanitizedCreator = {
  username?: string;
  nickname?: string;
  followerCount: number;
  gmv: { amount: string; currency: string } | null;
  categoryIds: string[];
};

export type ProbeResult = {
  mode: ProbeMode;
  target: number;
  maxPages: number;
  delayMs: number;
  stopReason: string;
  requests: RequestRecord[];
  matchedCreators: CreatorCandidate[];
};

export type ProbeOptions = {
  mode: ProbeMode;
  target: number;
  maxPages: number;
  delayMs: number;
};

export type ProbeDependencies = {
  request: ProbeRequest;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (line: string) => void;
};

export function matchesFollowerRange(creator: CreatorCandidate): boolean {
  return creator.followerCount != null
    && creator.followerCount >= MIN_FOLLOWERS
    && creator.followerCount <= MAX_FOLLOWERS;
}

export function sanitizeRequestId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const sanitized = value.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 128);
  return sanitized || undefined;
}

export function sanitizeMessage(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/\b[A-Za-z0-9_\-]{24,}\b/g, "[redacted-value]")
    .slice(0, 240);
}

export function sanitizeCreator(creator: CreatorCandidate): SanitizedCreator {
  return {
    username: creator.username,
    nickname: creator.nickname,
    followerCount: creator.followerCount!,
    gmv: creator.gmv,
    categoryIds: [...creator.categoryIds]
  };
}

function yesNo(value: boolean): "YES" | "NO" {
  return value ? "YES" : "NO";
}

export function formatRequestRecord(record: RequestRecord): string {
  return [
    `Page ${record.page}`,
    record.requestMode,
    `timestamp=${record.timestamp}`,
    `http=${record.httpStatus ?? "NA"}`,
    `code=${record.providerCode ?? "NA"}`,
    `request_id=${sanitizeRequestId(record.requestId) ?? "NA"}`,
    `duration=${record.durationMs}ms`,
    `returned=${record.creatorsReturned}`,
    `matches=${record.localMatchingCount}`,
    `totalMatches=${record.totalUniqueMatches}`,
    `searchKey=${yesNo(record.searchKeyPresent)}`,
    `pageTokenIn=${yesNo(record.pageTokenInputPresent)}`,
    `nextPageToken=${yesNo(record.nextPageTokenPresent)}`
  ].join(" | ");
}

function errorStopReason(error: ProbeRequestFailure, page: number): string {
  const { providerCode, httpStatus } = error.diagnostic;
  if (providerCode === 45101004) return `DAILY_QUOTA_REACHED_AT_PAGE_${page}`;
  if (providerCode === 36009002 || httpStatus === 429) return `THROTTLED_AT_PAGE_${page}`;
  return `PROVIDER_ERROR_AT_PAGE_${page}: ${sanitizeMessage(error.message)}`;
}

export async function runMarketplaceProbe(options: ProbeOptions, dependencies: ProbeDependencies): Promise<ProbeResult> {
  const log = dependencies.log ?? (() => undefined);
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const requests: RequestRecord[] = [];
  const matchedByOpenId = new Map<string, CreatorCandidate>();
  let stableSearchKey: string | undefined;
  let pageToken: string | undefined;
  let stopReason = options.mode === "SINGLE" ? "SINGLE_REQUEST_COMPLETE" : "MAX_PAGES_REACHED";

  const physicalPageLimit = options.mode === "SINGLE" ? 1 : options.maxPages;
  for (let page = 1; page <= physicalPageLimit; page++) {
    const requestMode: RequestMode = page === 1 ? "NEW_SEARCH" : "CONTINUATION";
    const input: ProbeRequestInput = {
      page,
      pageSize: PAGE_SIZE,
      searchKey: page === 1 ? undefined : stableSearchKey,
      pageToken: page === 1 ? undefined : pageToken
    };

    let response: ProbeRequestSuccess;
    try {
      response = await dependencies.request(input);
    } catch (caught) {
      const error = caught instanceof ProbeRequestFailure
        ? caught
        : new ProbeRequestFailure({ timestamp: new Date().toISOString(), durationMs: 0 }, "Unclassified request failure");
      const record: RequestRecord = {
        page,
        requestMode,
        ...error.diagnostic,
        requestId: sanitizeRequestId(error.diagnostic.requestId),
        creatorsReturned: 0,
        searchKeyPresent: Boolean(stableSearchKey),
        pageTokenInputPresent: Boolean(input.pageToken),
        nextPageTokenPresent: false,
        localMatchingCount: 0,
        totalUniqueMatches: matchedByOpenId.size
      };
      requests.push(record);
      log(formatRequestRecord(record));
      stopReason = errorStopReason(error, page);
      return { ...options, stopReason, requests, matchedCreators: [...matchedByOpenId.values()] };
    }

    if (page === 1) stableSearchKey = response.searchKey;
    let localMatchingCount = 0;
    for (const creator of response.creators) {
      if (!matchesFollowerRange(creator)) continue;
      localMatchingCount++;
      if (!matchedByOpenId.has(creator.creatorOpenId) && matchedByOpenId.size < options.target) {
        matchedByOpenId.set(creator.creatorOpenId, creator);
      }
    }

    const record: RequestRecord = {
      page,
      requestMode,
      timestamp: response.timestamp,
      durationMs: response.durationMs,
      httpStatus: response.httpStatus,
      providerCode: response.providerCode,
      requestId: sanitizeRequestId(response.requestId),
      creatorsReturned: response.creators.length,
      searchKeyPresent: Boolean(response.searchKey),
      pageTokenInputPresent: Boolean(input.pageToken),
      nextPageTokenPresent: Boolean(response.nextPageToken),
      localMatchingCount,
      totalUniqueMatches: matchedByOpenId.size
    };
    requests.push(record);
    log(formatRequestRecord(record));

    if (options.mode === "SINGLE") {
      stopReason = "SINGLE_REQUEST_COMPLETE";
      break;
    }
    if (matchedByOpenId.size >= options.target) {
      stopReason = "TARGET_REACHED";
      break;
    }
    if (page >= options.maxPages) {
      stopReason = "MAX_PAGES_REACHED";
      break;
    }
    if (!response.nextPageToken) {
      stopReason = "NEXT_PAGE_TOKEN_ABSENT";
      break;
    }
    if (!stableSearchKey) {
      stopReason = "SEARCH_KEY_ABSENT";
      break;
    }
    pageToken = response.nextPageToken;
    await sleep(options.delayMs);
  }

  return { ...options, stopReason, requests, matchedCreators: [...matchedByOpenId.values()] };
}

type CliOptions = ProbeOptions & { saveReport: boolean };

export function parseArguments(arguments_: string[]): CliOptions {
  let mode: ProbeMode | undefined;
  let target = 20;
  let maxPages = 12;
  let delayMs = 3000;
  let saveReport = false;
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === "--single") mode = "SINGLE";
    else if (argument === "--save-report") saveReport = true;
    else if (["--target", "--max-pages", "--delay-ms"].includes(argument)) {
      const value = Number(arguments_[++index]);
      if (!Number.isInteger(value) || value < (argument === "--delay-ms" ? 0 : 1)) throw new Error(`${argument} requires a valid integer`);
      if (argument === "--target") target = value;
      if (argument === "--max-pages") maxPages = value;
      if (argument === "--delay-ms") delayMs = value;
      mode ??= "PAGINATED";
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!mode) throw new Error("Choose --single or controlled pagination arguments");
  if (target > MAX_OUTPUT_CREATORS) throw new Error("--target cannot exceed 20 for this diagnostic");
  if (mode === "PAGINATED" && maxPages > 12) throw new Error("--max-pages cannot exceed the diagnostic ceiling of 12");
  if (mode === "PAGINATED" && delayMs < 3000) throw new Error("Controlled pagination requires --delay-ms of at least 3000");
  return { mode, target, maxPages, delayMs, saveReport };
}

type CredentialContext = {
  appKey: string;
  appSecret: string;
  accessToken: string;
  shopCipher: string;
  apiBaseUrl: string;
  matches: {
    appKey: boolean;
    appSecret: boolean;
    accessToken: boolean;
    shop: boolean;
    apiBase: boolean;
  };
};

function digest(value: string | undefined): string {
  return value ? createHash("sha256").update(value).digest("hex") : "MISSING";
}

function readOnlyDatabaseUrl(value: string): string {
  const url = new URL(value);
  url.searchParams.set("options", "-c default_transaction_read_only=on");
  return url.toString();
}

async function loadCredentialContext(environment: NodeJS.ProcessEnv): Promise<CredentialContext> {
  const appKey = environment.TIKTOK_APP_KEY ?? "";
  const appSecret = environment.TIKTOK_APP_SECRET ?? "";
  const encryptionKey = environment.TIKTOK_TOKEN_ENCRYPTION_KEY ?? "";
  const apiBaseUrl = environment.TIKTOK_API_BASE_URL ?? "https://open-api.tiktokglobalshop.com";
  const matches = {
    appKey: Boolean(appKey) && digest(appKey) === environment.PROBE_EXPECTED_APP_KEY_SHA256,
    appSecret: Boolean(appSecret) && digest(appSecret) === environment.PROBE_EXPECTED_APP_SECRET_SHA256,
    accessToken: false,
    shop: false,
    apiBase: Boolean(apiBaseUrl) && digest(apiBaseUrl) === environment.PROBE_EXPECTED_API_BASE_SHA256
  };
  let accessToken = "";
  let shopCipher = "";
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) return { appKey, appSecret, accessToken, shopCipher, apiBaseUrl, matches };

  const prisma = new PrismaClient({ datasources: { db: { url: readOnlyDatabaseUrl(databaseUrl) } } });
  try {
    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const shops = await transaction.shop.findMany({
        where: { connectionMode: "READ_ONLY", selectedForReadOnly: true },
        orderBy: { updatedAt: "desc" },
        take: 2,
        select: { id: true, name: true, shopCipher: true }
      });
      const shop = shops.length === 1 ? shops[0] : undefined;
      matches.shop = Boolean(shop?.shopCipher && /PROYA/i.test(shop.name));
      if (!shop?.shopCipher) return;
      shopCipher = shop.shopCipher;
      const connection = await transaction.integrationConnection.findUnique({
        where: { shopId_provider: { shopId: shop.id, provider: "TIKTOK_SHOP" } },
        select: {
          status: true,
          refreshState: true,
          accessTokenCiphertext: true,
          accessTokenExpiresAt: true
        }
      });
      const margin = Number(environment.TIKTOK_TOKEN_REFRESH_MARGIN_SECONDS ?? 1800) * 1000;
      const tokenReady = connection?.status === "HEALTHY"
        && connection.refreshState === "IDLE"
        && Boolean(connection.accessTokenCiphertext)
        && Boolean(connection.accessTokenExpiresAt)
        && connection.accessTokenExpiresAt!.getTime() > Date.now() + margin
        && digest(encryptionKey) === environment.PROBE_EXPECTED_TOKEN_KEY_SHA256;
      if (!tokenReady) return;
      try {
        accessToken = decryptTikTokToken(connection!.accessTokenCiphertext!, encryptionKey);
        matches.accessToken = Boolean(accessToken);
      } catch {
        matches.accessToken = false;
      }
    });
  } finally {
    await prisma.$disconnect();
  }
  return { appKey, appSecret, accessToken, shopCipher, apiBaseUrl, matches };
}

function printCredentialMatches(matches: CredentialContext["matches"]): void {
  console.log(`APP_KEY_CONTEXT_MATCH=${yesNo(matches.appKey)}`);
  console.log(`APP_SECRET_CONTEXT_MATCH=${yesNo(matches.appSecret)}`);
  console.log(`ACCESS_TOKEN_CONTEXT_MATCH=${yesNo(matches.accessToken)}`);
  console.log(`SHOP_CONTEXT_MATCH=${yesNo(matches.shop)}`);
  console.log(`API_BASE_MATCH=${yesNo(matches.apiBase)}`);
}

function createLiveRequester(credentials: CredentialContext): ProbeRequest {
  const captured: { latest?: TikTokDiagnostics } = {};
  const http = new TikTokReadOnlyHttpClient({
    baseUrl: credentials.apiBaseUrl,
    appKey: credentials.appKey,
    appSecret: credentials.appSecret,
    automaticRetries: false,
    diagnostics: (diagnostic) => { captured.latest = diagnostic; }
  });
  const adapter = new RealTikTokReadOnlyAffiliateAdapter({
    http,
    accessToken: async () => credentials.accessToken,
    shopCipher: async () => credentials.shopCipher
  });
  return async (input) => {
    captured.latest = undefined;
    const startedAt = Date.now();
    const timestamp = new Date(startedAt).toISOString();
    try {
      const page = await adapter.searchCreators({}, {
        pageSize: input.pageSize,
        searchKey: input.searchKey,
        pageToken: input.pageToken
      });
      const diagnostic = captured.latest as TikTokDiagnostics | undefined;
      return {
        creators: page.creators,
        searchKey: page.searchKey || undefined,
        nextPageToken: page.nextPageToken,
        timestamp: diagnostic?.timestamp ?? timestamp,
        durationMs: diagnostic?.durationMs ?? Date.now() - startedAt,
        httpStatus: diagnostic?.httpStatus,
        providerCode: diagnostic?.providerCode,
        requestId: diagnostic?.requestId
      };
    } catch (caught) {
      const error = caught instanceof TikTokApiError ? caught : undefined;
      const diagnostic = captured.latest as TikTokDiagnostics | undefined;
      throw new ProbeRequestFailure({
        timestamp: diagnostic?.timestamp ?? timestamp,
        durationMs: diagnostic?.durationMs ?? Date.now() - startedAt,
        httpStatus: diagnostic?.httpStatus ?? error?.httpStatus,
        providerCode: diagnostic?.providerCode ?? error?.providerCode,
        requestId: diagnostic?.requestId ?? error?.requestId
      }, error?.message ?? "Marketplace request failed");
    }
  };
}

function runtimeMetadata(environment: NodeJS.ProcessEnv): Record<string, unknown> {
  return {
    runtime: `${process.release.name} ${process.version} ${process.platform}/${process.arch}`,
    gitSha: environment.PROBE_SOURCE_GIT_SHA ?? "unknown",
    apiVersion: API_VERSION,
    endpoint: MARKETPLACE_PATH,
    pageSize: PAGE_SIZE
  };
}

async function saveSanitizedReport(result: ProbeResult, environment: NodeJS.ProcessEnv): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportsDirectory = join(process.cwd(), "reports");
  const output = join(reportsDirectory, `marketplace-probe-${timestamp}.json`);
  await mkdir(reportsDirectory, { recursive: true });
  await writeFile(output, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    ...runtimeMetadata(environment),
    mode: result.mode,
    target: result.target,
    maxPages: result.maxPages,
    delayMs: result.delayMs,
    stopReason: result.stopReason,
    requests: result.requests,
    matchedCreators: result.matchedCreators.slice(0, MAX_OUTPUT_CREATORS).map(sanitizeCreator)
  }, null, 2)}\n`, "utf8");
  return output;
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid arguments");
    process.exitCode = 2;
    return;
  }

  let credentials: CredentialContext;
  try {
    credentials = await loadCredentialContext(process.env);
  } catch {
    credentials = {
      appKey: "", appSecret: "", accessToken: "", shopCipher: "", apiBaseUrl: "",
      matches: { appKey: false, appSecret: false, accessToken: false, shop: false, apiBase: false }
    };
  }
  printCredentialMatches(credentials.matches);
  if (Object.values(credentials.matches).some((match) => !match)) {
    console.error("Credential context mismatch; stopped with zero TikTok calls.");
    process.exitCode = 1;
    return;
  }

  const result = await runMarketplaceProbe(options, {
    request: createLiveRequester(credentials),
    log: (line) => console.log(line)
  });
  console.log(`Runtime | ${JSON.stringify(runtimeMetadata(process.env))}`);
  console.log(`Completed | stopReason=${result.stopReason} | requests=${result.requests.length} | uniqueMatches=${result.matchedCreators.length}`);
  for (const [index, creator] of result.matchedCreators.slice(0, MAX_OUTPUT_CREATORS).entries()) {
    console.log(`Match ${index + 1} | ${JSON.stringify(sanitizeCreator(creator))}`);
  }
  if (options.saveReport) console.log(`Sanitized report: ${await saveSanitizedReport(result, process.env)}`);
  if (/THROTTLED|QUOTA|PROVIDER_ERROR/.test(result.stopReason)) process.exitCode = 1;
}

if (require.main === module) {
  void main().catch(() => {
    console.error("Marketplace probe failed safely; no retry was attempted.");
    process.exitCode = 1;
  });
}
