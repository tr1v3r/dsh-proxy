import test from 'node:test';
import assert from 'node:assert/strict';
import { getGlobalDispatcher } from 'undici';
import { createEngine, apply, PROXY_ENV_KEYS, mergeLoopbackNoProxy } from '../lib/index.js';

function isolated(t) {
	const env = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
	for (const key of PROXY_ENV_KEYS) delete process.env[key];
	const engine = createEngine();
	t.after(() => {
		engine.restore();
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	});
	return engine;
}

test('applied snapshots are redacted, copied, read-only and protocol-specific', (t) => {
	const engine = isolated(t);
	engine.apply({ mode: 'direct' });
	assert.equal(engine.getStatus().route, 'baseline');
	engine.apply({ mode: 'manual', proxy: 'http://user:secret@localhost:8080', exportEnv: false });
	const manual = engine.getStatus();
	assert.equal(manual.httpEndpoint, 'http://***@localhost:8080');
	assert.equal(manual.source, 'manual');
	assert.equal(manual.code, 'applied');
	const dispatcher = getGlobalDispatcher();
	const before = { ...process.env };
	manual.code = 'fake';
	assert.equal(engine.getStatus().code, 'applied');
	assert.equal(getGlobalDispatcher(), dispatcher);
	assert.deepEqual({ ...process.env }, before);
	process.env.HTTP_PROXY = 'http://a:password@localhost:8888';
	process.env.HTTPS_PROXY = 'http://localhost:9999';
	process.env.NO_PROXY = 'internal.example,localhost';
	engine.apply({ mode: 'system', bypassLoopback: false });
	const system = engine.getStatus();
	assert.equal(system.httpEndpoint, 'http://***@localhost:8888');
	assert.equal(system.httpsEndpoint, 'http://localhost:9999');
	assert.equal(system.source, 'environment');
	assert.equal(system.noProxyCount, 2);
	assert.equal(system.bypassLoopback, false);
	assert.ok(system.generation > manual.generation);
	process.env.HTTP_PROXY = 'http://localhost:1234';
	assert.deepEqual(engine.getStatus(), system, 'reads never re-detect ambient proxy');
	process.env.HTTP_PROXY = 'not a URL secret';
	engine.apply({ mode: 'system' });
	assert.equal(engine.getStatus().code, 'system-apply-error');
	assert.equal(engine.getStatus().httpEndpoint, null);
	engine.apply({ mode: 'manual', proxy: 'not a URL secret' });
	assert.equal(engine.getStatus().route, 'baseline');
	assert.equal(engine.getStatus().code, 'manual-apply-error');
	assert.doesNotMatch(JSON.stringify(engine.getStatus()), /secret|password|private/);
	engine.apply({ mode: 'manual' });
	assert.equal(engine.getStatus().code, 'manual-missing');
	engine.apply({ mode: 'manual', proxy: 'socks5://localhost:1080', exportEnv: false });
	assert.equal(engine.getStatus().route, 'socks5');
});

test('optional authenticated Fetch route reads snapshots without applying configuration', async (t) => {
	isolated(t);
	const handlers = new Map();
	let route;
	apply({
		on: (name, handler) => handlers.set(name, handler),
		inject: (services, callback) => {
			if (services[0] === 'connection') callback({ connection: { fetch: { register: (value) => { route = value; } } } });
		}
	}, { mode: 'direct' });
	t.after(() => handlers.get('dispose')());
	const dispatcher = getGlobalDispatcher();
	assert.equal(route.path, '/api/dsh-proxy/status');
	assert.deepEqual(route.methods, ['GET']);
	const response = route.fetch();
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.equal((await response.json()).route, 'baseline');
	assert.equal(getGlobalDispatcher(), dispatcher);
});

test('loopback export deduplicates only identical trimmed tokens; opt-out preserves the original list', (t) => {
	const unique = ['LOCALHOST.', 'localhost', '127.0.0.1.', '127.0.0.1', '[::1]', '::1', '127.0.0.2',
		'localhost:80', '.localhost', '*.localhost', 'localhost..', 'example.com.', 'example.com', '[::1]:80'];
	const rules = [...unique, ' localhost ', '127.0.0.1.', '[::1]', '', '  '];
	const expected = unique;
	assert.deepEqual(mergeLoopbackNoProxy(rules), expected);
	assert.deepEqual(mergeLoopbackNoProxy(['127.999.0.1.', '127.999.0.1']).slice(0, 2), ['127.999.0.1.', '127.999.0.1']);
	const engine = isolated(t);
	engine.apply({ mode: 'manual', proxy: 'http://localhost:9', noProxy: rules });
	assert.equal(process.env.NO_PROXY, expected.join(','));
	assert.equal(process.env.no_proxy, expected.join(','));
	engine.apply({ mode: 'manual', proxy: 'http://localhost:9', noProxy: rules, bypassLoopback: false });
	assert.equal(process.env.NO_PROXY, rules.join(','));
	assert.equal(process.env.no_proxy, rules.join(','));
	engine.apply({ mode: 'direct' });
	assert.equal(process.env.NO_PROXY, undefined);
});
