import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { preflight } from '../scripts/probe-preflight.mjs';

const exportsByPackage = {
	'dsh-app-boot': ['boot', 'loadProfile', 'composeEntries', 'loadLayeredEnv', 'createRuntimeResolution', 'PluginPackages'],
	'dsh-launch-environment': ['DSH_LAUNCH_ENVIRONMENT_KEY'],
	'dsh-cmdline': ['provideCmdline']
};
function fixture(t, version, missing) {
	const root = mkdtempSync(join(tmpdir(), 'proxy preflight '));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
	for (const [pkg, names] of Object.entries(exportsByPackage)) {
		const dir = join(root, 'node_modules/@deepseek-ai', pkg);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${pkg}`, type: 'module', main: 'index.js' }));
		writeFileSync(join(dir, 'index.js'), names.filter((name) => name !== missing).map((name) =>
			`export const ${name} = ${name === 'DSH_LAUNCH_ENVIRONMENT_KEY' ? "Symbol.for('probe')" : '() => {}'};`).join('\n'));
	}
	return root;
}

test('preflight accepts capabilities regardless of old version labels and spaces in paths', async (t) => {
	const root = fixture(t, '0.1.0');
	const checked = await preflight({ DSH_ROOT: root });
	assert.equal(checked.version, '0.1.0');
	assert.equal(typeof checked.runtime.createRuntimeResolution, 'function');
});
test('new version with missing exports fails clearly', async (t) => {
	const root = fixture(t, '99.0.0', 'createRuntimeResolution');
	await assert.rejects(preflight({ DSH_ROOT: root }), /missing runtime exports.*createRuntimeResolution.*99.0.0/s);
});
test('missing root, modules, or PATH dsh yields actionable diagnostics', async (t) => {
	await assert.rejects(preflight({ DSH_ROOT: '/does-not-exist-dsh-probe' }), /missing\/wrong root.*DSH_ROOT.*npm install/s);
	await assert.rejects(preflight({ PATH: '' }), /missing\/wrong root/);
	const root = fixture(t, '0.2.0');
	rmSync(join(root, 'node_modules'), { recursive: true });
	await assert.rejects(preflight({ DSH_ROOT: root }), /module\/import failure/);
});
test('CLI preflight failure is nonzero, stack-free and leaves PROBE_HOME untouched', (t) => {
	const root = fixture(t, '99.0.0', 'PluginPackages');
	const home = join(root, 'existing home');
	mkdirSync(home);
	writeFileSync(join(home, 'sentinel'), 'keep');
	for (const [anchor, expected] of [[root, /missing runtime exports.*PluginPackages/], [join(root, 'missing'), /missing\/wrong root/]]) {
		const result = spawnSync(process.execPath, ['scripts/boot-probe.mjs'], {
			cwd: new URL('..', import.meta.url), env: { ...process.env, DSH_ROOT: anchor, PROBE_HOME: home }, encoding: 'utf8', timeout: 10000
		});
		assert.equal(result.status, 1);
		assert.match(result.stderr, expected);
		assert.doesNotMatch(result.stderr, /\n\s+at |TypeError:/);
		assert.equal(readFileSync(join(home, 'sentinel'), 'utf8'), 'keep');
		assert.equal(result.stdout, '');
	}
});
