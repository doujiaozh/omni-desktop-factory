/*!
 * omni.js — frontend SDK of the Omni-Desktop-Factory RPC bridge.
 *
 * Injected automatically by the factory at /__omni.js and referenced from
 * the generated app's index.html. Zero dependencies, works in any browser
 * that ships with the host OS (Chrome 49+ / Firefox 45+ era APIs only).
 *
 *   window.omni.call('system.getInfo')            -> Promise<any>
 *   window.omni.on('omni:ready', (data) => {...}) -> unsubscribe fn
 *   window.omni.version                           -> '1.0.0'
 */
(function (global) {
  'use strict';

  var VERSION = '1.0.0';
  var WS_PATH = '/__omni_ws';
  var RECONNECT_MIN = 250;   // ms
  var RECONNECT_MAX = 4000;  // ms
  var CALL_TIMEOUT = 15000;  // ms

  var ws = null;
  var connected = false;
  var nextId = 1;
  var pending = Object.create(null);   // id -> {resolve, reject, timer}
  var listeners = Object.create(null); // event -> array of callbacks
  var queue = [];                      // calls made before the socket opens
  var backoff = RECONNECT_MIN;

  function log() {
    if (global.omni && omni.debug) {
      try { console.log.apply(console, ['[omni]'].concat([].slice.call(arguments))); } catch (e) {}
    }
  }

  function endpoint() {
    var loc = global.location || { host: '127.0.0.1', protocol: 'http:' };
    var proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + loc.host + WS_PATH;
  }

  function flushQueue() {
    var pendingCalls = queue.splice(0, queue.length);
    for (var i = 0; i < pendingCalls.length; i++) {
      send(pendingCalls[i]);
    }
  }

  function send(frame) {
    if (!ws || ws.readyState !== 1) {
      queue.push(frame);
      return;
    }
    ws.send(JSON.stringify(frame));
  }

  function onMessage(evt) {
    var msg;
    try { msg = JSON.parse(evt.data); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'result' && pending[msg.id]) {
      var entry = pending[msg.id];
      delete pending[msg.id];
      if (entry.timer) { clearTimeout(entry.timer); }
      if (msg.ok) {
        entry.resolve(msg.data);
      } else {
        entry.reject(new Error(msg.error || 'RPC call failed'));
      }
      return;
    }

    if (msg.type === 'event' && msg.event) {
      var cbs = listeners[msg.event];
      if (cbs) {
        for (var i = 0; i < cbs.length; i++) {
          try { cbs[i](msg.data); } catch (e) { log('listener threw', e); }
        }
      }
    }
  }

  function fire(event, data) {
    var cbs = listeners[event];
    if (!cbs) return;
    for (var i = 0; i < cbs.length; i++) {
      try { cbs[i](data); } catch (e) {}
    }
  }

  function connect() {
    try {
      ws = new WebSocket(endpoint());
    } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.onopen = function () {
      connected = true;
      backoff = RECONNECT_MIN;
      log('bridge connected');
      flushQueue();
      fire('omni:connect');
    };

    ws.onmessage = onMessage;

    ws.onclose = function () {
      if (!connected) return; // tear-down after a successful session
      connected = false;
      log('bridge disconnected, reconnecting');
      fire('omni:disconnect');
      scheduleReconnect();
    };

    ws.onerror = function () {
      // onclose will follow and schedule the reconnect.
      try { ws.close(); } catch (e) {}
    };
  }

  function scheduleReconnect() {
    setTimeout(function () {
      if (!connected) connect();
    }, backoff);
    backoff = Math.min(backoff * 2, RECONNECT_MAX);
  }

  function omni() {}

  omni.version = VERSION;
  omni.debug = false;

  /**
   * Call a Go-side RPC method.
   * @param {string} method   e.g. 'system.getInfo'
   * @param {object} [params] optional JSON-serialisable params
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  omni.call = function (method, params, timeoutMs) {
    if (typeof method !== 'string' || !method) {
      return Promise.reject(new Error('omni.call: method must be a non-empty string'));
    }
    var id = nextId++;
    var frame = { type: 'call', id: id, method: method, params: params || {} };
    var timeout = typeof timeoutMs === 'number' ? timeoutMs : CALL_TIMEOUT;

    return new Promise(function (resolve, reject) {
      var entry = { resolve: resolve, reject: reject, timer: null };
      if (timeout > 0) {
        entry.timer = setTimeout(function () {
          if (pending[id]) {
            delete pending[id];
            reject(new Error('omni.call: "' + method + '" timed out after ' + timeout + 'ms'));
          }
        }, timeout);
      }
      pending[id] = entry;
      send(frame);
    });
  };

  /** Subscribe to a host-side event. Returns an unsubscribe function. */
  omni.on = function (event, callback) {
    if (typeof event !== 'string' || typeof callback !== 'function') {
      throw new Error('omni.on(event, callback): bad arguments');
    }
    (listeners[event] = listeners[event] || []).push(callback);
    return function () { omni.off(event, callback); };
  };

  omni.off = function (event, callback) {
    var cbs = listeners[event];
    if (!cbs) return;
    if (!callback) { delete listeners[event]; return; }
    var i = cbs.indexOf(callback);
    if (i >= 0) cbs.splice(i, 1);
    if (cbs.length === 0) delete listeners[event];
  };

  /** True once the bridge socket is open. */
  omni.isConnected = function () { return connected; };

  /** Ask the Go host to terminate the whole app. */
  omni.exit = function () { return omni.call('app.exit'); };

  // The host emits "omni:ready" as soon as the socket is wired up.
  omni.on('omni:ready', function (data) {
    log('host ready', data);
    fire('omni:ready', data);
  });

  global.omni = omni;
  connect();
})(typeof window !== 'undefined' ? window : this);
