// Browser companion for @tr1v3r/dsh-proxy. Uses the Host settings namespace as
// the single source of truth: UI writes and external settings.yaml edits converge.
window.__ModuleLoader__.load({
	id: '@tr1v3r/dsh-proxy',
	factory: (require) => {
		const module = { exports: {} };
		const React = require('react');
		const NS = 'dsh-proxy';
		const COPY = {
			zh: {
				title: '网络代理', description: '控制 DSH 进程内请求的出口；也可直接编辑 settings.yaml',
				direct: '直连', system: '跟随系统', manual: '手动代理',
				proxy: '代理地址', bypass: '直连地址（每行一个）', exportEnv: '让新启动的子进程也使用代理',
				apply: '应用', applying: '正在应用…', invalid: '请输入有效的 HTTP(S) 或 SOCKS5 代理地址',
				failed: '保存失败；配置可能已在别处修改，请检查并重试', readOnly: '当前设置只读',
				placeholder: 'http://127.0.0.1:7890 或 socks5://127.0.0.1:1080'
			},
			en: {
				title: 'Network proxy', description: 'Route DSH requests; settings.yaml remains editable',
				direct: 'Direct', system: 'Follow system', manual: 'Manual proxy',
				proxy: 'Proxy URL', bypass: 'Bypass hosts (one per line)', exportEnv: 'Also proxy newly spawned processes',
				apply: 'Apply', applying: 'Applying…', invalid: 'Enter a valid HTTP(S) or SOCKS5 proxy URL',
				failed: 'Save failed; settings may have changed elsewhere. Review and retry', readOnly: 'Settings are read-only',
				placeholder: 'http://127.0.0.1:7890 or socks5://127.0.0.1:1080'
			}
		};
		const CSS = `
			.dshProxyRow{border-bottom:1px solid var(--dsw-alias-border-l2);padding:16px 0;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px}
			.dshProxyTitle{font-size:14px}.dshProxyHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
			.dshProxyModes{display:flex;flex-wrap:wrap;gap:8px}.dshProxyModes label,.dshProxyCheck{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
			.dshProxyForm{display:flex;flex-direction:column;gap:10px}.dshProxyField{display:flex;flex-direction:column;gap:5px}
			.dshProxyField input,.dshProxyField textarea{box-sizing:border-box;width:100%;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-input);color:var(--dsw-alias-label-primary);font:inherit}
			.dshProxyField textarea{min-height:60px;resize:vertical}.dshProxyActions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
			.dshProxyActions button{padding:7px 14px;border:0;border-radius:8px;background:var(--dsw-alias-interactive-bg-primary);color:var(--dsw-alias-label-on-primary);font:inherit;cursor:pointer}
			.dshProxyActions button:disabled{opacity:.5;cursor:default}.dshProxyError{color:var(--dsw-alias-label-error);font-size:12px}
		`;
		function ensureStyles() {
			if (document.querySelector('style[data-plugin-css="dsh-proxy"]')) return;
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-proxy';
			tag.dataset.pluginCss = 'dsh-proxy';
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		function modeOf(value) { return ['direct', 'system', 'manual'].includes(value?.mode) ? value.mode : value?.enabled ? 'manual' : 'direct'; }
		function proxyValid(value) {
			try {
				const url = new URL(value);
				return ['http:', 'https:', 'socks5:', 'socks5h:', 'socks:'].includes(url.protocol) && Boolean(url.hostname);
			} catch { return false; }
		}
		function fromSnapshot(snapshot) {
			const value = snapshot.value ?? {};
			return {
				mode: modeOf(value), proxy: value.proxy ?? '',
				noProxy: (value.noProxy ?? []).join('\n'), exportEnv: value.exportEnv !== false
			};
		}
		function ProxyRow({ scope, t }) {
			const snapshot = React.useSyncExternalStore(
				React.useCallback((listener) => scope.subscribe(listener), [scope]),
				React.useCallback(() => scope.getSnapshot(), [scope]),
				React.useCallback(() => scope.getSnapshot(), [scope])
			);
			const [draft, setDraft] = React.useState(() => fromSnapshot(snapshot));
			const [dirty, setDirty] = React.useState(false);
			const [saving, setSaving] = React.useState(false);
			const [error, setError] = React.useState('');
			const [revision, setRevision] = React.useState(snapshot.revision);
			React.useEffect(() => {
				// External file edits refresh an untouched form. Keep staged edits
				// (and their old revision fence) to prevent silent lost updates.
				if (dirty || saving || snapshot.status !== 'ready') return;
				const next = fromSnapshot(snapshot);
				setDraft((before) => JSON.stringify(before) === JSON.stringify(next) ? before : next);
				if (revision !== snapshot.revision) setRevision(snapshot.revision);
			}, [snapshot, dirty, saving, revision]);
			if (snapshot.status !== 'ready') return null;
			const change = (patch) => { setDraft((before) => ({ ...before, ...patch })); setDirty(true); setError(''); };
			const invalid = draft.mode === 'manual' && !proxyValid(draft.proxy.trim());
			const submit = async (event) => {
				event.preventDefault();
				if (saving || !snapshot.writable || invalid) return;
				setSaving(true);
				setError('');
				const fields = { mode: draft.mode };
				if (draft.mode === 'manual') {
					fields.proxy = draft.proxy.trim();
					fields.noProxy = draft.noProxy.split(/[\n,]/).map((rule) => rule.trim()).filter(Boolean);
					fields.exportEnv = draft.exportEnv;
				}
				try {
					await scope.mutate(Object.entries(fields).map(([key, value]) => ({ op: 'set', path: [key], value })), revision);
					// The scope may recover and resolve normally after a rejected revision.
					const current = scope.getSnapshot();
					const saved = current.user ?? {};
					const accepted = current.revision !== revision && Object.entries(fields).every(([key, value]) => JSON.stringify(saved[key]) === JSON.stringify(value));
					if (!accepted) { setError(t('failed')); return; }
					setDirty(false);
					setDraft(fromSnapshot(current));
					setRevision(current.revision);
				} catch { setError(t('failed')); }
				finally { setSaving(false); }
			};
			return React.createElement('form', { className: 'dshProxyRow', onSubmit: submit },
				React.createElement('div', null, React.createElement('div', { className: 'dshProxyTitle' }, t('title')),
					React.createElement('div', { className: 'dshProxyHint' }, t('description'))),
				React.createElement('div', { className: 'dshProxyModes', role: 'radiogroup', 'aria-label': t('title') },
					['direct', 'system', 'manual'].map((mode) => React.createElement('label', { key: mode },
						React.createElement('input', { type: 'radio', name: 'dshProxyMode', value: mode, checked: draft.mode === mode,
							disabled: !snapshot.writable || saving, onChange: () => change({ mode }) }), t(mode)))),
				draft.mode === 'manual' && React.createElement('div', { className: 'dshProxyForm' },
					React.createElement('label', { className: 'dshProxyField' }, t('proxy'), React.createElement('input', {
						type: 'text', value: draft.proxy, placeholder: t('placeholder'), spellCheck: false,
						disabled: !snapshot.writable || saving, onChange: (event) => change({ proxy: event.target.value }) })),
					React.createElement('label', { className: 'dshProxyField' }, t('bypass'), React.createElement('textarea', {
						value: draft.noProxy, disabled: !snapshot.writable || saving,
						onChange: (event) => change({ noProxy: event.target.value }) })),
					React.createElement('label', { className: 'dshProxyCheck' }, React.createElement('input', {
						type: 'checkbox', checked: draft.exportEnv, disabled: !snapshot.writable || saving,
						onChange: (event) => change({ exportEnv: event.target.checked }) }), t('exportEnv'))),
				React.createElement('div', { className: 'dshProxyActions' },
					React.createElement('button', { type: 'submit', disabled: !dirty || invalid || !snapshot.writable || saving }, saving ? t('applying') : t('apply')),
					!snapshot.writable && React.createElement('span', { className: 'dshProxyHint' }, t('readOnly')),
					invalid && React.createElement('span', { className: 'dshProxyError', role: 'alert' }, t('invalid')),
					error && React.createElement('span', { className: 'dshProxyError', role: 'alert' }, error)));
		}
		const inject = ['slots', 'locale', 'settingsScope'];
		function apply(ctx) {
			ensureStyles();
			ctx.effect(() => ctx.locale.register('settings.dshProxy', COPY), 'dsh-proxy: translations');
			const t = ctx.locale.bind('settings.dshProxy');
			const scope = ctx.settingsScope.bind({ namespace: NS });
			ctx.slots.inject('settings.general.item', () => ctx.slots.register({
				name: 'settings.general.item', id: NS, order: 20, locale: 'settings.dshProxy',
				inject: () => ({ scope, t })
			}, ProxyRow));
		}
		module.exports = { apply, inject };
		return module.exports;
	}
});
