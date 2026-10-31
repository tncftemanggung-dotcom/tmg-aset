/*
 * gas-bridge.js — drop-in replacement for google.script.run, for apps that
 * were converted from a Google Apps Script web app to a PWA hosted elsewhere
 * (e.g. GitHub Pages). Load it BEFORE any script that calls google.script.run.
 *
 * What it does
 *  1. Re-creates google.script.run (withSuccessHandler / withFailureHandler /
 *     withUserObject / any server function name) on top of fetch() -> GAS doPost.
 *  2. "queueable" calls (writes) are stored in an IndexedDB outbox when the
 *     device is offline and replayed in order when it is back online.
 *     Every call carries a UUID so the server can drop duplicates on replay.
 *  3. "cacheable" calls (reads) keep their last good answer, served when offline.
 *  4. Registers sw.js, exposes PWA.install() and shows a small status pill.
 *
 * Configuration comes from window.PWA_CONFIG (see pwa-config.js).
 */
(function (global) {
  'use strict';

  // Inside the real GAS iframe google.script.run already exists: do nothing.
  if (global.google && global.google.script && global.google.script.run) return;

  var USER = global.PWA_CONFIG || {};
  var CFG = Object.assign({
    endpoint: '',
    token: '',
    queueable: [],
    cacheable: [],
    timeoutMs: 30000,
    maxAttempts: 8,
    retryEveryMs: 30000,
    statusBadge: true,
    serviceWorker: 'sw.js',
    queuedResult: function () { return { queued: true }; }
  }, USER);
  CFG.labels = Object.assign({
    offline: 'Offline',
    pending: 'pending',
    failed: 'failed',
    syncing: 'Syncing…'
  }, USER.labels || {});

  function noop() {}
  function has(list, v) { return list.indexOf(v) !== -1; }
  function announce(name, detail) {
    try { global.dispatchEvent(new CustomEvent('pwa:' + name, { detail: detail })); } catch (e) { /* old browsers */ }
  }
  function uuid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function tag(err, kind) { err.kind = kind; return err; }

  // ---------- IndexedDB (outbox + read cache) ----------
  var dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise(function (resolve, reject) {
        var req = indexedDB.open('gas-bridge', 1);
        req.onupgradeneeded = function () {
          var d = req.result;
          if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('cache')) d.createObjectStore('cache', { keyPath: 'key' });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    }
    return dbp;
  }
  function store(name, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(name, mode);
        var r = fn(t.objectStore(name));
        t.oncomplete = function () { resolve(r && 'result' in r ? r.result : undefined); };
        t.onerror = t.onabort = function () { reject(t.error); };
      });
    });
  }
  function outboxAll() {
    return store('outbox', 'readonly', function (s) { return s.getAll(); }).then(function (a) {
      return (a || []).sort(function (x, y) { return x.createdAt - y.createdAt; });
    });
  }
  function outboxPut(item) { return store('outbox', 'readwrite', function (s) { return s.put(item); }); }
  function outboxDelete(id) { return store('outbox', 'readwrite', function (s) { return s.delete(id); }); }
  function cacheKey(fn, args) { return fn + ':' + JSON.stringify(args); }
  function cacheGet(fn, args) { return store('cache', 'readonly', function (s) { return s.get(cacheKey(fn, args)); }); }
  function cachePut(fn, args, value) {
    return store('cache', 'readwrite', function (s) { return s.put({ key: cacheKey(fn, args), value: value, at: Date.now() }); });
  }

  // ---------- Arguments: google.script.run accepts <form> elements ----------
  function serializeArg(a) {
    if (global.HTMLFormElement && a instanceof HTMLFormElement) {
      var out = {};
      new FormData(a).forEach(function (v, k) {
        if (typeof v !== 'string') return; // File inputs are not supported through the bridge
        if (k in out) { out[k] = [].concat(out[k], v); } else { out[k] = v; }
      });
      return out;
    }
    return a;
  }

  // ---------- Network ----------
  function post(fn, args, id) {
    if (!CFG.endpoint) return Promise.reject(tag(new Error('PWA_CONFIG.endpoint is empty'), 'config'));
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, CFG.timeoutMs) : null;
    // No Content-Type header on purpose: text/plain is a "simple" request, so the
    // browser skips the CORS preflight that Apps Script cannot answer.
    return fetch(CFG.endpoint, {
      method: 'POST',
      redirect: 'follow',
      body: JSON.stringify({ fn: fn, args: args, id: id, token: typeof CFG.token === 'function' ? CFG.token() : CFG.token }),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) { return r.text(); }).then(function (txt) {
      var j;
      try { j = JSON.parse(txt); } catch (e) {
        throw tag(new Error('Endpoint did not return JSON. Check that the deployment is "Execute as: Me / Access: Anyone" and that the latest version is deployed.'), 'bad-response');
      }
      return j;
    }).catch(function (e) {
      if (!e.kind) tag(e, 'network'); // TypeError / AbortError => unreachable or timed out
      throw e;
    }).then(function (j) { clearTimeout(timer); return j; }, function (e) { clearTimeout(timer); throw e; });
  }

  // ---------- Core call logic ----------
  function enqueue(id, fn, args) {
    return outboxPut({ id: id, fn: fn, args: args, createdAt: Date.now(), attempts: 0, status: 'pending' })
      .then(function () { announce('queued', { id: id, fn: fn, args: args }); updateBadge(); setTimeout(flush, 0); });
  }

  function run(fn, args) {
    var isWrite = has(CFG.queueable, fn);
    var isRead = has(CFG.cacheable, fn);
    var id = uuid();

    function fromCache() {
      return cacheGet(fn, args).then(function (hit) {
        if (!hit) return null;
        announce('stale', { fn: fn, at: hit.at });
        return { ok: true, value: hit.value };
      }).catch(function () { return null; });
    }
    function queued() {
      return enqueue(id, fn, args).then(function () { return { ok: true, value: CFG.queuedResult(fn, args) }; });
    }

    var pre = Promise.resolve(null);
    if (isWrite) {
      // Keep order: if something is already waiting, go behind it.
      pre = outboxAll().then(function (items) {
        return (items.length || navigator.onLine === false) ? queued() : null;
      }).catch(function () { return null; });
    } else if (isRead && navigator.onLine === false) {
      pre = fromCache();
    }

    return pre.then(function (early) {
      if (early) return early;
      return post(fn, args, id).then(function (j) {
        if (j && j.ok) {
          if (isRead) cachePut(fn, args, j.result).catch(noop);
          return { ok: true, value: j.result };
        }
        return { ok: false, error: new Error((j && j.error) || 'Server error') };
      }).catch(function (e) {
        if (e.kind === 'network') {
          if (isWrite) return queued();
          if (isRead) return fromCache().then(function (hit) { return hit || { ok: false, error: e }; });
        }
        return { ok: false, error: e };
      });
    });
  }

  // ---------- google.script.run clone ----------
  function makeRunner(st) {
    return new Proxy({}, {
      get: function (_, prop) {
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        if (prop === 'withSuccessHandler') return function (f) { return makeRunner(Object.assign({}, st, { ok: f })); };
        if (prop === 'withFailureHandler') return function (f) { return makeRunner(Object.assign({}, st, { fail: f })); };
        if (prop === 'withUserObject') return function (o) { return makeRunner(Object.assign({}, st, { user: o })); };
        return function () {
          var args = Array.prototype.slice.call(arguments).map(serializeArg);
          run(String(prop), args).then(function (o) {
            if (o.ok) { if (st.ok) st.ok(o.value, st.user); }
            else if (st.fail) { st.fail(o.error, st.user); }
            else { console.error('[gas-bridge] ' + prop + ' failed:', o.error); }
          });
        };
      }
    });
  }

  // ---------- Outbox replay ----------
  var flushing = false;
  function flush() {
    if (flushing || navigator.onLine === false) return Promise.resolve();
    flushing = true;
    updateBadge();
    return outboxAll().then(function (items) {
      var todo = items.filter(function (i) { return i.status !== 'failed'; });
      var chain = Promise.resolve();
      var stop = false;
      todo.forEach(function (it) {
        chain = chain.then(function () {
          if (stop) return;
          return post(it.fn, it.args, it.id).then(function (j) {
            if (j && j.ok) { return outboxDelete(it.id).then(function () { announce('synced', it); }); }
            it.status = 'failed'; it.error = (j && j.error) || 'Server error';
            return outboxPut(it).then(function () { announce('sync-failed', it); });
          }).catch(function (e) {
            if (e.kind === 'network') { stop = true; return; } // still offline: keep order, try later
            it.attempts = (it.attempts || 0) + 1; it.error = e.message;
            if (it.attempts >= CFG.maxAttempts) it.status = 'failed';
            stop = it.status !== 'failed';
            return outboxPut(it).then(function () { if (it.status === 'failed') announce('sync-failed', it); });
          });
        });
      });
      return chain;
    }).catch(noop).then(function () { flushing = false; updateBadge(); });
  }

  // ---------- Status pill ----------
  var badge = null;
  function updateBadge() {
    if (!CFG.statusBadge || !global.document || !document.body) return;
    outboxAll().then(function (items) {
      var pending = items.filter(function (i) { return i.status !== 'failed'; }).length;
      var failed = items.length - pending;
      var offline = navigator.onLine === false;
      var parts = [];
      if (offline) parts.push(CFG.labels.offline);
      else if (flushing && pending) parts.push(CFG.labels.syncing);
      if (pending) parts.push(pending + ' ' + CFG.labels.pending);
      if (failed) parts.push(failed + ' ' + CFG.labels.failed);
      if (!parts.length) { if (badge) badge.style.display = 'none'; return; }
      if (!badge) {
        badge = document.createElement('div');
        badge.setAttribute('role', 'status');
        badge.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(12px + env(safe-area-inset-bottom,0px));' +
          'z-index:2147483647;padding:6px 14px;border-radius:999px;font:500 13px system-ui,sans-serif;' +
          'background:#202124;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3);pointer-events:none';
        document.body.appendChild(badge);
      }
      badge.textContent = parts.join(' · ');
      badge.style.background = failed ? '#b3261e' : '#202124';
      badge.style.display = 'block';
    }).catch(noop);
  }

  // ---------- Install prompt + service worker ----------
  var deferredPrompt = null;
  global.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); deferredPrompt = e; announce('installable', {});
  });
  global.addEventListener('appinstalled', function () { deferredPrompt = null; announce('installed', {}); });

  if ('serviceWorker' in navigator && CFG.serviceWorker && location.protocol !== 'file:') {
    global.addEventListener('load', function () {
      navigator.serviceWorker.register(CFG.serviceWorker).catch(function (e) { console.warn('[gas-bridge] SW registration failed', e); });
    });
  }

  global.addEventListener('online', function () { updateBadge(); flush(); });
  global.addEventListener('offline', updateBadge);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') flush(); });
  global.addEventListener('DOMContentLoaded', function () { updateBadge(); flush(); });
  setInterval(function () { flush(); }, CFG.retryEveryMs);

  // ---------- Public surface ----------
  global.google = global.google || {};
  global.google.script = {
    run: makeRunner({}),
    host: {
      close: function () { try { global.close(); } catch (e) { /* ignored */ } },
      setHeight: noop,
      setWidth: noop,
      editor: { focus: noop }
    },
    url: {
      getLocation: function (cb) {
        var params = {}, multi = {};
        new URLSearchParams(location.search).forEach(function (v, k) { (multi[k] = multi[k] || []).push(v); params[k] = v; });
        cb({ hash: location.hash.replace(/^#/, ''), parameter: params, parameters: multi, queryString: location.search.replace(/^\?/, '') });
      }
    },
    history: {
      push: function (state, params, hash) { history.pushState(state || null, '', hash ? '#' + hash : location.href); },
      replace: function (state, params, hash) { history.replaceState(state || null, '', hash ? '#' + hash : location.href); },
      setChangeHandler: function (f) {
        global.addEventListener('popstate', function (e) {
          f({ state: e.state, location: { hash: location.hash.replace(/^#/, ''), parameter: {}, parameters: {}, queryString: location.search.replace(/^\?/, '') } });
        });
      }
    }
  };

  global.PWA = {
    config: CFG,
    flush: flush,
    getOutbox: outboxAll,
    retryFailed: function () {
      return outboxAll().then(function (items) {
        return Promise.all(items.filter(function (i) { return i.status === 'failed'; }).map(function (i) {
          i.status = 'pending'; i.attempts = 0; return outboxPut(i);
        }));
      }).then(flush);
    },
    discardFailed: function () {
      return outboxAll().then(function (items) {
        return Promise.all(items.filter(function (i) { return i.status === 'failed'; }).map(function (i) { return outboxDelete(i.id); }));
      }).then(updateBadge);
    },
    // Wipe locally cached read results (call on sign-out / account switch so the next person on a shared device sees nothing of the last one).
    clearCache: function () { return store('cache', 'readwrite', function (s) { return s.clear(); }); },
    canInstall: function () { return !!deferredPrompt; },
    install: function () {
      if (!deferredPrompt) return Promise.resolve(false);
      deferredPrompt.prompt();
      return deferredPrompt.userChoice.then(function (c) { deferredPrompt = null; return c.outcome === 'accepted'; });
    }
  };
})(window);
