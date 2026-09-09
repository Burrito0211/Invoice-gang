/**
 * `GET /api/items?uncategorized=true&low_confidence=true&limit=`
 *
 * The review queue. Sorted by amount descending — correcting the expensive
 * mistakes first is the fastest route to an accurate chart, and it is the
 * list the low-confidence answers from the model are meant to surface in.
 */
import { listReviewItems } from '../db/queries.js';
import { boolParam, intParam, json } from './respond.js';

/** Below this the model was guessing; docs/CATEGORIZATION.md calls it ~0.6. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

export async function handleItems(db: D1Database, url: URL): Promise<Response> {
  const uncategorized = boolParam(url, 'uncategorized');
  const lowConfidence = boolParam(url, 'low_confidence');

  const rows = await listReviewItems(db, {
    // Neither filter asked for means "show me the queue", which is both.
    uncategorized: uncategorized || !lowConfidence,
    lowConfidence: lowConfidence || !uncategorized,
    threshold: LOW_CONFIDENCE_THRESHOLD,
    limit: intParam(url, 'limit', 100, 500),
  });

  return json({ items: rows, low_confidence_threshold: LOW_CONFIDENCE_THRESHOLD });
}
