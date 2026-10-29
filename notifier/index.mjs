// Offsides DM notifier: polls the API for new DMs and pushes them to your phone
// through Firebase Cloud Messaging. The API has no way to push to third-party
// apps, so something has to watch for you - this is meant to run 24/7 on a
// small always-on machine like a Raspberry Pi. See README.md for setup.
//
// Usage: node index.mjs [--dry-run] [--test]
//   --dry-run  print notifications instead of sending them (no Firebase needed)
//   --test     send one test notification and exit
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { SidechatAPIClient } from 'sidechat.js';

const DIR = new URL('.', import.meta.url).pathname;
const STATE_PATH = DIR + 'state.json';
const DRY_RUN = process.argv.includes('--dry-run');
const TEST = process.argv.includes('--test');

const config = JSON.parse(readFileSync(DIR + 'config.json', 'utf8'));
for (const key of ['yikyakToken', 'notificationKey']) {
  if (!config[key] || config[key].startsWith('paste ')) {
    console.error(`config.json is missing ${key} - see config.example.json`);
    process.exit(1);
  }
}
const INTERVAL = (config.intervalSeconds ?? 30) * 1000;
// After a 401 the token won't fix itself, so just check back now and then.
const AUTH_RETRY = 10 * 60 * 1000;
const MAX_BACKOFF = 15 * 60 * 1000;

const API = new SidechatAPIClient(config.yikyakToken);

// Vary each wait by up to 15% either way, so polling doesn't tick like a clock.
const jitter = ms => Math.round(ms * (0.85 + Math.random() * 0.3));

const log = (...args) => console.log(new Date().toISOString(), ...args);

let send;
if (DRY_RUN) {
  send = async message => log('[dry run] would send:', JSON.stringify(message));
} else {
  const { cert, initializeApp } = await import('firebase-admin/app');
  const { getMessaging } = await import('firebase-admin/messaging');
  const serviceAccount = JSON.parse(
    readFileSync(DIR + (config.serviceAccountFile ?? 'service-account.json'), 'utf8'),
  );
  initializeApp({ credential: cert(serviceAccount) });
  const messaging = getMessaging();
  send = message => messaging.send(message);
}

// One notification per chat (the tag), replaced as new messages come in, so a
// burst of messages buzzes once instead of once per message.
const notify = (chatID, title, body) =>
  send({
    topic: config.notificationKey,
    notification: { title, body },
    data: chatID ? { chatID } : {},
    android: {
      priority: 'high',
      notification: { channelId: 'dms', tag: chatID || 'notifier' },
    },
  });

class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

const get = async path => {
  const res = await API.sendRequest(path);
  if (!res.ok) {
    throw new HttpError(res.status);
  }
  // The chats service answers some bad requests with an empty 200, which
  // throws here - that's wanted, so it's treated as a failed poll.
  return res.json();
};

const newer = (a, b) => new Date(a) > new Date(b);

const loadState = () =>
  existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : null;

// Written only when something changes, and atomically, to go easy on SD cards.
const saveState = state => {
  writeFileSync(STATE_PATH + '.tmp', JSON.stringify(state));
  renameSync(STATE_PATH + '.tmp', STATE_PATH);
};

const describe = message => {
  if (!config.includeText) {
    return 'New message';
  }
  if (message.text) {
    return message.text;
  }
  return message.assets?.length ? 'Sent an attachment' : 'New message';
};

/**
 * Checks the newest chats for messages from other people that arrived since
 * the last check, and sends one notification per chat that has any.
 * @returns {Boolean} whether state changed
 */
async function poll(state) {
  // A new message moves its chat to the top, so the first page is enough.
  const { chats } = await get('/v1/chats');
  let changed = false;
  for (const { chat } of chats || []) {
    const isGroup = chat?.type == 'group';
    if (!chat || (isGroup && !config.groupChats)) {
      continue;
    }
    // Chats we've never seen are compared against when the notifier started,
    // so an old thread bumped onto the first page doesn't replay its history.
    if (!newer(chat.updated_at, state.updated[chat.id] ?? state.since)) {
      continue;
    }
    const { chat: full } = await get(`/v1/chats/messages?chat_id=${chat.id}`);
    const messages = full?.messages || [];
    // If you've replied since, you've clearly seen what came before it.
    let seen = state.seen[chat.id] ?? state.since;
    for (const m of messages) {
      if (m.authored_by_user && newer(m.created_at, seen)) {
        seen = m.created_at;
      }
    }
    const fresh = messages.filter(
      m => m.type == 'message' && !m.authored_by_user && newer(m.created_at, seen),
    );
    if (fresh.length) {
      const latest = fresh.reduce((a, b) => (newer(b.created_at, a.created_at) ? b : a));
      let body = describe(latest);
      if (isGroup && latest.identity?.display_name) {
        body = `${latest.identity.display_name}: ${body}`;
      }
      if (fresh.length > 1) {
        body += ` (+${fresh.length - 1} more)`;
      }
      await notify(chat.id, isGroup ? chat.name || 'Group chat' : 'New DM', body);
      log(`notified ${chat.id} (${fresh.length} new)`);
    }
    for (const m of messages) {
      if (newer(m.created_at, seen)) {
        seen = m.created_at;
      }
    }
    state.seen[chat.id] = seen;
    state.updated[chat.id] = chat.updated_at;
    changed = true;
  }
  return changed;
}

if (TEST) {
  await notify(null, 'Offsides notifier', 'Test notification - your setup works!');
  log('test notification sent');
  process.exit(0);
}

const state = loadState() ?? {
  since: new Date().toISOString(),
  updated: {},
  seen: {},
  authFailed: false,
};
saveState(state);
log(`watching for DMs every ~${INTERVAL / 1000}s${DRY_RUN ? ' (dry run)' : ''}`);

let delay = INTERVAL;
async function tick() {
  try {
    if (await poll(state)) {
      saveState(state);
    }
    if (state.authFailed) {
      state.authFailed = false;
      saveState(state);
      log('login works again');
    }
    delay = INTERVAL;
  } catch (e) {
    if (e.status == 401 || e.status == 403) {
      if (!state.authFailed) {
        state.authFailed = true;
        saveState(state);
        log('YikYak rejected the token - notifications are paused');
        await notify(
          null,
          'DM notifications stopped',
          "The notifier's YikYak login expired. Give it a new token to turn them back on.",
        ).catch(err => log('could not send the warning:', err.message));
      }
      delay = AUTH_RETRY;
    } else if (e.status == 429) {
      delay = Math.min(delay * 2, MAX_BACKOFF);
      log(`rate limited - waiting ${delay / 1000}s`);
    } else {
      log('poll failed:', e.message);
      delay = INTERVAL;
    }
  }
  setTimeout(tick, jitter(delay));
}
tick();
