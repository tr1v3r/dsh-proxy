import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function mountClient() {
	let registration;
	const context = {
		window: { __ModuleLoader__: { load: (module) => { registration = module; } } },
		document: {
			querySelector: () => null,
			createElement: () => ({ dataset: {} }),
			head: { appendChild: () => {} }
		}
	};
	runInNewContext(source, context);
	return registration.factory((id) => {
		if (id === 'react') return { createElement: (...args) => args };
		if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Menu: () => {}, IconChevronDownOutline14: () => {} };
		assert.fail(`unexpected browser import: ${id}`);
	});
}

test('Web client is discoverable by the DSH module loader', () => {
	assert.equal(pkg.exports['./client'], './lib/client.js');
	assert.equal(pkg.dsh.client.platform, 'web');
	assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'));
	assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-primitives'));
	assert.ok(pkg.files.includes('lib'));
});

test('client registers a General settings row backed by the existing namespace', () => {
	const client = mountClient();
	assert.deepEqual(Array.from(client.inject), ['slots', 'locale', 'settingsScope']);
	let bound;
	let row;
	const scope = { getSnapshot: () => ({ status: 'ready', value: { mode: 'direct' } }) };
	const ctx = {
		effect: (callback) => callback(),
		locale: { register: () => () => {}, bind: () => (key) => key },
		settingsScope: { bind: (spec) => { bound = spec.namespace; return scope; } },
		slots: {
			inject: (name, callback) => { assert.equal(name, 'settings.general.item'); callback(); },
			register: (options, component) => { row = { options, component }; }
		}
	};
	client.apply(ctx);
	assert.equal(bound, 'dsh-proxy');
	assert.equal(row.options.id, 'dsh-proxy');
	assert.equal(row.options.inject().scope, scope);
	assert.equal(typeof row.component, 'function');
});

test('proxy mode uses the DSH menu primitive with no Apply button', () => {
	assert.match(source, /React\.createElement\(Menu, \{/);
	assert.match(source, /React\.createElement\(IconChevronDownOutline14/);
	assert.match(source, /onSelect: \(mode\) => \{ setOpen\(false\); changeMode\(mode\); \}/);
	assert.doesNotMatch(source, /React\.createElement\('select'|dshProxyApply|type: 'submit'/);
});

test('manual edits save on blur and invalid URLs cannot be committed', () => {
	assert.match(source, /onBlur: commitManual/);
	assert.match(source, /!proxyValid\(draft\.proxy\.trim\(\)\)\) return/);
	assert.match(source, /await scope\.mutate\(/);
});
