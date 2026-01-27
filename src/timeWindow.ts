import { getDb } from './mongo';
import { config } from './config';

const METADATA_ID = 'pullTweetsCheckpoint';

interface MetadataDoc {
  _id: string;
  lastCheckedTime?: string;
  lastSavedCount?: number;
}

interface TimeWindow {
  sinceStr: string;
  untilStr: string;
  untilISO: string;
}

function formatUtc(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate()
  )}_${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(
    d.getUTCSeconds()
  )}_UTC`;
}

export async function buildTimeWindow(): Promise<TimeWindow> {
  const db = await getDb();
  const metadata = db.collection<MetadataDoc>('metadata');

  const now = new Date();
  const overlapMs = 60 * 1000; // 60 sec overlap

  const doc = await metadata.findOne({ _id: METADATA_ID });

  const last = doc?.lastCheckedTime
    ? new Date(doc.lastCheckedTime)
    : new Date(now.getTime() - 15 * 60 * 1000);

  const since = new Date(last.getTime() - overlapMs);

  return {
    sinceStr: formatUtc(since),
    untilStr: formatUtc(now),
    untilISO: now.toISOString(),
  };
}

export async function updateCheckpoint(untilISO: string, savedCount: number) {
  const db = await getDb();
  const metadata = db.collection<MetadataDoc>('metadata');

  await metadata.updateOne(
    { _id: METADATA_ID },
    { $set: { lastCheckedTime: untilISO, lastSavedCount: savedCount } },
    { upsert: true }
  );
}

