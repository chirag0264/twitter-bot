/**
 * Fetch from MongoDB the same alerts used as "context" in the Grok prompt
 * and print them so you can see what's being sent.
 *
 * Usage:
 *   npx ts-node src/inspectContextAlerts.ts
 *   CONTEXT_DAYS=5 CONTEXT_LIMIT=50 npx ts-node src/inspectContextAlerts.ts
 */
import { getDb } from './mongo';

const CONTEXT_DAYS = Number(process.env.CONTEXT_DAYS ?? '3');
const CONTEXT_LIMIT = Number(process.env.CONTEXT_LIMIT ?? '30');

async function main() {
  const db = await getDb();
  const alertsCol = db.collection('alerts');

  const since = new Date(
    Date.now() - CONTEXT_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const recentAlerts = await alertsCol
    .find({ Timestamp: { $gte: since } })
    .sort({ Timestamp: -1 })
    .limit(CONTEXT_LIMIT)
    .project({ Timestamp: 1, MainText: 1, ImpactLine: 1, Reason: 1 })
    .toArray();

  console.log('--- Context alerts (what gets injected into Grok prompt) ---');
  console.log(`Query: Timestamp >= ${since}, sort desc, limit ${CONTEXT_LIMIT}`);
  console.log(`Found: ${recentAlerts.length} alerts\n`);

  recentAlerts.forEach((a: any, i: number) => {
    const main = (a.MainText || '').slice(0, 120);
    const impact = a.ImpactLine || a.Reason || '(none)';
    console.log(`[${i + 1}] ${a.Timestamp || ''}`);
    console.log(`    MainText: "${main}${(a.MainText || '').length > 120 ? '...' : ''}"`);
    console.log(`    ImpactLine: ${impact}`);
    console.log('');
  });

  console.log('--- End ---');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
