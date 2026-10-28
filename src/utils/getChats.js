/**
 * Fetches the user's chats (DMs and joined group chats share one endpoint),
 * following the API's cursor. The API returns 20 chats per page, so reading
 * only the first page silently hides every older thread.
 * @param {SidechatAPIClient} API
 * @param {Number} [maxPages] - most pages to walk; pass 1 for just the newest
 * @returns {Promise<Object[]>} chats, newest first
 */
export default async function getChats(API, maxPages = 10) {
  const chats = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const res = await API.sendRequest(
      cursor ? `/v1/chats?cursor=${encodeURIComponent(cursor)}` : '/v1/chats',
    );
    if (!res.ok) {
      throw new Error(`Failed to fetch chats (HTTP ${res.status})`);
    }
    const json = await res.json();
    const batch = (json.chats || [])
      .map(o => o.chat)
      .filter(c => c && !seen.has(c.id));
    batch.forEach(c => {
      seen.add(c.id);
      chats.push(c);
    });
    cursor = json.cursor;
    if (!cursor || batch.length == 0) {
      break;
    }
  }
  return chats;
}

/**
 * Folds a freshly fetched first page into an already-loaded list, so polling
 * can pick up new activity without re-walking every page.
 */
export function mergeChats(current, latest) {
  const latestIDs = new Set(latest.map(c => c.id));
  return [...latest, ...current.filter(c => !latestIDs.has(c.id))].sort(
    (a, b) => new Date(b.updated_at) - new Date(a.updated_at),
  );
}

export const isGroupChat = chat => chat?.type == 'group';
