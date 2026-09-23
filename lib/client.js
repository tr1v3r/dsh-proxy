// Browser companion for @tr1v3r/dsh-proxy. Uses the Host settings namespace as
// the single source of truth: UI writes and external settings.yaml edits converge.
window.__ModuleLoader__.load({
	id: '@tr1v3r/dsh-proxy',
	factory: (require) => {
		const module = { exports: {} };
		const React = require('react');
		const { Menu, IconChevronDownOutline14 } = require('@deepseek-ai/dsh-client-ui-primitives');
		const NS = 'dsh-proxy';
		const COPY = {
			zh: {
				title: '网络代理', description: '控制 DSH 进程内请求的出口；也可直接编辑 settings.yaml',
				direct: '直连', system: '跟随系统', manual: '手动代理',
				proxy: '代理地址', bypass: '直连地址（每行一个）', exportEnv: '让新启动的子进程也使用代理',
				invalid: '请输入有效的 HTTP(S) 或 SOCKS5 代理地址',
				failed: '保存失败；配置可能已在别处修改，请重新选择后重试', readOnly: '当前设置只读',
				placeholder: 'http://127.0.0.1:7890 或 socks5://127.0.0.1:1080'
			},
			en: {
				title: 'Network proxy', description: 'Route DSH requests; settings.yaml remains editable',
				direct: 'Direct', system: 'Follow system', manual: 'Manual proxy',
				proxy: 'Proxy URL', bypass: 'Bypass hosts (one per line)', exportEnv: 'Also proxy newly spawned processes',
				invalid: 'Enter a valid HTTP(S) or SOCKS5 proxy URL',
				failed: 'Save failed; settings may have changed elsewhere. Choose again to retry', readOnly: 'Settings are read-only',
				placeholder: 'http://127.0.0.1:7890 or socks5://127.0.0.1:1080'
			}
		};
		const CSS = `
			.dshProxyRow{border-bottom:.5px solid var(--dsw-alias-border-l2);padding:16px 0;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px}
			.dshProxyHeader{display:flex;align-items:center;gap:8px}
			.dshProxyRowText{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px;padding-right:48px}
			.dshProxyTitle{font-size:14px;font-weight:400;line-height:22px}.dshProxyHint{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}
			.dshProxyMode{display:inline-flex;align-items:center;gap:12px;height:36px;padding:0 14px;border:0;border-radius:18px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;white-space:nowrap;cursor:pointer}
			.dshProxyMode:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dshProxyMode:focus-visible,.dshProxyField :focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}
			.dshProxyMode:disabled{opacity:.6;cursor:default}.dshProxyChevron{flex:none}.dshProxyCheck{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
			.dshProxyForm{display:flex;flex-direction:column;gap:10px}.dshProxyField{display:flex;flex-direction:column;gap:5px}
			.dshProxyField input,.dshProxyField textarea{box-sizing:border-box;width:100%;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-input);color:var(--dsw-alias-label-primary);font:inherit}
			.dshProxyField textarea{min-height:60px;resize:vertical}.dshProxyStatus{min-height:16px}.dshProxyError{color:var(--dsw-alias-label-error);font-size:12px}
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
			const [open, setOpen] = React.useState(false);
			const [revision, setRevision] = React.useState(snapshot.revision);
			const generation = React.useRef(0);
			React.useEffect(() => {
				// Keep a staged edit and its revision fence when settings.yaml changes.
				if (dirty || snapshot.status !== 'ready') return;
				const next = fromSnapshot(snapshot);
				setDraft((before) => JSON.stringify(before) === JSON.stringify(next) ? before : next);
				if (revision !== snapshot.revision) setRevision(snapshot.revision);
			}, [snapshot, dirty, revision]);
			React.useEffect(() => () => { generation.current += 1; }, []);
			if (snapshot.status !== 'ready') return null;
			const persist = async (fields, expectedRevision = revision) => {
				const id = ++generation.current;
				setSaving(true);
				setError('');
				try {
					await scope.mutate(Object.entries(fields).map(([key, value]) => ({ op: 'set', path: [key], value })), expectedRevision);
					if (id !== generation.current) return;
					const current = scope.getSnapshot();
					const saved = current.user ?? {};
					const accepted = current.revision !== expectedRevision && Object.entries(fields).every(([key, value]) => JSON.stringify(saved[key]) === JSON.stringify(value));
					if (!accepted) { setDraft(fromSnapshot(current)); setDirty(false); setRevision(current.revision); setError(t('failed')); return; }
					setDraft(fromSnapshot(current));
					setDirty(false);
					setRevision(current.revision);
				} catch {
					if (id === generation.current) {
						const current = scope.getSnapshot();
						setDirty(false); setDraft(fromSnapshot(current)); setRevision(current.revision); setError(t('failed'));
					}
				} finally { if (id === generation.current) setSaving(false); }
			};
			const changeMode = (mode) => {
				if (mode === draft.mode || saving) return;
				const next = { ...draft, mode };
				setDraft(next);
				setError('');
				if (mode === 'manual') {
					if (!proxyValid(next.proxy.trim())) { setDirty(true); return; }
					persist({ mode, proxy: next.proxy.trim(), noProxy: next.noProxy.split(/[\n,]/).map((rule) => rule.trim()).filter(Boolean), exportEnv: next.exportEnv });
					return;
				}
				persist({ mode });
			};
			const changeField = (patch) => { setDraft((before) => ({ ...before, ...patch })); setDirty(true); setError(''); };
			const commitManual = () => {
				if (!dirty || saving || draft.mode !== 'manual' || !proxyValid(draft.proxy.trim())) return;
				const next = { ...draft, proxy: draft.proxy.trim() };
				persist({
					proxy: next.proxy,
					noProxy: next.noProxy.split(/[\n,]/).map((rule) => rule.trim()).filter(Boolean),
					exportEnv: next.exportEnv,
					mode: 'manual'
				});
			};
			const invalid = draft.mode === 'manual' && dirty && !proxyValid(draft.proxy.trim());
			return React.createElement('div', { className: 'dshProxyRow' },
				React.createElement('div', { className: 'dshProxyHeader' },
					React.createElement('div', { className: 'dshProxyRowText' },
						React.createElement('div', { className: 'dshProxyTitle' }, t('title')),
						React.createElement('div', { className: 'dshProxyHint' }, t('description'))),
					React.createElement(Menu, {
						open, onClose: () => setOpen(false),
						items: ['direct', 'system', 'manual'].map((mode) => ({ id: mode, label: t(mode) })),
						selectedId: draft.mode, align: 'end', portal: true,
						onSelect: (mode) => { setOpen(false); changeMode(mode); },
						anchor: React.createElement('button', {
							type: 'button', className: 'dshProxyMode', 'aria-label': t('title'),
							'aria-haspopup': 'menu', 'aria-expanded': open,
							disabled: !snapshot.writable || saving,
							onClick: () => setOpen((value) => !value)
						}, t(draft.mode), React.createElement(IconChevronDownOutline14, { className: 'dshProxyChevron' }))
					})),
				draft.mode === 'manual' && React.createElement('div', { className: 'dshProxyForm' },
					React.createElement('label', { className: 'dshProxyField' }, t('proxy'), React.createElement('input', {
						type: 'text', value: draft.proxy, placeholder: t('placeholder'), spellCheck: false,
						disabled: !snapshot.writable || saving, onChange: (event) => changeField({ proxy: event.target.value }),
						onBlur: commitManual, onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } } })),
					React.createElement('label', { className: 'dshProxyField' }, t('bypass'), React.createElement('textarea', {
						value: draft.noProxy, disabled: !snapshot.writable || saving,
						onChange: (event) => changeField({ noProxy: event.target.value }), onBlur: commitManual })),
					React.createElement('label', { className: 'dshProxyCheck' }, React.createElement('input', {
						type: 'checkbox', checked: draft.exportEnv, disabled: !snapshot.writable || saving,
						onChange: (event) => {
							const next = { ...draft, exportEnv: event.target.checked };
							setDraft(next);
							setDirty(true);
							if (proxyValid(next.proxy.trim())) {
								persist({ proxy: next.proxy.trim(), noProxy: next.noProxy.split(/[\n,]/).map((rule) => rule.trim()).filter(Boolean), exportEnv: next.exportEnv, mode: 'manual' });
							}
						} }), t('exportEnv'))),
				(!snapshot.writable || invalid || error) && React.createElement('div', { className: 'dshProxyStatus' },
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
