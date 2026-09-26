import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { Agent, EnvHttpProxyAgent, Socks5ProxyAgent, getGlobalDispatcher } from 'undici';

import {
	matchesNoProxy,
	isLoopbackHostname,
	mergeLoopbackNoProxy,
	buildDispatcher,
	buildSystemDispatcher,
	parseScutilProxy,
	detectSystemProxy,
	parseNoProxyList,
	resolveMode,
	resolveConfig,
	createEngine,
	Config,
	apply as applyPlugin,
	PROXY_ENV_KEYS
} from '../lib/index.js';

/* ---------------------------------------------------------------- helpers */

function listen(server) {
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function close(server) {
	return new Promise((resolve) => server.close(() => resolve()));
}

/** Remove proxy env keys for a test, restoring them in t.after. */
function isolateProxyEnv(t) {
	const saved = {};
	for (const key of PROXY_ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	t.after(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}

/** Plain origin server that echoes how the request reached it. */
async function startOrigin() {
	const server = http.createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ via: 'origin', path: req.url }));
	});
	await listen(server);
	return { server, url: `http://127.0.0.1:${server.address().port}` };
}

/** Minimal forwarding HTTP proxy that records every absolute-form request. */
async function startHttpProxy() {
	const seen = [];
	const server = http.createServer((req, res) => {
		seen.push(req.url);
		try {
			const target = new URL(req.url);
			const upstream = http.request(
				{
					hostname: target.hostname,
					port: target.port,
					path: target.pathname + target.search,
					method: req.method,
					headers: req.headers
				},
				(up) => {
					res.writeHead(up.statusCode, up.headers);
					up.pipe(res);
				}
			);
			upstream.on('error', () => {
				res.writeHead(502);
				res.end('proxy-upstream-error');
			});
			req.pipe(upstream);
		} catch {
			res.writeHead(400);
			res.end('proxy-bad-target');
		}
	});
	await listen(server);
	return { server, seen, url: `http://127.0.0.1:${server.address().port}` };
}

/** Minimal no-auth SOCKS5 server that records CONNECT targets. */
async function startSocks5() {
	const connects = [];
	const server = net.createServer((socket) => {
		socket.on('error', () => socket.destroy());
		let phase = 0;
		socket.on('data', function onData(chunk) {
			if (phase === 0) {
				socket.write(Buffer.from([0x05, 0x00])); // no-auth accepted
				phase = 1;
				return;
			}
			socket.off('data', onData);
			const atyp = chunk[3];
			let host;
			let offset;
			if (atyp === 0x01) {
				host = `${chunk[4]}.${chunk[5]}.${chunk[6]}.${chunk[7]}`;
				offset = 8;
			} else if (atyp === 0x03) {
				const len = chunk[4];
				host = chunk.subarray(5, 5 + len).toString('utf8');
				offset = 5 + len;
			} else {
				host = '::1';
				offset = 20;
			}
			const port = chunk.readUInt16BE(offset);
			connects.push(`${host}:${port}`);
			const upstream = net.connect(port, host, () => {
				socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
				upstream.pipe(socket);
				socket.pipe(upstream);
			});
			upstream.on('error', () => socket.destroy());
			socket.on('error', () => upstream.destroy());
		});
	});
	await listen(server);
	return { server, connects, url: `socks5://127.0.0.1:${server.address().port}` };
}

/* ------------------------------------------------------------ unit: matcher */

test('DSH 0.1.7 Settings exposes the volatile entry and re-applies it on updates', (t) => {
	isolateProxyEnv(t);
	assert.equal(Config.meta.volatile, true);
	const baseline = getGlobalDispatcher();
	let current = { mode: 'manual', proxy: 'http://127.0.0.1:9', exportEnv: false };
	const handlers = new Map();
	const fiber = {};
	let presentation;
	const ctx = {
		fiber,
		on: (event, callback) => handlers.set(event, callback),
		inject: (_services, callback) => callback({
			effect: (register) => register(),
			settings: { configure: (policy, owner) => { presentation = { policy, owner }; return () => {}; } }
		})
	};
	t.after(() => handlers.get('dispose')?.());

	applyPlugin(ctx, { get: () => current });
	assert.deepEqual(presentation, { policy: { auto: false }, owner: fiber });
	assert.notEqual(getGlobalDispatcher(), baseline);
	current = { mode: 'direct', exportEnv: false };
	handlers.get('loader/volatile-update')();
	assert.equal(getGlobalDispatcher(), baseline);
});

test('matchesNoProxy mirrors undici semantics plus suffix extensions', () => {
	const rules = ['localhost', '.internal.example', 'pin.exact:8443', '*.wild.test'];
	// undici semantics: a bare entry matches the host AND dot-boundary subdomains
	assert.equal(matchesNoProxy('localhost', '8080', rules), true);
	assert.equal(matchesNoProxy('api.localhost', '8080', rules), true);
	// leading dot / *. prefixes are pure suffix rules
	assert.equal(matchesNoProxy('svc.internal.example', '443', rules), true);
	assert.equal(matchesNoProxy('internal.example', '443', rules), true);
	assert.equal(matchesNoProxy('xinternal.example', '443', rules), false);
	// host:port pins the port
	assert.equal(matchesNoProxy('pin.exact', '8443', rules), true);
	assert.equal(matchesNoProxy('pin.exact', '9999', rules), false);
	assert.equal(matchesNoProxy('a.wild.test', '80', rules), true);
	assert.equal(matchesNoProxy('wild.test', '80', rules), true);
	// '*' bypasses everything; nothing matches an empty rule list
	assert.equal(matchesNoProxy('anything.dev', '80', ['*']), true);
	assert.equal(matchesNoProxy('x.dev', '80', []), false);
	assert.equal(matchesNoProxy('', '80', ['*']), false);
	assert.equal(matchesNoProxy('HOST.UPPER', '80', ['host.upper']), true);
	// bracketed IPv6 entries lose their brackets
	assert.equal(matchesNoProxy('::1', '80', ['[::1]']), true);
});

/* ------------------------------------------------- unit: dispatcher choice */

test('buildDispatcher picks the right agent per protocol', () => {
	// bypassLoopback:false keeps the agent unwrapped so instanceof is exact
	assert.ok(buildDispatcher({ enabled: true, proxy: 'http://127.0.0.1:8080', bypassLoopback: false }) instanceof EnvHttpProxyAgent);
	assert.ok(buildDispatcher({ enabled: true, proxy: 'socks5://127.0.0.1:1080', bypassLoopback: false }) instanceof Socks5ProxyAgent);
	// socks5h and socks:// normalize onto the SOCKS5 agent
	assert.ok(buildDispatcher({ enabled: true, proxy: 'socks5h://127.0.0.1:1080', bypassLoopback: false }) instanceof Socks5ProxyAgent);
	assert.ok(buildDispatcher({ enabled: true, proxy: 'socks://127.0.0.1:1080', bypassLoopback: false }) instanceof Socks5ProxyAgent);
	// the default loopback bypass wraps every protocol in the routing dispatcher
	assert.equal(buildDispatcher({ enabled: true, proxy: 'http://127.0.0.1:8080' }).constructor.kind, 'dsh-proxy');
	// unsupported protocol rejects
	assert.throws(() => buildDispatcher({ enabled: true, proxy: 'ftp://127.0.0.1:21', bypassLoopback: false }), /unsupported proxy protocol/);
});

/* ------------------------------------------------- unit: mode resolution */

test('resolveMode maps the deprecated enabled flag onto direct/manual', () => {
	assert.equal(resolveMode({ enabled: false }), 'direct');
	assert.equal(resolveMode({ enabled: true }), 'manual');
	// an explicit mode always wins over the deprecated flag
	assert.equal(resolveMode({ mode: 'direct', enabled: true }), 'direct');
	assert.equal(resolveMode({ mode: 'system', enabled: true }), 'system');
	assert.equal(resolveMode({ mode: 'manual', enabled: false }), 'manual');
	assert.equal(resolveMode({}), 'direct');
});

test('resolveConfig normalizes raw sections into the effective config', () => {
	assert.deepEqual(resolveConfig({ enabled: true, proxy: 'http://p' }), {
		mode: 'manual',
		proxy: 'http://p',
		noProxy: [],
		exportEnv: true,
		bypassLoopback: true
	});
	assert.equal(resolveConfig({ mode: 'system' }).mode, 'system');
	assert.deepEqual(resolveConfig({ mode: 'system' }).noProxy, []);
	assert.equal(resolveConfig({ mode: 'manual', exportEnv: false }).exportEnv, false);
	assert.equal(resolveConfig({ mode: 'manual' }).bypassLoopback, true, 'bypassLoopback defaults to true');
	assert.equal(resolveConfig({ mode: 'manual', bypassLoopback: false }).bypassLoopback, false);
});

/* -------------------------------------------- unit: loopback bypass */

test('isLoopbackHostname recognizes every loopback literal form', () => {
	// trailing-dot FQDN root label (`localhost.`, `127.0.0.1.`) is loopback too
	for (const host of ['localhost', 'LOCALHOST', 'LOCALHOST.', 'localhost.', '127.0.0.1', '127.0.0.1.', '127.0.0.2', '127.255.0.1', '::1', '[::1]', '0.0.0.0']) {
		assert.equal(isLoopbackHostname(host), true, `${host} must be loopback`);
	}
	for (const host of ['example.com', '128.0.0.1', '1270.0.0.1', '::2', '::1.1', 'localhost.example', 'xlocalhost', 'localhost.evil', 'localhost..', '']) {
		assert.equal(isLoopbackHostname(host), false, `${host} must not be loopback`);
	}
});

test('mergeLoopbackNoProxy merges user rules with the loopback set, deduplicated', () => {
	assert.deepEqual(mergeLoopbackNoProxy([]), ['localhost', '127.0.0.1', '::1']);
	// user rules first, loopback additions appended, duplicates dropped
	assert.deepEqual(mergeLoopbackNoProxy(['a.corp', 'LOCALHOST', '[::1]', '127.0.0.1']), ['a.corp', 'LOCALHOST', '[::1]', '127.0.0.1']);
	assert.deepEqual(mergeLoopbackNoProxy(['localhost', 'b.corp']), ['localhost', 'b.corp', '127.0.0.1', '::1']);
});

/* ------------------------------------------- unit: system-proxy detection */

test('parseNoProxyList splits a curl-style no_proxy value', () => {
	assert.deepEqual(parseNoProxyList('localhost, .corp,  a.b:443 ,'), ['localhost', '.corp', 'a.b:443']);
	assert.deepEqual(parseNoProxyList(''), []);
	assert.deepEqual(parseNoProxyList(undefined), []);
});

test('parseScutilProxy reads HTTP/HTTPS/SOCKS and the exceptions list', () => {
	const text = [
		'<dictionary> {',
		'  ExceptionsList : <array> {',
		'    0 : 127.0.0.1',
		'    1 : localhost',
		'    2 : *.internal',
		'  }',
		'  HTTPEnable : 1',
		'  HTTPPort : 7890',
		'  HTTPProxy : 127.0.0.1',
		'  HTTPSEnable : 1',
		'  HTTPSPort : 7890',
		'  HTTPSProxy : 127.0.0.1',
		'  SOCKSEnable : 0',
		'  ProxyAutoConfigEnable : 0',
		'}'
	].join('\n');

	const spec = parseScutilProxy(text);
	assert.equal(spec.httpProxy, 'http://127.0.0.1:7890');
	assert.equal(spec.httpsProxy, 'http://127.0.0.1:7890');
	assert.equal(spec.socksProxy, undefined);
	assert.deepEqual(spec.noProxy, ['127.0.0.1', 'localhost', '*.internal']);
	assert.equal(spec.pac, false);
});

test('parseScutilProxy reports PAC / auto-discovery without fabricating proxies', () => {
	const pac = parseScutilProxy('<dictionary> {\n  ProxyAutoConfigEnable : 1\n  ProxyAutoConfigURLString : http://wpad.example/proxy.pac\n}');
	assert.equal(pac.pac, true);
	assert.equal(pac.httpProxy, undefined);
	assert.equal(pac.httpsProxy, undefined);
	assert.equal(pac.socksProxy, undefined);
});

test('parseScutilProxy handles SOCKS-only and missing exceptions', () => {
	const text = [
		'<dictionary> {',
		'  HTTPEnable : 0',
		'  HTTPPort : 9999',
		'  HTTPSEnable : 0',
		'  HTTPSPort : 9999',
		'  SOCKSEnable : 1',
		'  SOCKSProxy : 127.0.0.1',
		'  SOCKSPort : 1080',
		'}'
	].join('\n');
	const spec = parseScutilProxy(text);
	assert.equal(spec.socksProxy, 'socks5://127.0.0.1:1080');
	// disabled protocols must not leak their stale port values
	assert.equal(spec.httpProxy, undefined);
	assert.equal(spec.httpsProxy, undefined);
	assert.deepEqual(spec.noProxy, []);
});

test('detectSystemProxy follows env vars and returns null when none set', () => {
	const spec = detectSystemProxy('linux', {
		HTTP_PROXY: 'http://h:7890',
		HTTPS_PROXY: 'http://h:7890',
		NO_PROXY: 'localhost,.corp'
	});
	assert.equal(spec.httpProxy, 'http://h:7890');
	assert.equal(spec.httpsProxy, 'http://h:7890');
	assert.deepEqual(spec.noProxy, ['localhost', '.corp']);

	// lowercase forms are honored too
	const lower = detectSystemProxy('linux', { http_proxy: 'http://l:1' });
	assert.equal(lower.httpProxy, 'http://l:1');
	assert.equal(lower.httpsProxy, undefined);

	// ALL_PROXY is the curl-style catch-all: http serves both legs, socks → SOCKS5
	const allHttp = detectSystemProxy('linux', { ALL_PROXY: 'http://a:8080' });
	assert.equal(allHttp.httpProxy, 'http://a:8080');
	assert.equal(allHttp.httpsProxy, 'http://a:8080');

	const allSocks = detectSystemProxy('linux', { all_proxy: 'socks5h://127.0.0.1:1080' });
	assert.equal(allSocks.socksProxy, 'socks5://127.0.0.1:1080');

	// per-protocol vars win over ALL_PROXY
	const perProto = detectSystemProxy('linux', { HTTP_PROXY: 'http://h:1', ALL_PROXY: 'socks5://127.0.0.1:1080' });
	assert.equal(perProto.httpProxy, 'http://h:1');
	assert.equal(perProto.socksProxy, undefined);

	assert.equal(detectSystemProxy('linux', {}), null);
});

/* ------------------------------------------------- unit: system dispatcher */

test('buildSystemDispatcher picks the right agent per detected proxy', () => {
	assert.ok(buildSystemDispatcher({ httpProxy: 'http://h:1', noProxy: [] }, false) instanceof EnvHttpProxyAgent);
	assert.ok(buildSystemDispatcher({ httpsProxy: 'http://h:1', noProxy: [] }, false) instanceof EnvHttpProxyAgent);
	assert.ok(buildSystemDispatcher({ socksProxy: 'socks5://h:1080', noProxy: [] }, false) instanceof Socks5ProxyAgent);
	assert.ok(buildSystemDispatcher({ noProxy: [] }, false) instanceof Agent);

	// any noProxy rule wraps the agent in the shared routing dispatcher
	const wrapped = buildSystemDispatcher({ httpProxy: 'http://h:1', noProxy: ['localhost'] });
	assert.equal(wrapped.constructor.kind, 'dsh-proxy');

	// loopback bypass alone (no rules) also routes through the dispatcher
	const loopbackWrapped = buildSystemDispatcher({ httpProxy: 'http://h:1', noProxy: [] }, true);
	assert.equal(loopbackWrapped.constructor.kind, 'dsh-proxy');
	// and with the bypass disabled and no rules, the agent stays unwrapped
	assert.ok(buildSystemDispatcher({ httpProxy: 'http://h:1', noProxy: [] }, false) instanceof EnvHttpProxyAgent);
});

/* ----------------------------------------------------------- e2e: modes */

test('system mode follows the ambient HTTP_PROXY env without writing it', async (t) => {
	const origin = await startOrigin();
	const proxy = await startHttpProxy();
	t.after(async () => {
		await close(proxy.server);
		await close(origin.server);
	});

	isolateProxyEnv(t);
	process.env.HTTP_PROXY = proxy.url;
	process.env.HTTPS_PROXY = proxy.url;

	const engine = createEngine(null);
	t.after(() => engine.restore());

	engine.apply({ mode: 'system', exportEnv: true, bypassLoopback: false });
	const body = await (await fetch(origin.url)).json();
	assert.equal(body.via, 'origin');
	assert.equal(proxy.seen.length, 1);

	// system mode reads env, never exports over it
	assert.equal(process.env.HTTP_PROXY, proxy.url);
	assert.equal(process.env.HTTPS_PROXY, proxy.url);

	// switching to direct must leave the ambient env untouched
	engine.apply({ mode: 'direct' });
	assert.equal(process.env.HTTP_PROXY, proxy.url, 'ambient env must survive direct mode');
});

test('system mode never mistakes its own manual export for the system proxy', async (t) => {
	const origin = await startOrigin();
	const manual = await startHttpProxy();
	t.after(async () => {
		await close(manual.server);
		await close(origin.server);
	});

	isolateProxyEnv(t);

	const engine = createEngine(null);
	t.after(() => engine.restore());

	engine.apply({ enabled: true, proxy: manual.url, exportEnv: true });
	assert.equal(process.env.HTTP_PROXY, manual.url);

	// switching to system restores the manual export first, so detection finds
	// nothing and stays direct instead of re-routing through the manual proxy
	engine.apply({ mode: 'system' });
	assert.ok(!('HTTP_PROXY' in process.env), 'manual export must be cleared before the system read');
	const body = await (await fetch(origin.url)).json();
	assert.equal(body.via, 'origin');
	assert.equal(manual.seen.length, 0, 'manual proxy must see no traffic after the switch');
});

/* ----------------------------------------------------------- e2e: runtime */

test('engine routes global fetch through an HTTP proxy and back', async (t) => {
	const origin = await startOrigin();
	const proxy = await startHttpProxy();
	t.after(async () => {
		await close(proxy.server);
		await close(origin.server);
	});

	const engine = createEngine(null);
	t.after(() => engine.restore());

	engine.apply({ enabled: true, proxy: proxy.url, exportEnv: false, bypassLoopback: false });
	let body = await (await fetch(origin.url)).json();
	assert.equal(body.via, 'origin');
	assert.equal(proxy.seen.length, 1);

	// hot switch off → direct
	engine.apply({ enabled: false, exportEnv: false });
	body = await (await fetch(origin.url)).json();
	assert.equal(body.via, 'origin');
	assert.equal(proxy.seen.length, 1, 'disabled proxy must see no traffic');

	// hot switch on again
	engine.apply({ enabled: true, proxy: proxy.url, exportEnv: false, bypassLoopback: false });
	body = await (await fetch(origin.url)).json();
	assert.equal(body.via, 'origin');
	assert.equal(proxy.seen.length, 2);
});

test('loopback traffic bypasses the proxy by default (bypassLoopback=true)', async (t) => {
	const origin = await startOrigin(); // 127.0.0.1
	const v4any = http.createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ via: 'origin', host: req.headers.host }));
	});
	await new Promise((resolve) => v4any.listen(0, '0.0.0.0', resolve)); // accepts 127.0.0.2 / 0.0.0.0
	const v6 = http.createServer((req, res) => {
		res.writeHead(200);
		res.end(JSON.stringify({ via: 'origin', host: req.headers.host }));
	});
	await new Promise((resolve) => v6.listen(0, '::1', resolve));
	const proxy = await startHttpProxy();
	t.after(async () => {
		await close(proxy.server);
		await close(origin.server);
		await close(v4any);
		await close(v6);
	});

	const engine = createEngine(null);
	t.after(() => engine.restore());

	// no noProxy rules at all — the built-in loopback set still applies
	engine.apply({ enabled: true, proxy: proxy.url, exportEnv: false });

	const v4port = v4any.address().port;
	// NOTE: 127.0.0.2 (rest of 127.0.0.0/8) is covered by the
	// isLoopbackHostname unit test — this sandbox only lets connections
	// through to 127.0.0.1/0.0.0.0/::1/localhost.
	for (const url of [
		origin.url, // 127.0.0.1
		`http://0.0.0.0:${v4port}`, // this-host address
		origin.url.replace('127.0.0.1', 'localhost'), // localhost name
		`http://[::1]:${v6.address().port}` // IPv6 loopback
	]) {
		const body = await (await fetch(url)).json();
		assert.equal(body.via, 'origin');
	}
	assert.equal(proxy.seen.length, 0, 'no loopback request may reach the proxy');

	// bypassLoopback=false restores the pre-0.2.4 behavior: everything proxies
	engine.apply({ enabled: true, proxy: proxy.url, exportEnv: false, bypassLoopback: false });
	const localhostUrl = origin.url.replace('127.0.0.1', 'localhost');
	const viaProxy = await (await fetch(localhostUrl)).json();
	assert.equal(viaProxy.via, 'origin');
	assert.equal(proxy.seen.length, 1, 'with bypassLoopback=false localhost must route via the proxy');
});

test('user noProxy rules still work alongside the loopback bypass', async (t) => {
	const origin = await startOrigin();
	const proxy = await startHttpProxy();
	t.after(async () => {
		await close(proxy.server);
		await close(origin.server);
	});

	const engine = createEngine(null);
	t.after(() => engine.restore());

	// explicit 127.0.0.1 rule + default loopback set: both hosts bypass
	engine.apply({ enabled: true, proxy: proxy.url, noProxy: ['127.0.0.1'], exportEnv: false });
	const body = await (await fetch(origin.url)).json();
	assert.equal(body.via, 'origin');
	assert.equal(proxy.seen.length, 0, '127.0.0.1 must bypass');

	// with the loopback bypass off, only the explicit rule bypasses
	engine.apply({ enabled: true, proxy: proxy.url, noProxy: ['127.0.0.1'], exportEnv: false, bypassLoopback: false });
	assert.equal((await (await fetch(origin.url)).json()).via, 'origin');
	assert.equal(proxy.seen.length, 0, 'the explicit rule still bypasses');
	const localhostUrl = origin.url.replace('127.0.0.1', 'localhost');
	assert.equal((await (await fetch(localhostUrl)).json()).via, 'origin');
	assert.equal(proxy.seen.length, 1, 'without the rule-eligible host, localhost must route via the proxy');
});

test('engine routes global fetch through a SOCKS5 proxy', async (t) => {
	const origin = await startOrigin();
	const socks = await startSocks5();
	t.after(async () => {
		await close(socks.server);
		await close(origin.server);
	});

	const engine = createEngine(null);
	t.after(() => engine.restore());

	engine.apply({ enabled: true, proxy: socks.url, exportEnv: false, bypassLoopback: false });
	const body = await (await fetch(origin.url)).json();
	assert.equal(body.via, 'origin');
	assert.equal(socks.connects.length, 1);
	assert.equal(socks.connects[0], `127.0.0.1:${origin.server.address().port}`);
});

test('SOCKS5 honors noProxy through the routing dispatcher', async (t) => {
	const origin = await startOrigin();
	const socks = await startSocks5();
	t.after(async () => {
		await close(socks.server);
		await close(origin.server);
	});

	const engine = createEngine(null);
	t.after(() => engine.restore());

	engine.apply({ enabled: true, proxy: socks.url, noProxy: ['127.0.0.1'], exportEnv: false, bypassLoopback: false });
	const body = await (await fetch(origin.url)).json();
	assert.equal(body.via, 'origin');
	assert.equal(socks.connects.length, 0, 'bypass rule must keep SOCKS out of the path');
});

test('env export follows the switch and never clobbers operator values', async (t) => {
	const origin = await startOrigin();
	const proxy = await startHttpProxy();
	t.after(async () => {
		await close(proxy.server);
		await close(origin.server);
	});

	isolateProxyEnv(t);

	const engine = createEngine(null);
	t.after(() => engine.restore());

	engine.apply({ enabled: true, proxy: proxy.url, noProxy: ['localhost'] });
	assert.equal(process.env.HTTP_PROXY, proxy.url);
	assert.equal(process.env.HTTPS_PROXY, proxy.url);
	assert.equal(process.env.ALL_PROXY, proxy.url);
	// NO_PROXY carries the user rule merged with the loopback default set
	assert.equal(process.env.NO_PROXY, 'localhost,127.0.0.1,::1');

	// a distinct user rule keeps its position ahead of the loopback additions
	engine.apply({ enabled: true, proxy: proxy.url, noProxy: ['a.corp'] });
	assert.equal(process.env.NO_PROXY, 'a.corp,localhost,127.0.0.1,::1');

	// with bypassLoopback=false the export falls back to the user rules only
	engine.apply({ enabled: true, proxy: proxy.url, noProxy: ['a.corp'], bypassLoopback: false });
	assert.equal(process.env.NO_PROXY, 'a.corp');
	// and with no rules, no NO_PROXY is exported at all (legacy behavior)
	engine.apply({ enabled: true, proxy: proxy.url, bypassLoopback: false });
	assert.ok(!('NO_PROXY' in process.env));

	engine.apply({ enabled: false });
	assert.ok(!('HTTP_PROXY' in process.env));
	assert.ok(!('NO_PROXY' in process.env));

	// operator-provided values survive untouched
	process.env.HTTP_PROXY = 'http://operator:1';
	engine.apply({ enabled: true, proxy: proxy.url });
	assert.equal(process.env.HTTP_PROXY, 'http://operator:1');
	engine.apply({ enabled: false });
	assert.equal(process.env.HTTP_PROXY, 'http://operator:1');
	delete process.env.HTTP_PROXY;
});

test('clearing noProxy on a hot switch removes stale NO_PROXY env', (t) => {
	isolateProxyEnv(t);

	const engine = createEngine(null);
	t.after(() => engine.restore());

	engine.apply({ enabled: true, proxy: 'http://127.0.0.1:9', noProxy: ['localhost'] });
	assert.equal(process.env.NO_PROXY, 'localhost,127.0.0.1,::1');

	// hot switch to an empty noProxy list — with the loopback bypass still on,
	// NO_PROXY keeps the loopback default set (user rules dropped, not stale)
	engine.apply({ enabled: true, proxy: 'http://127.0.0.1:9', noProxy: [] });
	assert.equal(process.env.NO_PROXY, 'localhost,127.0.0.1,::1');
	// disabling the loopback bypass with no rules clears NO_PROXY entirely
	engine.apply({ enabled: true, proxy: 'http://127.0.0.1:9', noProxy: [], bypassLoopback: false });
	assert.ok(!('NO_PROXY' in process.env));
	assert.ok(!('no_proxy' in process.env));
	assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:9');
});

test('invalid or incomplete config keeps traffic direct', async (t) => {
	const origin = await startOrigin();
	t.after(() => close(origin.server));

	const engine = createEngine(null);
	t.after(() => engine.restore());

	engine.apply({ enabled: true, proxy: 'ftp://nope:21' });
	const body = await (await fetch(origin.url)).json();
	assert.equal(body.via, 'origin');

	engine.apply({ enabled: true });
	const again = await (await fetch(origin.url)).json();
	assert.equal(again.via, 'origin');
});

test('restore returns the original global dispatcher', (t) => {
	const before = getGlobalDispatcher();
	const engine = createEngine(null);
	t.after(() => engine.restore());
	engine.apply({ enabled: true, proxy: 'http://127.0.0.1:9', exportEnv: false });
	assert.notEqual(getGlobalDispatcher(), before);
	engine.restore();
	assert.equal(getGlobalDispatcher(), before);
});

test('IPv6 noProxy rules bypass on the real request path', async (t) => {
	const proxy = await startHttpProxy();
	const origin = http.createServer((req, res) => {
		res.writeHead(200);
		res.end('origin-v6');
	});
	await new Promise((resolve) => origin.listen(0, '::1', resolve));
	t.after(async () => {
		await close(proxy.server);
		await close(origin);
	});

	const engine = createEngine(null);
	t.after(() => engine.restore());

	const url = `http://[::1]:${origin.address().port}/v6`;
	// bypassLoopback off so these exercise the rule matcher, not the loopback default
	// bracketed rule form
	engine.apply({ enabled: true, proxy: proxy.url, noProxy: ['[::1]'], exportEnv: false, bypassLoopback: false });
	assert.equal(await (await fetch(url)).text(), 'origin-v6');
	assert.equal(proxy.seen.length, 0, 'bracketed [::1] rule must bypass');
	// bare rule form
	engine.apply({ enabled: true, proxy: proxy.url, noProxy: ['::1'], exportEnv: false, bypassLoopback: false });
	assert.equal(await (await fetch(url)).text(), 'origin-v6');
	assert.equal(proxy.seen.length, 0, 'bare ::1 rule must bypass');
});

test('ambient NO_PROXY env never steers the in-process routing', async (t) => {
	const origin = await startOrigin();
	const proxy = await startHttpProxy();
	t.after(async () => {
		await close(proxy.server);
		await close(origin.server);
	});

	const saved = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
	process.env.NO_PROXY = '127.0.0.1';
	delete process.env.no_proxy;
	t.after(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	const engine = createEngine(null);
	t.after(() => engine.restore());

	// With plugin-level noProxy rules: routing must follow the section, not env.
	engine.apply({ enabled: true, proxy: proxy.url, noProxy: ['example.invalid'], exportEnv: false, bypassLoopback: false });
	assert.equal((await (await fetch(origin.url)).json()).via, 'origin');
	assert.equal(proxy.seen.length, 1, 'ambient NO_PROXY must not bypass the wrapped HTTP leg');

	// With no plugin-level rules (unwrapped agent): still immune to env.
	engine.apply({ enabled: true, proxy: proxy.url, exportEnv: false, bypassLoopback: false });
	proxy.seen.length = 0;
	assert.equal((await (await fetch(origin.url)).json()).via, 'origin');
	assert.equal(proxy.seen.length, 1, 'unwrapped HTTP leg must also ignore ambient NO_PROXY');
});

test('turning exportEnv off on a hot switch clears exported env', (t) => {
	isolateProxyEnv(t);

	const engine = createEngine(null);
	t.after(() => engine.restore());

	engine.apply({ enabled: true, proxy: 'http://127.0.0.1:9', exportEnv: true });
	assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:9');

	// still enabled, but env export withdrawn → stale values must go
	engine.apply({ enabled: true, proxy: 'http://127.0.0.1:9', exportEnv: false });
	assert.ok(!('HTTP_PROXY' in process.env));
	assert.ok(!('ALL_PROXY' in process.env));
});

test('operator values set mid-session are adopted, not clobbered', (t) => {
	isolateProxyEnv(t);

	const engine = createEngine(null);
	t.after(() => engine.restore());

	engine.apply({ enabled: true, proxy: 'http://first:9' });
	assert.equal(process.env.HTTP_PROXY, 'http://first:9');

	// operator overrides our exported value mid-session
	process.env.HTTP_PROXY = 'http://operator-mid:1';

	// hot switch to another proxy must not clobber the operator value
	engine.apply({ enabled: true, proxy: 'http://second:9' });
	assert.equal(process.env.HTTP_PROXY, 'http://operator-mid:1');

	// disabling restores the operator value, not ours
	engine.apply({ enabled: false });
	assert.equal(process.env.HTTP_PROXY, 'http://operator-mid:1');
	delete process.env.HTTP_PROXY;
});

test('proxy URL credentials are redacted in logs', () => {
	const messages = [];
	const engine = createEngine({
		info: (message) => messages.push(message),
		error: (message) => messages.push(message)
	});
	try {
		engine.apply({ enabled: true, proxy: 'socks5://alice:s3cret@127.0.0.1:1080', exportEnv: false });
		assert.equal(messages.length, 1);
		assert.match(messages[0], /socks5:\/\/\*\*\*@127\.0\.0\.1:1080/);
		assert.ok(!messages[0].includes('alice'));
		assert.ok(!messages[0].includes('s3cret'));
	} finally {
		engine.restore();
	}
});

test('SOCKS proxy URLs with credentials construct a SOCKS5 agent', () => {
	assert.ok(buildDispatcher({ enabled: true, proxy: 'socks5://alice:s3cret@127.0.0.1:1080', bypassLoopback: false }) instanceof Socks5ProxyAgent);
});
