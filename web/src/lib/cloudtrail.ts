import {
  CloudTrailClient,
  LookupEventsCommand,
  type LookupEventsCommandInput,
  type LookupEventsCommandOutput,
} from "@aws-sdk/client-cloudtrail";
import { parseAssumeEvent, type ParsedAssume } from "./githubIdentity";

export type AwsCreds = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

/** Common commercial regions for Event History multi-select. */
export const CLOUDTRAIL_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-north-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-south-1",
  "sa-east-1",
] as const;

export type ScanProgress = {
  pages: number;
  rawEvents: number;
  githubEvents: number;
  status: string;
  region?: string;
  regionIndex?: number;
  regionTotal?: number;
};

export type ScanOptions = {
  days: number;
  regions: string[];
  signal?: AbortSignal;
  onProgress?: (p: ScanProgress) => void;
  /**
   * Called after each LookupEvents page that yields GitHub OIDC assumes.
   * `batch` = new rows from that page; `allSoFar` = cumulative across regions.
   */
  onBatch?: (batch: ParsedAssume[], allSoFar: readonly ParsedAssume[]) => void;
  /** Max attempts per LookupEvents page (default 8). */
  maxRetries?: number;
  /** Base backoff ms before first retry (default 750). */
  retryBaseMs?: number;
  /** Cap on backoff delay ms (default 20000). */
  retryMaxMs?: number;
  /** Pause between successful pages to reduce throttle (default 350). */
  pageDelayMs?: number;
};

const DEFAULT_MAX_RETRIES = 8;
const DEFAULT_RETRY_BASE_MS = 750;
const DEFAULT_RETRY_MAX_MS = 20_000;
const DEFAULT_PAGE_DELAY_MS = 350;
/** LookupEvents MaxResults ceiling (AWS: 1–50). */
const LOOKUP_MAX_RESULTS = 50;

function createClient(creds: AwsCreds, region: string): CloudTrailClient {
  return new CloudTrailClient({
    region,
    // SDK retries help some faults; we also wrap LookupEvents for Rate exceeded (often 400).
    maxAttempts: 3,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken || undefined,
    },
  });
}

function parseCloudTrailEvent(
  item: NonNullable<LookupEventsCommandOutput["Events"]>[number],
): Record<string, unknown> | null {
  const raw = item.CloudTrailEvent;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function errName(err: unknown): string {
  if (err && typeof err === "object" && "name" in err) {
    return String((err as { name: unknown }).name);
  }
  return "";
}

function errHttpStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "$metadata" in err) {
    const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
    return meta?.httpStatusCode;
  }
  return undefined;
}

/** CloudTrail often returns HTTP 400 "Rate exceeded" rather than a clean 429. */
export function isThrottleError(err: unknown): boolean {
  const name = errName(err);
  const msg = errMessage(err);
  const status = errHttpStatus(err);

  if (
    name === "ThrottlingException" ||
    name === "Throttling" ||
    name === "TooManyRequestsException" ||
    name === "RequestLimitExceeded" ||
    name === "ProvisionedThroughputExceededException" ||
    name === "TimeoutError"
  ) {
    return true;
  }

  if (/rate\s*exceeded|throttl|slow\s*down|try\s*again|too\s*many\s*requests/i.test(msg)) {
    return true;
  }

  if (status === 429) return true;
  // LookupEvents throttle commonly surfaces as 400 with "Rate exceeded"
  if (status === 400 && /rate\s*exceeded|throttl/i.test(msg)) return true;

  return false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Scan cancelled", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Scan cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  // attempt 1 → base, then exponential; add jitter so multi-region scans don't sync
  const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * Math.min(250, exp * 0.25));
  return Math.min(maxMs, exp + jitter);
}

async function lookupEventsWithRetry(
  client: CloudTrailClient,
  input: LookupEventsCommandInput,
  options: {
    signal?: AbortSignal;
    maxRetries: number;
    retryBaseMs: number;
    retryMaxMs: number;
    onRetry: (attempt: number, waitMs: number, err: unknown) => void;
  },
): Promise<LookupEventsCommandOutput> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= options.maxRetries; attempt++) {
    if (options.signal?.aborted) {
      throw new DOMException("Scan cancelled", "AbortError");
    }
    try {
      return await client.send(new LookupEventsCommand(input));
    } catch (err) {
      lastErr = err;
      if (!isThrottleError(err) || attempt >= options.maxRetries) {
        throw err;
      }
      const waitMs = backoffMs(attempt, options.retryBaseMs, options.retryMaxMs);
      options.onRetry(attempt, waitMs, err);
      await sleep(waitMs, options.signal);
    }
  }
  throw lastErr;
}

async function scanOneRegion(
  creds: AwsCreds,
  region: string,
  start: Date,
  end: Date,
  options: ScanOptions,
  totals: { pages: number; rawEvents: number; githubEvents: number },
  allResults: ParsedAssume[],
  regionIndex: number,
  regionTotal: number,
): Promise<number> {
  const client = createClient(creds, region);
  let regionGithub = 0;
  let nextToken: string | undefined;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  const pageDelayMs = options.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS;

  const report = (status: string) => {
    options.onProgress?.({
      pages: totals.pages,
      rawEvents: totals.rawEvents,
      githubEvents: totals.githubEvents,
      status,
      region,
      regionIndex,
      regionTotal,
    });
  };

  report(`Scanning ${region}…`);

  try {
    do {
      if (options.signal?.aborted) {
        throw new DOMException("Scan cancelled", "AbortError");
      }

      const response = await lookupEventsWithRetry(
        client,
        {
          LookupAttributes: [
            {
              AttributeKey: "EventName",
              AttributeValue: "AssumeRoleWithWebIdentity",
            },
          ],
          StartTime: start,
          EndTime: end,
          MaxResults: LOOKUP_MAX_RESULTS,
          NextToken: nextToken,
        },
        {
          signal: options.signal,
          maxRetries,
          retryBaseMs,
          retryMaxMs,
          onRetry: (attempt, waitMs, err) => {
            report(
              `${region}: rate limited (${errMessage(err)}) — retry ${attempt}/${maxRetries - 1} in ${Math.round(waitMs / 1000)}s…`,
            );
          },
        },
      );

      totals.pages += 1;
      const events = response.Events || [];
      totals.rawEvents += events.length;
      const pageBatch: ParsedAssume[] = [];

      for (const item of events) {
        const cloudEvent = parseCloudTrailEvent(item);
        if (!cloudEvent) continue;
        if (item.EventTime && !cloudEvent.eventTime) {
          cloudEvent.eventTime = item.EventTime.toISOString();
        }
        const parsed = parseAssumeEvent(cloudEvent);
        if (parsed) {
          pageBatch.push(parsed);
          allResults.push(parsed);
        }
      }

      regionGithub += pageBatch.length;
      totals.githubEvents = allResults.length;

      if (pageBatch.length) {
        options.onBatch?.(pageBatch, allResults);
      }

      nextToken = response.NextToken;
      report(
        nextToken
          ? `${region}: page ${totals.pages} (${totals.rawEvents} events)…`
          : `${region}: done — ${regionGithub} GitHub OIDC assume(s)`,
      );

      // Pace successful pages; LookupEvents throttles easily across regions.
      if (nextToken && pageDelayMs > 0) {
        await sleep(pageDelayMs, options.signal);
      }
    } while (nextToken);
  } finally {
    client.destroy();
  }

  return regionGithub;
}

/**
 * Paginate CloudTrail Event History for AssumeRoleWithWebIdentity across
 * one or more regions, keep GitHub Actions OIDC assumes, return parsed rows.
 */
export async function scanGitHubAssumes(
  creds: AwsCreds,
  options: ScanOptions,
): Promise<ParsedAssume[]> {
  const regions = [
    ...new Set(
      options.regions
        .map((r) => r.trim())
        .filter(Boolean),
    ),
  ];
  if (!regions.length) {
    throw new Error("Select at least one region");
  }

  const days = Math.min(Math.max(1, options.days), 90);
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const results: ParsedAssume[] = [];
  const totals = { pages: 0, rawEvents: 0, githubEvents: 0 };
  const pageDelayMs = options.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS;

  options.onProgress?.({
    pages: 0,
    rawEvents: 0,
    githubEvents: 0,
    status: `Starting ${regions.length} region(s)…`,
    regionTotal: regions.length,
  });

  for (let i = 0; i < regions.length; i++) {
    if (options.signal?.aborted) {
      throw new DOMException("Scan cancelled", "AbortError");
    }
    const region = regions[i]!;
    await scanOneRegion(
      creds,
      region,
      start,
      end,
      options,
      totals,
      results,
      i + 1,
      regions.length,
    );

    // Brief pause between regions so the next region's first page is less likely to 400.
    if (i < regions.length - 1 && pageDelayMs > 0) {
      await sleep(pageDelayMs * 2, options.signal);
    }
  }

  options.onProgress?.({
    pages: totals.pages,
    rawEvents: totals.rawEvents,
    githubEvents: results.length,
    status: `Done — ${regions.length} region(s), ${results.length} GitHub OIDC assume(s)`,
    regionTotal: regions.length,
  });

  return results;
}
