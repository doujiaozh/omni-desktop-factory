// Smoke test for a generated Omni-Desktop-Factory app.
// Usage: node omni-smoke.mjs http://127.0.0.1:18999
const base = process.argv[2] || 'http://127.0.0.1:18999';
const wsBase = base.replace(/^http/, 'ws');
let failures = 0;
const check = (ok, msg) => {
  console.log((ok ? '  [ok]   ' : '  [fail] ') + msg);
  if (!ok) failures++;
};

// 1. health endpoint
const health = await (await fetch(base + '/__omni/health', { signal: AbortSignal.timeout(5000) })).json();
check(health && health.ok === true, 'GET /__omni/health -> ' + JSON.stringify(health));

// 2. index.html served and SDK injected
const index = await fetch(base + '/', { signal: AbortSignal.timeout(5000) });
const indexText = await index.text();
check(index.status === 200, 'GET / -> ' + index.status + ' (' + indexText.length + ' bytes)');
check(indexText.includes('/__omni.js'), 'index.html loads the bridge SDK');

// 3. SPA fallback: unknown path without a dot falls back to index
const spa = await fetch(base + '/some/route', { signal: AbortSignal.timeout(5000) });
check(spa.status === 200, 'GET /some/route (SPA fallback) -> ' + spa.status);

// 4. real 404 stays 404
const miss = await fetch(base + '/favicon.ico', { signal: AbortSignal.timeout(5000) });
check(miss.status === 404, 'GET /favicon.ico -> ' + miss.status + ' (no false fallback)');

// 5. bridge SDK is served
const sdk = await fetch(base + '/__omni.js', { signal: AbortSignal.timeout(5000) });
const sdkText = await sdk.text();
check(sdk.status === 200 && sdkText.includes('omni'), 'GET /__omni.js -> ' + sdk.status + ' (' + sdkText.length + ' bytes)');

// 6. WebSocket RPC: omni:ready event + bridge.echo + system.getInfo
const ws = new WebSocket(wsBase + '/__omni_ws');
const received = [];
ws.onmessage = (e) => received.push(JSON.parse(e.data));
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
  setTimeout(() => reject(new Error('ws open timeout')), 8000);
});
ws.send(JSON.stringify({ type: 'call', id: 'sm-echo', method: 'bridge.echo', params: { hello: 'world' } }));
ws.send(JSON.stringify({ type: 'call', id: 'sm-info', method: 'system.getInfo', params: {} }));
await new Promise((r) => setTimeout(r, 1500));
ws.close();

const ready = received.find((m) => m.type === 'event' && m.event === 'omni:ready');
check(!!ready, 'received omni:ready event');
const echo = received.find((m) => m.id === 'sm-echo');
check(!!(echo && echo.ok && JSON.stringify(echo.data) === JSON.stringify({ hello: 'world' })), 'bridge.echo round-trip: ' + JSON.stringify(echo));
const info = received.find((m) => m.id === 'sm-info');
check(!!(info && info.ok && info.data && info.data.name === 'Hello'), 'system.getInfo -> ' + JSON.stringify(info && info.data));
const ver = received.find((m) => m.id === 'sm-info' && m.ok && m.data && m.data.version);
check(!!(ver && ver.data.version === '1.0.0'), 'app version is 1.0.0');

console.log(failures === 0 ? '\nALL SMOKE CHECKS PASSED' : '\n' + failures + ' SMOKE CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
