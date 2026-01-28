import { getDb } from './mongo';
import { runSlowPathOnce } from './slowPathJob';

async function main() {
  await getDb(); // ensure connection
  await runSlowPathOnce();
  process.exit(0);
}

main().catch((err) => {
  console.error('[slow-path] Fatal error:', err);
  process.exit(1);
});
