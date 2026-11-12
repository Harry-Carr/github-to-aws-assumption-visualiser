import {
  CloudTrailClient,
  LookupEventsCommand,
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
};

function createClient(creds: AwsCreds, region: string): CloudTrailClient {
  return new CloudTrailClient({
    region,
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

async function scanOneRegion(
  creds: AwsCreds,
  region: string,
  start: Date,
  end: Date,
  options: ScanOptions,
  totals: { pages: number; rawEvents: number; githubEvents: number },
  regionIndex: number,
  regionTotal: number,
): Promise<ParsedAssume[]> {
  const client = createClient(creds, region);
  const results: ParsedAssume[] = [];
  let nextToken: string | undefined;

  const report = (status: string) => {
    options.onProgress?.({
      pages: totals.pages,
      rawEvents: totals.rawEvents,
      githubEvents: totals.githubEvents + results.length,
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

      const response = await client.send(
        new LookupEventsCommand({
          LookupAttributes: [
            {
              AttributeKey: "EventName",
              AttributeValue: "AssumeRoleWithWebIdentity",
            },
          ],
          StartTime: start,
          EndTime: end,
          MaxResults: 50,
          NextToken: nextToken,
        }),
      );

      totals.pages += 1;
      const events = response.Events || [];
      totals.rawEvents += events.length;

      for (const item of events) {
        const cloudEvent = parseCloudTrailEvent(item);
        if (!cloudEvent) continue;
        if (item.EventTime && !cloudEvent.eventTime) {
          cloudEvent.eventTime = item.EventTime.toISOString();
        }
        const parsed = parseAssumeEvent(cloudEvent);
        if (parsed) results.push(parsed);
      }

      nextToken = response.NextToken;
      report(
        nextToken
          ? `${region}: page ${totals.pages} (${totals.rawEvents} events)…`
          : `${region}: done — ${results.length} GitHub OIDC assume(s)`,
      );
    } while (nextToken);
  } finally {
    client.destroy();
  }

  totals.githubEvents += results.length;
  return results;
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
    const rows = await scanOneRegion(
      creds,
      region,
      start,
      end,
      options,
      totals,
      i + 1,
      regions.length,
    );
    results.push(...rows);
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
