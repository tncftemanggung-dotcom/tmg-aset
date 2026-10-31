/**
 * Api.gs — PWA bridge router. Add as a NEW file in the Apps Script project.
 *
 * The PWA (hosted on GitHub Pages) cannot use google.script.run, so gas-bridge.js
 * sends  POST {fn, args, id, token}  to the web app /exec URL and this router
 * calls the matching server function.
 *
 * Deployment must be:  Execute as = Me,  Who has access = Anyone.
 * After every change: Deploy > Manage deployments > Edit > New version.
 * (The /exec URL stays the same.)
 *
 * SECURITY: anyone who knows the URL can call the allowed functions. Only list
 * functions that are safe to expose. A static front-end cannot keep secrets,
 * so PWA_TOKEN below is a speed bump, not authentication.
 */

// 1) Functions the PWA may call (copy them from the analyzer report).
//    They must be top-level `function name() {}` declarations: `const name = () => {}`
//    is not reachable through globalThis in the Apps Script V8 runtime.
const PWA_ALLOWED_FUNCTIONS = [
  'loginUser',
  'getAsetData',
  'simpanAset',
  'hapusAset'
];

// Writes that must never run at the same time (same names as `queueable` in
// pwa-config.js). Reads are not locked, so they stay fast.
const PWA_SERIALIZED_FUNCTIONS = [
  'simpanAset',
  'hapusAset'
];

// 2) Optional shared token. Set Script property PWA_TOKEN (Project Settings >
//    Script properties) and put the same value in pwa-config.js. Leave the
//    property unset to disable the check.
function pwaTokenOk_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty('PWA_TOKEN');
  return !expected || expected === token;
}

/**
 * If the project already has a doPost(e), rename it (e.g. originalDoPost_) and
 * call it from the fallback branch below. If the body is not a PWA call, keep
 * the old behaviour.
 */
function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return pwaJson_({ ok: false, error: 'Request body is not valid JSON' });
  }
  if (!req || typeof req.fn !== 'string') {
    return pwaJson_({ ok: false, error: 'Missing "fn"' });
  }
  return pwaJson_(pwaDispatch_(req));
}

function pwaDispatch_(req) {
  if (!pwaTokenOk_(req.token)) return { ok: false, error: 'Invalid token' };
  if (PWA_ALLOWED_FUNCTIONS.indexOf(req.fn) === -1) {
    return { ok: false, error: 'Function not allowed: ' + req.fn };
  }

  // Idempotency: the client retries queued writes with the SAME id. If this id
  // already succeeded recently, return the stored answer instead of running
  // the write twice. CacheService keeps entries at most 6 hours; for longer
  // offline periods also dedupe inside the write function itself (store the id
  // in a column and skip if present).
  const cache = CacheService.getScriptCache();
  const cacheKey = req.id ? 'pwa:' + req.id : null;
  if (cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit) return JSON.parse(hit);
  }

  const lock = LockService.getScriptLock();
  const needsLock = PWA_SERIALIZED_FUNCTIONS.indexOf(req.fn) !== -1;
  try {
    if (needsLock) lock.waitLock(20000); // replayed queues must not interleave
    globalThis.PWA_REQUEST_ID = req.id || null; // lets a write function dedupe by id (e.g. store it in a column)
    const fn = globalThis[req.fn];
    if (typeof fn !== 'function') return { ok: false, error: 'Unknown function: ' + req.fn };
    const result = fn.apply(null, Array.isArray(req.args) ? req.args : []);
    const out = { ok: true, result: result === undefined ? null : result };
    if (cacheKey) {
      try { cache.put(cacheKey, JSON.stringify(out), 21600); } catch (e) { /* value too large: skip */ }
    }
    return out;
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    if (needsLock) { try { lock.releaseLock(); } catch (e) { /* not held */ } }
  }
}

function pwaJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
