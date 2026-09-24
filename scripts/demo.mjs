/**
 * Terminal demo for @tr1v3r/dsh-proxy — real dispatcher switching.
 *
 * Boots a local origin server, an HTTP proxy, and a SOCKS5 proxy, then walks
 * through edits to a demo-only YAML file, applying the resolved values to
 * createEngine (the real Settings path is covered by scripts/boot-probe.mjs). Every fetch
 * below is a real globalThis.fetch through the real global dispatcher slot.
 *
 * Usage: node scripts/demo.mjs   (writes its demo.yaml under os.tmpdir())
 */

import http from 'node:http';
import net from 'node:net';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../lib/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(tmpdir(), 'dsh-proxy-demo'), { recursive: true });
const SETTINGS = join(tmpdir(), 'dsh-proxy-demo', 'demo.yaml');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
const log = (line) => console.log(line);

/* ------------------------------------------------- local target + proxies */

const origin = http.createServer((req, res) => {
	res.writeHead(200, { 'content-type': 'application/json' });
	res.end(JSON.stringify({ ok: true }));
});
await listen(origin);
const originUrl = `http://127.0.0.1:${origin.address().port}/ping`;

const httpSeen = [];
const httpProxy = http.createServer((req, res) => {
	httpSeen.push(req.url);
	const target = new URL(req.url);
	const upstream = http.request(
		{ hostname: target.hostname, port: target.port, path: target.pathname, method: req.method, headers: req.headers },
		(up) => {
			res.writeHead(up.statusCode, up.headers);
			up.pipe(res);
		}
	);
	upstream.on('error', () => res.destroy());
	req.pipe(upstream);
});
await listen(httpProxy);

const socksSeen = [];
const socksProxy = net.createServer((socket) => {
	socket.on('error', () => socket.destroy());
	let phase = 0;
	socket.on('data', function onData(chunk) {
		if (phase === 0) {
			socket.write(Buffer.from([0x05, 0x00]));
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
		socksSeen.push(`${host}:${port}`);
		const upstream = net.connect(port, host, () => {
			socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
			upstream.pipe(socket);
			socket.pipe(upstream);
		});
		upstream.on('error', () => socket.destroy());
		socket.on('error', () => upstream.destroy());
	});
});
await listen(socksProxy);

const PROXY_A = `http://127.0.0.1:${httpProxy.address().port}`;
const PROXY_B = `socks5://127.0.0.1:${socksProxy.address().port}`;

/* --------------------------------------------- demo.yaml → engine */

/**
 * Demo-only parser for the keys this script writes. DSH 0.1.7 reads the real
 * proxy configuration from its profile entry through the Settings API.
 */
function parseDemoSection(text) {
	const section = {};
	let inSection = false;
	for (const rawLine of text.split('\n')) {
		if (/^\S/.test(rawLine)) {
			inSection = /^dsh-proxy:/.test(rawLine);
			continue;
		}
		if (!inSection) continue;
		const match = rawLine.match(/^\s+(mode|enabled|proxy):\s*(\S+)\s*$/);
		if (!match) continue;
		if (match[1] === 'mode') section.mode = match[2];
		if (match[1] === 'enabled') section.enabled = match[2] === 'true';
		if (match[1] === 'proxy') section.proxy = match[2];
	}
	return section;
}

const engine = createEngine(console);

const applyFrom = (text) => {
	const section = parseDemoSection(text);
	writeFileSync(SETTINGS, text);
	engine.apply({
		mode: section.mode,
		enabled: section.enabled,
		proxy: section.proxy,
		exportEnv: false
	});
};

/* ------------------------------------------------------------ narration */

async function probe() {
	const httpBefore = httpSeen.length;
	const socksBefore = socksSeen.length;
	const response = await fetch(originUrl);
	const body = await response.json();
	const exit = httpSeen.length > httpBefore ? 'via HTTP proxy' : socksSeen.length > socksBefore ? 'via SOCKS5 proxy' : 'direct';
	log(`   fetch /ping → ${response.status} ${JSON.stringify(body)}   (${exit})`);
}

function banner(line) {
	log('');
	log(line);
}

/* --------------------------------------------------------------- scene */

log('▲ dsh-proxy routing demo — globalThis.fetch rerouted by editing demo.yaml');
banner('── demo.yaml: mode: direct ────────────────────────────────');
applyFrom('dsh-proxy:\n  mode: direct\n');
await probe();

banner(`── demo.yaml: mode: manual, proxy: http://…:${httpProxy.address().port} ──`);
applyFrom(`dsh-proxy:\n  mode: manual\n  proxy: ${PROXY_A}\n`);
await probe();

banner(`── demo.yaml: mode: manual, proxy: socks5://…:${socksProxy.address().port} ──`);
applyFrom(`dsh-proxy:\n  mode: manual\n  proxy: ${PROXY_B}\n`);
await probe();

banner(`── demo.yaml: mode: system  (env HTTP_PROXY → HTTP proxy) ──`);
process.env.HTTP_PROXY = PROXY_A;
applyFrom('dsh-proxy:\n  mode: system\n');
await probe();
delete process.env.HTTP_PROXY;

banner('── demo.yaml: mode: direct ────────────────────────────────');
applyFrom('dsh-proxy:\n  mode: direct\n');
await probe();

banner('───────────────────────────────────────────────────────────────');
log(`✓ ${httpSeen.length} requests via HTTP proxy · ${socksSeen.length} via SOCKS5 · 0 restarts`);
log('  edit the section, save — every outbound request follows instantly.');

engine.restore();
origin.close();
httpProxy.close();
socksProxy.close();
process.exit(0);
