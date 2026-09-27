/**
 * @tr1v3r/dsh-proxy — runtime-switchable outbound proxy for the DeepSeek Harness.
 *
 * The `dsh-proxy` profile entry config is hot-reloaded by DSH. It routes every
 * in-process `globalThis.fetch` request through an HTTP(S)
 * CONNECT proxy or a SOCKS5 proxy — and flips back to direct — without
 * restarting dsh. Child processes spawned after a switch (bash tool curl/git,
 * MCP stdio servers) follow along through exported HTTP(S)_PROXY/NO_PROXY
 * variables.
 *
 * Mechanics: DSH and pi-ai issue LLM/web requests via `globalThis.fetch`,
 * which reads the well-known global dispatcher slot
 * (`Symbol.for('undici.globalDispatcher.1')`). Swapping that dispatcher
 * redirects all undici-based outbound traffic in the process.
 */

import { execFileSync } from 'node:child_process';
import { Agent, Dispatcher, EnvHttpProxyAgent, Socks5ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import z from '@deepseek-ai/schemastery';

/** Cordis plugin tree id (independent of the npm package name). */
export const name = 'dsh-proxy';
/** No hard service dependencies; settings is injected opportunistically. */
export const inject = [];

/** Settings namespace matching the plugin's profile entry id. */
export const PROXY_SETTINGS_NAMESPACE = 'dsh-proxy';

/** Routing modes the section accepts. `system` follows the ambient proxy. */
export const ProxyMode = z.union([z.const('direct'), z.const('system'), z.const('manual')]);

/** Live schema of the `dsh-proxy` profile entry config. */
export const Config = z.object({
	/**
	 * Routing mode: `direct` (no proxy), `system` (follow the OS/ambient proxy)
	 * or `manual` (use the `proxy` URL below). When omitted, the deprecated
	 * `enabled` flag decides (`false` → direct, `true` → manual).
	 */
	mode: ProxyMode,
	/** Deprecated master switch; superseded by `mode`. `false` routes direct. */
	enabled: z.boolean().default(false),
	/** Proxy URL: http(s)://host:port or socks5://[user:pass@]host:port. */
	proxy: z.string(),
	/** Hosts that bypass the proxy (curl-style: host, .suffix, host:port, *). */
	noProxy: z.array(z.string()),
	/** Also export HTTP(S)_PROXY/NO_PROXY env to child processes (manual only). */
	exportEnv: z.boolean().default(true),
	/**
	 * Always route loopback traffic (localhost, 127.0.0.0/8, ::1, 0.0.0.0)
	 * direct, regardless of noProxy rules. Default true; set false to route
	 * loopback through the proxy like any other host.
	 */
	bypassLoopback: z.boolean().default(true)
}).volatile();

/** Every routing mode the section accepts (for validation/display). */
export const PROXY_MODES = ['direct', 'system', 'manual'];

/**
 * Resolve the effective routing mode from a resolved section, honoring the
 * deprecated `enabled` flag only when `mode` is absent.
 * @param config - resolved section ({ mode, enabled, ... }).
 * @returns one of `direct` | `system` | `manual`.
 */
export function resolveMode(config) {
	const mode = config?.mode;
	if (PROXY_MODES.includes(mode)) return mode;
	return config?.enabled === true ? 'manual' : 'direct';
}

/**
 * Normalize a resolved section into the effective config the engine consumes.
 * Backward compatible: `{ enabled: true, proxy }` still means manual mode.
 * @param config - resolved section or raw entry object.
 * @returns { mode, proxy, noProxy, exportEnv, bypassLoopback }.
 */
export function resolveConfig(config) {
	const source = config ?? {};
	return {
		mode: resolveMode(source),
		proxy: source.proxy,
		noProxy: source.noProxy ?? [],
		exportEnv: source.exportEnv ?? true,
		bypassLoopback: source.bypassLoopback ?? true
	};
}

/** Default loopback set merged into exported NO_PROXY (see {@link isLoopbackHostname}). */
export const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1'];

/**
 * Whether `hostname` is a loopback literal. Covers the `localhost` name,
 * every address in 127.0.0.0/8, `::1` (any case, brackets already stripped
 * by {@link matchesNoProxy}/`originParts`) and the this-host address 0.0.0.0.
 * @param hostname - request host (lowercase FQDN or IP literal).
 * @returns true when the host is loopback.
 */
export function isLoopbackHostname(hostname) {
	let host = String(hostname ?? '').toLowerCase().replace(/^\[(.+)\]$/, '$1');
	if (!host) return false;
	// WHATWG URL keeps the FQDN root label: `http://localhost./x` arrives as
	// hostname `localhost.` — normalize a single trailing dot away.
	if (host.endsWith('.') && !host.endsWith('..')) host = host.slice(0, -1);
	if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
	// 127.0.0.0/8: any address whose dotted-quad form starts with 127.
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Merge user noProxy rules with the default loopback set (deduplicated,
 * case-insensitive, brackets stripped for comparison; user order preserved).
 * @param rules - user noProxy entries.
 * @returns merged list, user rules first, loopback entries appended.
 */
export function mergeLoopbackNoProxy(rules) {
	const seen = new Set();
	const add = (value) => {
		const key = String(value ?? '').trim().toLowerCase().replace(/^\[(.+)\]$/, '$1');
		if (!key || seen.has(key)) return;
		seen.add(key);
		merged.push(String(value).trim());
	};
	const merged = [];
	for (const rule of rules ?? []) add(rule);
	for (const rule of LOOPBACK_NO_PROXY) add(rule);
	return merged;
}

/**
 * Split a curl-style `no_proxy` value into rules (comma-separated).
 * @param value - raw `NO_PROXY`/`no_proxy` string.
 * @returns trimmed, non-empty rules.
 */
export function parseNoProxyList(value) {
	if (!value) return [];
	return String(value)
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
}

/** Env keys that carry the proxy URL itself (exported to child processes). */
export const PROXY_ONLY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
/** Env keys that carry the bypass list. */
export const NO_PROXY_ENV_KEYS = ['NO_PROXY', 'no_proxy'];
/** Every env key this plugin may read or write (snapshot + restore surface). */
export const PROXY_ENV_KEYS = [...PROXY_ONLY_ENV_KEYS, ...NO_PROXY_ENV_KEYS];

/** Grace period before force-destroying a retired dispatcher's sockets. */
const RETIRE_DESTROY_MS = 30_000;

/** Canonical proxy protocol → dispatcher factory. */
const PROXY_AGENT_FACTORIES = {
	// `noProxy` frozen to '': undici's EnvHttpProxyAgent re-reads the live
	// NO_PROXY/no_proxy env on every parse and would silently re-apply an
	// operator or exported bypass list on the HTTP leg only, diverging from
	// the SOCKS leg. RoutingDispatcher owns all noProxy routing instead.
	http: (url) => new EnvHttpProxyAgent({ httpProxy: url, httpsProxy: url, noProxy: '' }),
	https: (url) => new EnvHttpProxyAgent({ httpProxy: url, httpsProxy: url, noProxy: '' }),
	socks5: (url) => new Socks5ProxyAgent(url)
};

/** URL scheme aliases folded onto a canonical protocol. */
const PROTOCOL_ALIASES = { socks5h: 'socks5', socks: 'socks5' };

/**
 * Whether a request to `hostname`:`port` matches a noProxy rule list.
 * Semantics mirror undici's EnvHttpProxyAgent (bare entries match the host
 * and its dot-boundary subdomains; `host:port` pins the port; `*` matches
 * everything). A leading dot or `*.` prefix is accepted as a synonym of the
 * bare entry (`.internal.example` ≡ `internal.example`).
 * @param hostname - lowercase request host (FQDN or IP literal).
 * @param port - request port as string, or null when unknown.
 * @param rules - raw noProxy entries (whitespace tolerated).
 * @returns true when the request must bypass the proxy.
 */
export function matchesNoProxy(hostname, port, rules) {
	const host = String(hostname ?? '').toLowerCase();
	if (!host || !rules?.length) return false;
	const portNumber = port == null ? null : Number(port);
	for (const rawRule of rules) {
		const rule = String(rawRule ?? '').trim().toLowerCase();
		if (!rule) continue;
		if (rule === '*') return true;
		let candidate = rule;
		let rulePort = null;
		const colon = rule.lastIndexOf(':');
		if (colon !== -1 && rule.indexOf(':') === colon) {
			candidate = rule.slice(0, colon);
			rulePort = rule.slice(colon + 1);
		}
		if (candidate.startsWith('[') && candidate.endsWith(']')) candidate = candidate.slice(1, -1);
		if (candidate.startsWith('.')) candidate = candidate.slice(1);
		if (candidate.startsWith('*.')) candidate = candidate.slice(2);
		if (!candidate) continue;
		if (rulePort !== null && Number(rulePort) !== portNumber) continue;
		if (host === candidate || host.endsWith('.' + candidate)) return true;
	}
	return false;
}

/**
 * @typedef {Object} OriginParts
 * @property {string} hostname - request host (lowercase).
 * @property {string} port - effective port, defaulted from the scheme.
 */

/**
 * Split a request origin (string or URL) into hostname/port. IPv6 literals
 * lose their brackets so matcher rules written either way ([::1] or ::1)
 * compare against the same host.
 * @returns {OriginParts | null} null when the origin is unusable.
 */
function originParts(origin) {
	try {
		const url = typeof origin === 'string' ? new URL(origin) : origin;
		if (!url?.hostname) return null;
		const hostname = url.hostname.replace(/^\[(.+)\]$/, '$1').toLowerCase();
		return { hostname, port: url.port || (url.protocol === 'https:' ? '443' : '80') };
	} catch {
		return null;
	}
}

/**
 * @typedef {Object} NormalizedProxy
 * @property {string} url - normalized proxy URL.
 * @property {string} protocol - canonical protocol (http|https|socks5).
 */

/** Normalize a proxy URL for undici: fold aliases onto canonical protocols. @returns {NormalizedProxy} */
function normalizeProxyUrl(raw) {
	const url = new URL(raw);
	const rawProtocol = url.protocol.replace(/:$/, '').toLowerCase();
	const protocol = PROTOCOL_ALIASES[rawProtocol] ?? rawProtocol;
	if (!Object.hasOwn(PROXY_AGENT_FACTORIES, protocol)) {
		throw new Error(`unsupported proxy protocol "${protocol}" (use http/https/socks5/socks5h)`);
	}
	url.protocol = `${protocol}:`;
	return { url: url.href, protocol };
}

/**
 * Dispatcher that sends matching origins direct and everything else through
 * a proxy dispatcher (needed for SOCKS, where undici has no built-in noProxy).
 */
class RoutingDispatcher extends Dispatcher {
	/** Marker so hosts/probes can recognize dsh-proxy dispatchers. */
	static kind = 'dsh-proxy';

	#direct;
	#proxied;
	#rules;
	#bypassLoopback;

	constructor(direct, proxied, rules, bypassLoopback) {
		super();
		this.#direct = direct;
		this.#proxied = proxied;
		this.#rules = rules;
		this.#bypassLoopback = bypassLoopback ?? false;
	}

	dispatch(options, handler) {
		const parts = originParts(options?.origin);
		const bypass = parts !== null
			&& (this.#bypassLoopback && isLoopbackHostname(parts.hostname)
				|| matchesNoProxy(parts.hostname, parts.port, this.#rules));
		return (bypass ? this.#direct : this.#proxied).dispatch(options, handler);
	}

	/** Fan a lifecycle call out to both inner dispatchers. */
	#fan(method) {
		return Promise.allSettled([this.#direct[method](), this.#proxied[method]()]).then(() => {});
	}

	close() {
		return this.#fan('close');
	}

	destroy() {
		return this.#fan('destroy');
	}
}

/**
 * Build the undici dispatcher for a resolved configuration. With noProxy
 * rules present, every protocol routes through {@link RoutingDispatcher} so
 * HTTP and SOCKS share the exact same matcher semantics.
 * @param config - resolved section: { enabled, proxy, noProxy, exportEnv }.
 * @returns an undici Dispatcher installing the described routing.
 * @throws when the proxy URL is unparseable or its protocol unsupported.
 */
/** Wrap `proxied` in the shared routing dispatcher when bypass routing exists. */
function withBypass(proxied, rules, bypassLoopback) {
	return rules?.length || bypassLoopback
		? new RoutingDispatcher(new Agent(), proxied, rules, bypassLoopback)
		: proxied;
}

export function buildDispatcher(config) {
	const { url, protocol } = normalizeProxyUrl(config.proxy);
	// noProxy deliberately NOT passed on: RoutingDispatcher owns routing so
	// HTTP and SOCKS paths apply identical matcher semantics.
	return withBypass(PROXY_AGENT_FACTORIES[protocol](url), config.noProxy, config.bypassLoopback ?? true);
}

/**
 * Build the dispatcher for `system` mode from a detected proxy spec.
 * HTTP(S) wins over SOCKS; both share one RoutingDispatcher so the bypass
 * list applies identically to every protocol.
 * @param detected - normalized {@link detectSystemProxy} result.
 * @param bypassLoopback - honor the section's loopback bypass (default true).
 * @returns an undici Dispatcher following the detected system proxy.
 */
export function buildSystemDispatcher(detected, bypassLoopback = true) {
	const rules = detected?.noProxy ?? [];
	if (detected?.httpProxy || detected?.httpsProxy) {
		// Both legs pinned explicitly so the agent never re-reads env for the
		// missing leg; RoutingDispatcher owns all bypass decisions instead.
		const http = detected.httpProxy ?? detected.httpsProxy;
		const https = detected.httpsProxy ?? detected.httpProxy;
		return withBypass(new EnvHttpProxyAgent({ httpProxy: http, httpsProxy: https, noProxy: '' }), rules, bypassLoopback);
	}
	if (detected?.socksProxy) {
		return withBypass(new Socks5ProxyAgent(detected.socksProxy), rules, bypassLoopback);
	}
	return new Agent();
}

/**
 * Parse `scutil --proxy` output (NeXTSTEP plist text) into a normalized proxy
 * spec. Handles HTTP/HTTPS/SOCKS explicit proxies and the `ExceptionsList`
 * bypass list. PAC / auto-discovery are reported via the `pac` flag (they
 * cannot be followed without executing the PAC script).
 * @param text - raw `scutil --proxy` stdout.
 * @returns { httpProxy?, httpsProxy?, socksProxy?, noProxy, pac } — values are
 * normalized proxy URLs; `noProxy` is always an array.
 */
export function parseScutilProxy(text) {
	const source = String(text ?? '');
	const bool = (key) => new RegExp(`\\b${key}\\s*:\\s*1\\b`).test(source);
	const str = (key) => source.match(new RegExp(`\\b${key}\\s*:\\s*([^\\s\\n]+)`))?.[1];
	const list = (key) => {
		const idx = source.indexOf(`${key} : <array>`);
		if (idx === -1) return [];
		const open = source.indexOf('{', idx);
		const close = open === -1 ? -1 : source.indexOf('}', open);
		if (open === -1 || close === -1) return [];
		return source
			.slice(open + 1, close)
			.split('\n')
			.map((line) => line.replace(/^\s*\d+\s*:\s*/, '').trim())
			.filter(Boolean);
	};

	const pac = bool('ProxyAutoConfigEnable') || bool('ProxyAutoDiscoveryEnable');
	const httpHost = bool('HTTPEnable') ? str('HTTPProxy') : undefined;
	const httpsHost = bool('HTTPSEnable') ? str('HTTPSProxy') : undefined;
	const socksHost = bool('SOCKSEnable') ? str('SOCKSProxy') : undefined;
	// Only read a port when its protocol is enabled, so a stale/disabled port
	// value can never leak into the normalized URL.
	const httpPort = httpHost ? str('HTTPPort') : undefined;
	const httpsPort = httpsHost ? str('HTTPSPort') : undefined;
	const socksPort = socksHost ? str('SOCKSPort') : undefined;

	return {
		httpProxy: httpHost ? `http://${httpHost}:${httpPort}` : undefined,
		httpsProxy: httpsHost ? `http://${httpsHost}:${httpsPort}` : undefined,
		socksProxy: socksHost ? `socks5://${socksHost}:${socksPort}` : undefined,
		noProxy: list('ExceptionsList'),
		pac
	};
}

/**
 * Detect the proxy the host expects outbound traffic to follow:
 * 1. `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` (+ `NO_PROXY`) env vars — the
 *    cross-platform baseline every proxy tool on macOS/Linux exports.
 * 2. macOS: the System Settings network-service proxies via `scutil --proxy`.
 *    (Windows registry and PAC follow-up are out of scope for now.)
 * @param platform - override for tests (defaults to process.platform).
 * @param env - override for tests (defaults to process.env).
 * @returns normalized spec (see {@link parseScutilProxy}) or null when no
 * usable proxy is configured.
 */
export function detectSystemProxy(platform = process.platform, env = process.env) {
	let httpProxy = env?.HTTP_PROXY || env?.http_proxy;
	let httpsProxy = env?.HTTPS_PROXY || env?.https_proxy;
	const noProxy = parseNoProxyList(env?.NO_PROXY ?? env?.no_proxy);

	// curl-style catch-all: honored only when the per-protocol vars are absent.
	// http(s) ALL_PROXY serves both legs; socks* ALL_PROXY routes via SOCKS5.
	const allProxy = env?.ALL_PROXY || env?.all_proxy;
	let socksProxy;
	if (allProxy && !httpProxy && !httpsProxy) {
		let scheme = '';
		try {
			scheme = new URL(allProxy).protocol.replace(/:$/, '').toLowerCase();
		} catch {
			scheme = '';
		}
		if (scheme === 'socks' || scheme === 'socks5' || scheme === 'socks5h') socksProxy = normalizeProxyUrl(allProxy).url;
		else {
			httpProxy = allProxy;
			httpsProxy = allProxy;
		}
	}

	if (httpProxy || httpsProxy) return { httpProxy, httpsProxy, socksProxy, noProxy, pac: false };
	if (socksProxy) return { httpProxy: undefined, httpsProxy: undefined, socksProxy, noProxy, pac: false };

	if (platform === 'darwin') {
		try {
			const text = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 5000 });
			const detected = parseScutilProxy(text);
			// PAC/WPAD scripts cannot be executed here; report nothing usable.
			if (detected.pac && !detected.httpProxy && !detected.httpsProxy && !detected.socksProxy) return null;
			return detected;
		} catch {
			return null;
		}
	}

	return null;
}

/** Snapshot of env keys this engine may overwrite (value = previous or null). */
function snapshotEnv() {
	const snapshot = {};
	for (const key of PROXY_ENV_KEYS) snapshot[key] = key in process.env ? process.env[key] : null;
	return snapshot;
}

/** Restore the env snapshot taken before the first export. */
function restoreEnv(snapshot) {
	for (const [key, prior] of Object.entries(snapshot)) {
		if (prior === null) delete process.env[key];
		else process.env[key] = prior;
	}
}

/**
 * Create the export/restore side of the engine's env management.
 * Owns the snapshot and the record of values this engine itself wrote, so
 * operator values that appear mid-session are adopted into the snapshot
 * (preserved and restored) instead of being clobbered by the next hot switch.
 * @returns {object} with `export(config)` and `restore()`.
 */
function createEnvManager() {
	let snapshot = null;
	let exported = {};

	/** Drop everything this engine exported, restoring adopted values. */
	function restore() {
		if (!snapshot) return;
		restoreEnv(snapshot);
		snapshot = null;
		exported = {};
	}

	/**
	 * Export proxy env vars for child processes (never clobbering operator
	 * values) or, when the active config stops asking for export, restore.
	 * Env export is a manual-mode concept only — system mode must not write
	 * the vars it is reading.
	 * @param effective - normalized config: { mode, proxy, noProxy, exportEnv }.
	 */
	function sync(effective) {
		if (effective.mode !== 'manual' || !effective.proxy || effective.exportEnv === false) {
			restore();
			return;
		}
		const next = snapshot ?? snapshotEnv();
		// Bypass list exported to children: user rules merged with the default
		// loopback set (dedup) so loopback stays direct in curl/git too. With
		// bypassLoopback=false the in-process router ignores the loopback set,
		// so export exactly the user rules (previous behavior).
		const noProxy = effective.bypassLoopback === false
			? (effective.noProxy?.length ? effective.noProxy.join(',') : undefined)
			: mergeLoopbackNoProxy(effective.noProxy).join(',');
		for (const key of PROXY_ONLY_ENV_KEYS) {
			adoptOperatorValue(next, key);
			if (next[key] === null) {
				process.env[key] = effective.proxy;
				exported[key] = effective.proxy;
			}
		}
		for (const key of NO_PROXY_ENV_KEYS) {
			adoptOperatorValue(next, key);
			if (next[key] !== null) continue;
			if (noProxy) {
				process.env[key] = noProxy;
				exported[key] = noProxy;
			} else {
				delete process.env[key]; // clear a previously exported bypass list
				delete exported[key];
			}
		}
		snapshot = next;
	}

	/** Preserve a value the operator set mid-session instead of clobbering it. */
	function adoptOperatorValue(next, key) {
		const live = process.env[key];
		if (next[key] === null && live !== undefined && live !== exported[key]) next[key] = live;
	}

	return { sync, restore };
}

/** Gracefully retire a replaced dispatcher, then force-close leftovers. */
function retire(dispatcher) {
	Promise.resolve(dispatcher.close?.()).catch(() => {});
	const timer = setTimeout(() => {
		Promise.resolve(dispatcher.destroy?.()).catch(() => {});
	}, RETIRE_DESTROY_MS);
	timer.unref?.();
}

/**
 * Create the switch engine: applies resolved sections onto the global
 * dispatcher + env, restoring the pre-plugin state on disable/dispose.
 * @param logger - cordis logger (or null in tests).
 * @returns engine with `apply(config)` and `restore()`.
 */
export function createEngine(logger) {
	let baseline;
	let installed = null;
	const env = createEnvManager();

	function log(level, message) {
		logger?.[level]?.(message);
	}

	function apply(config) {
		const effective = resolveConfig(config);
		if (baseline === undefined) baseline = getGlobalDispatcher();
		if (installed) {
			const retired = installed;
			installed = null;
			setGlobalDispatcher(baseline);
			retire(retired);
		}

		if (effective.mode === 'direct') {
			env.restore();
			log('info', 'dsh-proxy: direct (mode: direct)');
			return;
		}

		if (effective.mode === 'system') {
			// Never let our own earlier env export pollute the system-proxy read.
			env.restore();
			let detected;
			try {
				detected = detectSystemProxy();
			} catch (error) {
				log('error', `dsh-proxy: cannot read the system proxy, staying direct — ${error.message}`);
				return;
			}
			if (!detected || (!detected.httpProxy && !detected.httpsProxy && !detected.socksProxy)) {
				log('info', 'dsh-proxy: no usable system proxy — staying direct');
				return;
			}
			let dispatcher;
			try {
				dispatcher = buildSystemDispatcher(detected, effective.bypassLoopback);
			} catch (error) {
				log('error', `dsh-proxy: cannot follow the system proxy, staying direct — ${error.message}`);
				return;
			}
			installed = dispatcher;
			setGlobalDispatcher(dispatcher);
			log('info', `dsh-proxy: following system proxy (${describeSystemProxy(detected)})`);
			return;
		}

		// manual
		if (!effective.proxy) {
			env.restore();
			log('error', 'dsh-proxy: manual mode without a proxy URL — staying direct');
			return;
		}
		let dispatcher;
		try {
			dispatcher = buildDispatcher(effective);
		} catch (error) {
			env.restore();
			log('error', `dsh-proxy: invalid configuration, staying direct — ${error.message}`);
			return;
		}
		installed = dispatcher;
		setGlobalDispatcher(dispatcher);
		env.sync(effective);
		const rules = effective.noProxy?.length ? `, noProxy ${effective.noProxy.length} rule(s)` : '';
		log('info', `dsh-proxy: routing global fetch via ${redact(effective.proxy)}${rules}`);
	}

	function restore() {
		if (baseline !== undefined && installed) {
			setGlobalDispatcher(baseline);
			retire(installed);
			installed = null;
		}
		env.restore();
	}

	return { apply, restore };
}

/** Human-readable summary of a detected system proxy for the switch log. */
function describeSystemProxy(detected) {
	const url = detected.httpProxy ?? detected.httpsProxy ?? detected.socksProxy;
	const parts = [url ? redact(url) : 'direct'];
	if (detected.noProxy?.length) parts.push(`noProxy ${detected.noProxy.length} rule(s)`);
	return parts.join(', ');
}

/** Mask userinfo in a proxy URL before logging it. */
function redact(proxyUrl) {
	try {
		const url = new URL(proxyUrl);
		if (url.username || url.password) return `${url.protocol}//***@${url.host}`;
		return url.href;
	} catch {
		return '<invalid url>';
	}
}

/**
 * Cordis entry. DSH updates the volatile config reference in place when the
 * profile entry changes, then emits `loader/volatile-update` on this context.
 * @param ctx - cordis context.
 * @param config - entry config resolved through {@link Config}.
 */
export function apply(ctx, config = {}) {
	const engine = createEngine(ctx?.logger);
	const settings = typeof config?.get === 'function' ? config : Config(config ?? {});

	engine.apply(settings.get());
	ctx.on?.('loader/volatile-update', () => engine.apply(settings.get()));

	ctx.inject?.(['settings'], (settingsCtx) => {
		settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber));
	});

	ctx.on?.('dispose', () => engine.restore());
}
