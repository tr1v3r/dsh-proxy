// Browser companion for @tr1v3r/dsh-proxy. Uses the Host settings namespace as
// the single source of truth: UI writes and profile patch edits converge.
window.__ModuleLoader__.load({
	id: '@tr1v3r/dsh-proxy',
	factory: (require) => {
		const module = { exports: {} };
		const React = require('react');
		const { Menu, Tooltip, IconChevronDownOutlineRegular, IconGlobeOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives');
		const NS = 'dsh-proxy';
		const COPY = {
			zh: {
				title: '网络代理', description: '控制 DSH 进程内出站请求（子进程经导出的环境变量）；本地回环（localhost/127.0.0.1）默认直连。保存即生效、无需重启；也可直接编辑 profile 的 cordis.patch.yml',
				direct: '直连', system: '跟随系统', manual: '手动代理',
				proxy: '代理地址', bypass: '直连地址（每行一个）', exportEnv: '让新启动的子进程也使用代理',
				invalid: '请输入有效的 HTTP(S) 或 SOCKS5 代理地址',
				failed: '保存失败；配置可能已在别处修改，请重新选择后重试', readOnly: '当前设置只读',
				placeholder: 'http://127.0.0.1:7890 或 socks5://127.0.0.1:1080',
				quickLabel: '网络代理', loading: '读取中', quickSettings: '编辑地址与直连规则：设置 → 通用 → 网络代理',
				manualMissing: '手动代理未配置有效地址，目前直连', systemUnknown: '跟随系统；实际代理状态以 DSH 日志为准',
				manualEndpoint: '代理地址：{endpoint}'
			},
			en: {
				title: 'Network proxy', description: 'Routes DSH in-process outbound requests (child processes via exported env); loopback (localhost/127.0.0.1) stays direct by default. Saves apply immediately, no restart; the profile cordis.patch.yml remains editable',
				direct: 'Direct', system: 'Follow system', manual: 'Manual proxy',
				proxy: 'Proxy URL', bypass: 'Bypass hosts (one per line)', exportEnv: 'Also proxy newly spawned processes',
				invalid: 'Enter a valid HTTP(S) or SOCKS5 proxy URL',
				failed: 'Save failed; settings may have changed elsewhere. Choose again to retry', readOnly: 'Settings are read-only',
				placeholder: 'http://127.0.0.1:7890 or socks5://127.0.0.1:1080',
				quickLabel: 'Network proxy', loading: 'Loading', quickSettings: 'Edit URL and bypass rules: Settings → General → Network proxy',
				manualMissing: 'Manual proxy has no valid URL; routing directly', systemUnknown: 'Follow system; see DSH logs for the effective route',
				manualEndpoint: 'Proxy endpoint: {endpoint}'
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
			.dshProxyQuick{box-sizing:border-box;flex:none;align-self:center;width:36px;height:36px;margin:0}
			.dshProxyQuickButton{width:36px;height:36px;display:flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
			.dshProxyQuickButton:hover,.dshProxyQuickButton[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover)}.dshProxyQuickButton:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}
			.dshProxyQuickButton:disabled{cursor:default;opacity:.6}
			.dshProxyQuickIcon{position:relative;flex:none;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center}.dshProxyQuickDot{position:absolute;right:-1px;bottom:-1px;width:6px;height:6px;border:1.5px solid var(--dsw-specific-sidebar-fill);border-radius:50%;background:var(--dsw-alias-label-tertiary)}
			.dshProxyQuick[data-mode="manual"] .dshProxyQuickDot{background:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-primary))}.dshProxyQuick[data-mode="system"] .dshProxyQuickDot{background:var(--dsw-alias-label-primary)}
			.dshProxyQuickError{width:max-content;max-width:220px;padding:4px 8px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
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
		function redactedEndpoint(proxy) {
			try {
				const url = new URL(proxy);
				if (!proxyValid(proxy)) return null;
				return `${url.protocol}//${url.username || url.password ? '***@' : ''}${url.host}`;
			} catch { return null; }
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
				// Keep a staged edit and its revision fence when the profile patch changes.
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
						}, t(draft.mode), React.createElement(IconChevronDownOutlineRegular, { className: 'dshProxyChevron' }))
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
		function ProxyQuick({ scope, t, wide }) {
			const snapshot = React.useSyncExternalStore(
				React.useCallback((listener) => scope.subscribe(listener), [scope]),
				React.useCallback(() => scope.getSnapshot(), [scope]),
				React.useCallback(() => scope.getSnapshot(), [scope])
			);
			const [open, setOpen] = React.useState(false);
			const [saving, setSaving] = React.useState(false);
			const [error, setError] = React.useState('');
			const inFlight = React.useRef(false);
			const alive = React.useRef(true);
			React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
			const ready = snapshot.status === 'ready';
			const mode = ready ? modeOf(snapshot.value) : 'direct';
			const endpoint = mode === 'manual' ? redactedEndpoint(snapshot.value.proxy) : null;
			const stateLabel = ready ? t(mode) : t('loading');
			const detail = mode === 'manual' ? (endpoint ? t('manualEndpoint', { endpoint }) : t('manualMissing'))
				: mode === 'system' ? t('systemUnknown') : '';
			const label = `${t('quickLabel')}: ${stateLabel}${detail ? ` — ${detail}` : ''}. ${t('quickSettings')}`;
			const switchMode = async (next) => {
				setOpen(false);
				if (!ready || inFlight.current || next === mode) return;
				if (!snapshot.writable) { setError(t('readOnly')); return; }
				if (next === 'manual' && !proxyValid(snapshot.value.proxy)) { setError(t('manualMissing')); return; }
				if (scope.getSnapshot().revision !== snapshot.revision) { setError(t('failed')); return; }
				inFlight.current = true;
				setSaving(true);
				setError('');
				const expectedRevision = snapshot.revision;
				try {
					await scope.mutate([{ op: 'set', path: ['mode'], value: next }], expectedRevision);
					const current = scope.getSnapshot();
					if (alive.current && (current.status !== 'ready' || modeOf(current.value) !== next || current.user?.mode !== next)) {
						setError(t('failed'));
					}
				} catch { if (alive.current) setError(t('failed')); }
				finally { inFlight.current = false; if (alive.current) setSaving(false); }
			};
			const anchor = React.createElement(Tooltip, { label, delayMs: 500, disabled: open },
				React.createElement('button', {
					type: 'button', className: 'dshProxyQuickButton',
					'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': open,
					disabled: !ready || saving,
					onClick: () => setOpen((value) => !value)
				}, React.createElement('span', { className: 'dshProxyQuickIcon', 'aria-hidden': true },
					React.createElement(IconGlobeOutlineRegular, { size: wide ? 16 : 18 }),
					React.createElement('span', { className: 'dshProxyQuickDot' }))));
			return React.createElement('div', { className: 'dshProxyQuick', 'data-mode': ready ? mode : 'loading' },
				React.createElement(Menu, {
					open, onClose: () => setOpen(false), portal: true, align: 'start',
					items: ['direct', 'system', 'manual'].map((id) => ({ id, label: t(id) })),
					selectedId: ready ? mode : undefined, onSelect: switchMode, anchor
				}),
				error && React.createElement('div', { className: 'dshProxyQuickError', role: 'alert' }, error));
		}
		const inject = ['slots', 'locale', 'configForms'];
		function apply(ctx) {
			ensureStyles();
			ctx.effect(() => ctx.locale.register('settings.dshProxy', COPY), 'dsh-proxy: translations');
			const t = ctx.locale.bind('settings.dshProxy');
			const scope = ctx.configForms.get(NS);
			ctx.slots.inject('settings.general.item', () => ctx.slots.register({
				name: 'settings.general.item', id: NS, order: 20, locale: 'settings.dshProxy',
				inject: () => ({ scope, t })
			}, ProxyRow));
			ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
				name: 'sidebar.footer.action', id: 'dsh-proxy-status', order: 10, locale: 'settings.dshProxy',
				inject: () => ({ scope, t })
			}, ProxyQuick));
		}
		module.exports = { apply, inject };
		return module.exports;
	}
});
