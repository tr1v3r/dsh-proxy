/**
 * Real-runtime hot-switch probe. Boots an actual DSH plugin tree (dsh-base
 * + @tr1v3r/dsh-proxy) from a throwaway DSH_HOME, then changes the
 * `dsh-proxy` entry through DSH Settings and verifies that the
 * global dispatcher, child-process env, and live fetch routing follow along
 * without a restart.
 *
 * Usage: node scripts/boot-probe.mjs
 * Requires a `dsh` installation on PATH (or DSH_ROOT set to its package root).
 */

import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, rmSync, cpSync, mkdtempSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { preflight } from './probe-preflight.mjs';
import { PROXY_ENV_KEYS } from '../lib/index.js';
import { getGlobalDispatcher } from 'undici';

// Fail before creating a HOME, listening, or booting. No raw import/TypeError stack.
let checked;
try { checked = await preflight(); }
catch (error) { console.error(error.message); process.exit(1); }
const { root: DSH_ROOT, runtime } = checked;
const { boot, loadProfile, composeEntries, loadLayeredEnv, createRuntimeResolution, PluginPackages, DSH_LAUNCH_ENVIRONMENT_KEY, provideCmdline } = runtime;
const PLUGIN_DIR = process.env.PROBE_PLUGIN_DIR ?? fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
// PROBE_HOME is a parent, never a directory to erase. Only this unique child is owned.
const HOME = mkdtempSync(join(process.env.PROBE_HOME ?? tmpdir(), 'dsh-proxy-boot-'));
process.on('exit', () => rmSync(HOME, { recursive: true, force: true }));
for (const key of PROXY_ENV_KEYS) delete process.env[key];
const PROFILE = 'proxyprobe';
const web = process.argv.includes('--web');

/* ------------------------------------------------- local origin + proxy */

const originHits = [];
const proxyHits = [];

const origin = createServer((req, res) => {
	originHits.push(req.url);
	res.writeHead(200, { 'content-type': 'text/plain' });
	res.end('origin-ok');
});
const proxy = createServer((req, res) => {
	proxyHits.push(req.url);
	res.writeHead(200, { 'x-via': 'probe-proxy' });
	res.end('proxy-ok');
});

await new Promise((r) => origin.listen(0, '127.0.0.1', r));
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const originUrl = `http://127.0.0.1:${origin.address().port}/probe`;
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

/* ------------------------------------------------------ throwaway home */

const profileDir = join(HOME, 'profiles', PROFILE);
mkdirSync(profileDir, { recursive: true });

writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
	name: PROFILE,
	private: true,
	dsh: {
		profile: {
			bundles: ['@deepseek-ai/dsh-base', ...(web ? ['@deepseek-ai/dsh-web-app'] : []), '@tr1v3r/dsh-proxy'],
			patchReload: 'startup'
		}
	}
}, null, '\t'));

const webPatch = web ? '- id: web-runtime\n  config: { openBrowser: false, printUrl: false, surfaceContext: false }\n' : '';
writeFileSync(join(profileDir, 'cordis.patch.yml'), webPatch + [
	'- id: dsh-proxy',
	'  config:',
	'    enabled: true',
	`    proxy: ${proxyUrl}`,
	'    noProxy:',
	'      - example.invalid',
	// The probe's origin and proxy are both loopback addresses: the legacy
	// proxy-routing assertions below only hold with the loopback bypass off
	// (the new-semantics block at the end re-enables and verifies the default).
	'    bypassLoopback: false',
	''
].join('\n'));

// Minimal node_modules: the plugin package plus its runtime deps.
mkdirSync(join(profileDir, 'node_modules', '@tr1v3r'), { recursive: true });
cpSync(PLUGIN_DIR, join(profileDir, 'node_modules', '@tr1v3r', 'dsh-proxy'), {
	recursive: true,
	filter: (src) => {
		const top = relative(PLUGIN_DIR, src).split('/')[0];
		return !top || ['package.json', 'cordis.patch.yml', 'lib'].includes(top);
	}
});
// undici must come from the plugin's own installed copy for resolution.
cpSync(
	join(PLUGIN_DIR, 'node_modules', 'undici'),
	join(profileDir, 'node_modules', 'undici'),
	{ recursive: true }
);
cpSync(
	join(PLUGIN_DIR, 'node_modules', '@deepseek-ai'),
	join(profileDir, 'node_modules', '@deepseek-ai'),
	{ recursive: true }
);

/* --------------------------------------------------------------- boot */

process.env.DSH_HOME = HOME;
process.env.DEEPSEEK_API_KEY ??= 'probe-unused';

const installAnchor = `${DSH_ROOT}/package.json`;
const profile = loadProfile('dsh', PROFILE, installAnchor, HOME);
const resolution = await createRuntimeResolution({ installAnchor, profile, home: HOME });
writeFileSync(join(profile.dir, 'cordis.yml'), [
	'# dsh profile root — an empty entry list. The tree is composed as patches:',
	'# each bundle in package.json\'s dsh.profile.bundles, then cordis.patch.yml, then any',
	'# --patch overlays. Edit cordis.patch.yml, not this file.',
	'[]',
	''
].join('\n'));
const bundlePatches = profile.layers.flatMap((layer) => layer.patches);
const patchLayers = [bundlePatches, profile.patches];
const composed = composeEntries(structuredClone(patchLayers));
if (!composed.some((entry) => entry.id === 'dsh-proxy')) throw new Error('probe: proxy entry is missing from the profile');

const baseline = getGlobalDispatcher();
const ctx = await boot('dsh', join(profile.dir, 'cordis.yml'), structuredClone(patchLayers.flat()), async (hostCtx) => {
	hostCtx.provide('profileContext', {
		name: PROFILE,
		dir: profile.dir,
		patchPath: profile.patchPath,
		installAnchor,
		startedBundles: profile.layers.map((layer) => layer.packageName),
		cwd: process.cwd(),
		home: HOME,
		overlays: []
	});
	hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, loadLayeredEnv('dsh'));
	await hostCtx.plugin(PluginPackages, { resolution });
	provideCmdline(hostCtx, {
		args: web ? ['--port', '0', '--no-open'] : [],
		exit: () => {},
		ready: { onReady: (callback) => { callback(); return () => {}; } }
	});
});

/* ------------------------------------------------------------ verify */

const dispatcherName = () => getGlobalDispatcher().constructor.name;
const isOurs = () => {
	const dispatcher = getGlobalDispatcher();
	return dispatcher.constructor.kind === 'dsh-proxy' || dispatcher.constructor.name === 'EnvHttpProxyAgent' || dispatcher.constructor.name === 'Socks5ProxyAgent';
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(description, predicate, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await sleep(200);
	}
	throw new Error(`probe: timed out waiting for ${description} (dispatcher=${dispatcherName()})`);
}

function check(label, condition, detail) {
	if (!condition) throw new Error(`probe: FAIL ${label}${detail ? ` — ${detail}` : ''}`);
	console.log(`probe: ok ${label}`);
}

try {
	const settings = ctx.get('settings');
	const described = settings.describe();
	const section = described.find((row) => row.ns === 'dsh-proxy');
	check('settings exposes the live entry', Boolean(section) && section.autoGenerate === false);
	await waitFor('proxy dispatcher installed', isOurs);
	check('dispatcher switched to a dsh-proxy dispatcher at boot', isOurs(), dispatcherName());

	check('child env exported', process.env.HTTP_PROXY === proxyUrl && process.env.NO_PROXY === 'example.invalid');

	const body = await (await fetch(originUrl)).text();
	check('fetch routed through settings proxy', body === 'proxy-ok' && proxyHits.length === 1);

	// ---- hot switch off through the same Settings API used by the Web UI
	await settings.update('dsh-proxy', { mode: 'direct' });
	await waitFor('dispatcher restored', () => getGlobalDispatcher() === baseline);
	const direct = await (await fetch(originUrl)).text();
	check('hot-off: fetch direct', direct === 'origin-ok' && originHits.length === 1 && proxyHits.length === 1);
	check('hot-off: env cleared', process.env.HTTP_PROXY === undefined);

	// ---- hot switch on again (proxy port unchanged)
	await settings.update('dsh-proxy', { mode: 'manual' });
	await waitFor('dispatcher re-installed', isOurs);
	const again = await (await fetch(originUrl)).text();
	check('hot-on: fetch via proxy again', again === 'proxy-ok' && proxyHits.length === 2);

	// ---- settings describe sees the section
	const updated = settings.describe().find((row) => row.ns === 'dsh-proxy');
	check('settings describe sees the new mode', updated?.value.mode === 'manual');
	// ---- editing the profile patch directly follows the same live config path
	writeFileSync(profile.patchPath, webPatch + '- id: dsh-proxy\n  config:\n    mode: direct\n');
	await waitFor('profile patch switched to direct', () => getGlobalDispatcher() === baseline);
	writeFileSync(profile.patchPath, webPatch + `- id: dsh-proxy\n  config:\n    mode: manual\n    proxy: ${proxyUrl}\n`);
	await waitFor('profile patch switched back to manual', isOurs);
	check('profile patch edits hot-reload the proxy', settings.describe().find((row) => row.ns === 'dsh-proxy')?.value.mode === 'manual');

	// ---- new loopback semantics through the same live Settings API
	const fetchText = async (url) => (await (await fetch(url)).text());
	await settings.update('dsh-proxy', { bypassLoopback: true, noProxy: ['example.invalid'] });
	await waitFor('default loopback bypass active', async () => (await fetchText(originUrl)) === 'origin-ok');
	check('default bypassLoopback=true: loopback fetch stays direct', originHits.length >= 2);
	check('default bypassLoopback=true: NO_PROXY merges the loopback set',
		process.env.NO_PROXY === 'example.invalid,localhost,127.0.0.1,::1', `NO_PROXY=${process.env.NO_PROXY}`);
	const nonLoopback = await fetchText('http://not-loopback.example/probe');
	check('default bypassLoopback=true: non-loopback host still proxied', nonLoopback === 'proxy-ok', nonLoopback);
	await settings.update('dsh-proxy', { bypassLoopback: false });
	await waitFor('explicit loopback bypass off', async () => (await fetchText(originUrl)) === 'proxy-ok');
	check('bypassLoopback=false: loopback goes through the proxy again', proxyHits.length >= 3);
	check('bypassLoopback=false: NO_PROXY exports user rules only',
		process.env.NO_PROXY === 'example.invalid', `NO_PROXY=${process.env.NO_PROXY}`);

	if (web) {
		await settings.update('dsh-proxy', { mode: 'direct' });
		await waitFor('baseline before status transport check', () => getGlobalDispatcher() === baseline);
		const connection = ctx.get('connection');
		const baseUrl = `http://127.0.0.1:${ctx.get('webServer').port}`;
		const auth = await fetch(connection.authenticatedUrl(baseUrl), { redirect: 'manual' });
		const cookie = auth.headers.get('set-cookie')?.split(';')[0];
		check('web: process-token exchange issues a browser cookie', Boolean(cookie));
		const url = `${baseUrl}/api/dsh-proxy/status`;
		check('web: unauthenticated status is rejected', (await fetch(url)).status === 401);
		check('web: foreign Origin is rejected', (await fetch(url, { headers: { cookie, origin: 'https://untrusted.invalid' } })).status === 403);
		const beforeDispatcher = getGlobalDispatcher();
		const beforeHits = proxyHits.length;
		const response = await fetch(url, { headers: { cookie } });
		const snapshot = await response.json();
		check('web: authenticated GET returns no-store applied snapshot', response.ok && response.headers.get('cache-control') === 'no-store' && snapshot.route === 'baseline' && snapshot.selectedMode === 'direct');
		check('web: status read preserves dispatcher and makes no proxy requests', getGlobalDispatcher() === beforeDispatcher && proxyHits.length === beforeHits);
		await settings.update('dsh-proxy', { mode: 'manual', bypassLoopback: true });
		await waitFor('manual before second status read', isOurs);
		const next = await (await fetch(url, { headers: { cookie } })).json();
		check('web: hot switch updates both endpoint snapshots', next.generation > snapshot.generation && next.httpEndpoint === proxyUrl && next.httpsEndpoint === proxyUrl);
	}
	console.log('probe: ALL PASS — runtime switching verified inside a real DSH boot');
} finally {
	await ctx.fiber.dispose();
	origin.close();
	proxy.close();
}
