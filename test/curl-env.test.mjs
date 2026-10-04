import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createEngine, PROXY_ENV_KEYS } from '../lib/index.js';

const exec = promisify(execFile);
// Deliberate allowlist: no inherited *_PROXY, NO_PROXY, curl or loader settings.
const cleanEnv = Object.fromEntries(['PATH', 'SystemRoot'].filter((key) => process.env[key] !== undefined)
	.map((key) => [key, process.env[key]]));

async function listen(server, host) {
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, host, () => {
			server.removeListener('error', reject);
			resolve();
		});
	});
}

for (const { host, target, rule } of [
	{ host: '127.0.0.1', target: '127.0.0.1', rule: '127.0.0.1.' },
	{ host: '127.0.0.1', target: 'localhost', rule: 'LOCALHOST.' },
	{ host: '::1', target: '[::1]', rule: '[::1]' }
]) {
	for (const bypassLoopback of [undefined, false]) {
		test(`curl exported NO_PROXY: ${rule}, bypassLoopback=${bypassLoopback ?? 'default'}`, { timeout: 15000 }, async (t) => {
			try {
				const { stdout } = await exec('curl', ['-q', '--version'], { env: cleanEnv, timeout: 3000 });
				t.diagnostic(stdout.split('\n')[0]);
			} catch (error) {
				if (error.code === 'ENOENT') return t.skip('curl executable not installed');
				throw error;
			}
			const originHits = [];
			const proxyHits = [];
			const origin = http.createServer((req, res) => {
				originHits.push(req.url);
				res.end('origin');
			});
			// A recording proxy sentinel; never forwards, so no request can leave loopback.
			const proxy = http.createServer((req, res) => {
				proxyHits.push(req.url);
				res.end('proxy');
			});
			t.after(async () => {
				for (const server of [origin, proxy]) {
					server.closeAllConnections();
					await new Promise((resolve) => server.close(resolve));
				}
			});
			try {
				await listen(origin, host);
			} catch (error) {
				if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) {
					return t.skip(`IPv6 loopback unavailable: ${error.code}`);
				}
				throw error;
			}
			await listen(proxy, '127.0.0.1');
			const saved = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
			for (const key of PROXY_ENV_KEYS) delete process.env[key];
			const engine = createEngine();
			t.after(() => {
				engine.restore();
				for (const [key, value] of Object.entries(saved)) {
					if (value === undefined) delete process.env[key]; else process.env[key] = value;
				}
			});
			engine.apply({ mode: 'manual', proxy: `http://127.0.0.1:${proxy.address().port}`,
				noProxy: [rule], ...(bypassLoopback === undefined ? {} : { bypassLoopback }) });
			const env = { ...cleanEnv };
			for (const key of PROXY_ENV_KEYS) {
				if (process.env[key] !== undefined) env[key] = process.env[key];
			}
			assert.equal(env.NO_PROXY, env.no_proxy);
			if (bypassLoopback === false) assert.equal(env.NO_PROXY, rule);
			const port = origin.address().port;
			const url = `http://${target}:${port}/route`;
			const args = ['-q', '--silent', '--show-error', '--fail', '--connect-timeout', '2', '--max-time', '3'];
			// Pin localhost to this origin; no DNS or external network is needed.
			if (target === 'localhost') args.push('--resolve', `localhost:${port}:127.0.0.1`);
			const { stdout } = await exec('curl', [...args, url], { env, timeout: 5000 });
			// curl accepts LOCALHOST. for localhost, but not dotted IPv4 or bracketed IPv6.
			// This records curl's behavior, not a cross-client equivalence guarantee.
			const direct = bypassLoopback !== false || target === 'localhost';
			t.diagnostic(`NO_PROXY=${env.NO_PROXY}; route=${stdout}; origin=${originHits.length}; proxy=${proxyHits.length}`);
			assert.equal(stdout, direct ? 'origin' : 'proxy');
			assert.deepEqual(originHits, direct ? ['/route'] : []);
			assert.deepEqual(proxyHits, direct ? [] : [url]);
		});
	}
}
