import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function mountClient(react = { createElement: (...args) => args }) {
	let registration;
	const context = {
		window: { __ModuleLoader__: { load: (module) => { registration = module; } } },
		URL,
		document: {
			querySelector: () => null,
			createElement: () => ({ dataset: {} }),
			head: { appendChild: () => {} }
		}
	};
	runInNewContext(source, context);
	return registration.factory((id) => {
		if (id === 'react') return react;
		if (id === '@deepseek-ai/dsh-client-ui-primitives') return {
			Menu: () => {}, Tooltip: () => {}, IconChevronDownOutlineRegular: () => {}, IconGlobeOutlineRegular: () => {}
		};
		assert.fail(`unexpected browser import: ${id}`);
	});
}

test('Web client is discoverable by the DSH module loader', () => {
	assert.equal(pkg.exports['./client'], './lib/client.js');
	assert.equal(pkg.dsh.client.platform, 'web');
	assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'));
	assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-primitives'));
	assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'));
	assert.ok(pkg.files.includes('lib'));
});

test('client registers a General settings row backed by the existing namespace', () => {
	const client = mountClient();
	assert.deepEqual(Array.from(client.inject), ['slots', 'locale', 'configForms']);
	let bound;
	const rows = new Map();
	const scope = { getSnapshot: () => ({ status: 'ready', value: { mode: 'direct' } }) };
	const ctx = {
		effect: (callback) => callback(),
		locale: { register: () => () => {}, bind: () => (key) => key },
		configForms: { get: (entryId) => { bound = entryId; return scope; } },
		slots: {
			inject: (name, callback) => { assert.ok(['settings.general.item', 'sidebar.footer.action'].includes(name)); callback(); },
			register: (options, component) => { rows.set(options.name, { options, component }); }
		}
	};
	client.apply(ctx);
	assert.equal(bound, 'dsh-proxy');
	assert.equal(rows.get('settings.general.item').options.id, 'dsh-proxy');
	assert.equal(rows.get('settings.general.item').options.inject().scope, scope);
	assert.equal(rows.get('sidebar.footer.action').options.id, 'dsh-proxy-status');
	assert.equal(rows.get('sidebar.footer.action').options.inject().scope, scope);
	assert.equal(typeof rows.get('sidebar.footer.action').component, 'function');
});

test('proxy mode uses the DSH menu primitive with no Apply button', () => {
	assert.match(source, /React\.createElement\(Menu, \{/);
	assert.match(source, /React\.createElement\(IconChevronDownOutlineRegular/);
	assert.match(source, /onSelect: \(mode\) => \{ setOpen\(false\); changeMode\(mode\); \}/);
	assert.doesNotMatch(source, /React\.createElement\('select'|dshProxyApply|type: 'submit'/);
});

function quickHarness(initial) {
	let snapshot = initial;
	let changed = () => {};
	const calls = [];
	const pending = [];
	const scope = {
		getSnapshot: () => snapshot,
		subscribe: (listener) => { changed = listener; return () => { changed = () => {}; }; },
		mutate: (ops, revision) => {
			calls.push({ ops, revision });
			return new Promise((resolve) => pending.push(resolve));
		}
	};
	const states = [];
	let cursor = 0;
	const effects = [];
	const react = {
		createElement: (type, props, ...children) => {
			assert.notEqual(type, undefined, 'DSH UI primitive must be exported');
			return { type, props: { ...props, children } };
		},
		useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
		useCallback: (fn) => fn,
		useState: (initialState) => {
			const index = cursor++;
			if (!(index in states)) states[index] = typeof initialState === 'function' ? initialState() : initialState;
			return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
		},
		useRef: (initialValue) => { const index = cursor++; return states[index] ??= { current: initialValue }; },
		useEffect: (effect) => { effects.push(effect); }
	};
	const client = mountClient(react);
	let quick;
	let row;
	client.apply({
		effect: () => {},
		locale: { register: () => () => {}, bind: () => (key, vars) => vars?.endpoint ? `${key}: ${vars.endpoint}` : key },
		configForms: { get: () => scope },
		slots: { inject: (_name, fn) => fn(), register: (options, component) => {
			if (options.name === 'sidebar.footer.action') quick = component;
			if (options.name === 'settings.general.item') row = component;
		} }
	});
	const render = (wide = true) => { cursor = 0; return quick({ scope, t: (key, vars) => vars?.endpoint ? `${key}: ${vars.endpoint}` : key, wide }); };
	const renderRow = () => { cursor = 0; return row({ scope, t: (key) => key }); };
	const walk = (tree, predicate) => {
		if (!tree || typeof tree !== 'object') return null;
		if (predicate(tree)) return tree;
		for (const child of tree.props?.children ?? []) {
			const found = walk(child, predicate);
			if (found) return found;
		}
		return walk(tree.props?.anchor, predicate);
	};
	return {
		render, renderRow, walk, calls, pending, effects, scope,
		set: (next) => { snapshot = next; changed(); }
	};
}

test('both Web slots render with the primitives exported by DSH 0.1.7', () => {
	const h = quickHarness(snapshot('direct'));
	assert.equal(h.render().props.className, 'dshProxyQuick');
	assert.equal(h.renderRow().props.className, 'dshProxyRow');
});

function snapshot(mode, proxy = '', revision = 1, writable = true) {
	return { status: 'ready', value: { mode, proxy }, user: { mode }, revision, writable };
}

test('quick action keeps mode in tooltip but displays only icon at every sidebar width', () => {
	const h = quickHarness(snapshot('manual', 'socks5://user:secret@127.0.0.1:1080'));
	let tree = h.render();
	const anchor = h.walk(tree, (node) => node.props?.className === 'dshProxyQuickButton');
	assert.match(anchor.props['aria-label'], /manualEndpoint: socks5:\/\/\*\*\*@127\.0\.0\.1:1080/);
	assert.doesNotMatch(anchor.props['aria-label'], /user|secret/);
	assert.equal(tree.props['data-mode'], 'manual');
	assert.equal(h.walk(tree, (node) => node.props?.className === 'dshProxyQuickState'), null);
	assert.equal(h.walk(tree, (node) => node.props?.className === 'dshProxyQuickText'), null);
	assert.ok(h.walk(anchor, (node) => node.props?.className === 'dshProxyQuickIcon'));
	tree = h.render(false);
	assert.equal(h.walk(tree, (node) => node.props?.className === 'dshProxyQuickState'), null);
	assert.ok(h.walk(tree, (node) => node.props?.className === 'dshProxyQuickIcon'));
	h.set(snapshot('system', '', 2));
	tree = h.render();
	assert.match(h.walk(tree, (node) => node.props?.className === 'dshProxyQuickButton').props['aria-label'], /systemUnknown/);
	assert.equal(tree.props['data-mode'], 'system');
});

test('quick switch fences writes and leaves the actual mode unchanged on conflict', async () => {
	const h = quickHarness(snapshot('direct'));
	let tree = h.render();
	const menu = h.walk(tree, (node) => node.props?.items?.length === 3);
	const first = menu.props.onSelect('system');
	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0].revision, 1);
	assert.deepEqual(Array.from(h.calls[0].ops, (op) => op.path[0]), ['mode']);
	menu.props.onSelect('manual');
	assert.equal(h.calls.length, 1);
	h.set(snapshot('direct', '', 2));
	h.pending.shift()();
	await first;
	tree = h.render();
	assert.equal(tree.props['data-mode'], 'direct');
	assert.ok(h.walk(tree, (node) => node.props?.role === 'alert'));
});

test('quick switch declines unconfigured manual mode and handles read-only state', () => {
	const h = quickHarness(snapshot('direct'));
	let tree = h.render();
	let menu = h.walk(tree, (node) => node.props?.items?.length === 3);
	menu.props.onSelect('manual');
	assert.equal(h.calls.length, 0);
	assert.ok(h.walk(h.render(), (node) => node.props?.role === 'alert'));
	h.set(snapshot('direct', '', 2, false));
	tree = h.render();
	menu = h.walk(tree, (node) => node.props?.items?.length === 3);
	assert.equal(h.walk(tree, (node) => node.props?.className === 'dshProxyQuickButton').props.disabled, false);
	menu.props.onSelect('system');
	assert.equal(h.calls.length, 0);
	assert.ok(h.walk(h.render(), (node) => node.props?.role === 'alert'));
});

test('quick action centres itself in the sidebar footer row', () => {
	// The footer row is `align-items:normal`, so a registrant lines up with its
	// siblings only by centring itself. Sibling triggers are 36px tall with a
	// 16px icon in the wide column and 18px in the rail.
	assert.match(source, /\.dshProxyQuick\{[^}]*align-self:center[^}]*\}/);
	assert.doesNotMatch(source, /\.dshProxyQuick\{[^}]*margin:8px/);
	assert.match(source, /IconGlobeOutlineRegular, \{ size: wide \? 16 : 18 \}/);
});

test('manual edits save on blur and invalid URLs cannot be committed', () => {
	assert.match(source, /onBlur: commitManual/);
	assert.match(source, /!proxyValid\(draft\.proxy\.trim\(\)\)\) return/);
	assert.match(source, /await scope\.mutate\(/);
});
