import { realpathSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

export const required = {
	'dsh-app-boot': ['boot', 'loadProfile', 'composeEntries', 'loadLayeredEnv', 'createRuntimeResolution', 'PluginPackages'],
	'dsh-launch-environment': ['DSH_LAUNCH_ENVIRONMENT_KEY'],
	'dsh-cmdline': ['provideCmdline']
};
const guidance = '\nUse a DSH install anchor with runtime dependencies (verified reference: >=0.1.7-rc.1).\nExample: ROOT=$(mktemp -d); npm install --prefix "$ROOT" @deepseek-ai/dsh@0.2.0-rc.1\nDSH_ROOT="$ROOT" node scripts/boot-probe.mjs';

/** Capability gate only: version labels are diagnostic, not a compatibility test. */
export async function preflight(env = process.env) {
	let root;
	let version = 'unknown';
	const fail = (category, detail) => { throw new Error(`probe preflight: ${category}: ${detail}${guidance}`); };
	try {
		root = env.DSH_ROOT ? realpathSync(env.DSH_ROOT)
			: dirname(dirname(realpathSync(execFileSync('which', ['dsh'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim())));
		const anchor = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
		if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) fail('wrong root', 'DSH_ROOT needs a package.json install anchor');
		try {
			version = anchor.name === '@deepseek-ai/dsh' ? anchor.version : JSON.parse(readFileSync(join(root, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version;
		} catch { /* Version is optional diagnostic context. */ }
	} catch (error) {
		if (error.message.startsWith('probe preflight:')) throw error;
		fail('missing/wrong root', 'Set DSH_ROOT to a DSH install anchor containing package.json, or put dsh on PATH');
	}
	const runtime = {};
	for (const [pkg, names] of Object.entries(required)) {
		let exports;
		try {
			const resolve = createRequire(join(root, 'package.json'));
			exports = await import(pathToFileURL(resolve.resolve(`@deepseek-ai/${pkg}`)).href);
		}
		catch { fail('module/import failure', `${pkg} could not load (DSH ${version})`); }
		const missing = names.filter((name) => name === 'DSH_LAUNCH_ENVIRONMENT_KEY'
			? !['string', 'symbol'].includes(typeof exports[name]) : typeof exports[name] !== 'function');
		if (missing.length) fail('missing runtime exports', `${pkg}: ${missing.join(', ')} (DSH ${version})`);
		Object.assign(runtime, exports);
	}
	return { root, version, runtime };
}
