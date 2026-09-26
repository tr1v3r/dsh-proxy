import type { Context } from '@deepseek-ai/cordis';

/** Routing modes the section accepts. */
export type ProxyModeValue = 'direct' | 'system' | 'manual';

/** Resolved shape of the `dsh-proxy` profile entry config. */
export interface ProxySection {
	mode?: ProxyModeValue;
	enabled?: boolean;
	proxy?: string;
	noProxy?: string[];
	exportEnv?: boolean;
	/** Always route loopback (localhost, 127.0.0.0/8, ::1, 0.0.0.0) direct. Default true. */
	bypassLoopback?: boolean;
}

/** Normalized config the engine consumes (output of resolveConfig). */
export interface EffectiveConfig {
	mode: ProxyModeValue;
	proxy?: string;
	noProxy: string[];
	exportEnv: boolean;
	bypassLoopback: boolean;
}

/** Normalized proxy spec produced by detectSystemProxy / parseScutilProxy. */
export interface SystemProxySpec {
	httpProxy?: string;
	httpsProxy?: string;
	socksProxy?: string;
	noProxy: string[];
	pac: boolean;
}

/** Undici dispatcher instance type (loose — undici ships its own types). */
export interface DispatcherLike {
	dispatch(options: unknown, handler: unknown): boolean;
	close(): Promise<void>;
	destroy(): Promise<void>;
}

export interface SwitchEngine {
	apply(config: ProxySection): void;
	restore(): void;
}

export const name: string;
export const inject: string[];
export const PROXY_SETTINGS_NAMESPACE: 'dsh-proxy';
export const PROXY_ONLY_ENV_KEYS: string[];
export const NO_PROXY_ENV_KEYS: string[];
export const PROXY_ENV_KEYS: string[];
export const PROXY_MODES: ProxyModeValue[];
export const ProxyMode: unknown;
export const Config: unknown;

export function resolveMode(config?: ProxySection): ProxyModeValue;
export function resolveConfig(config?: ProxySection): EffectiveConfig;
export function parseNoProxyList(value?: string): string[];
export const LOOPBACK_NO_PROXY: string[];
export function isLoopbackHostname(hostname: string): boolean;
export function mergeLoopbackNoProxy(rules: string[]): string[];
export function matchesNoProxy(hostname: string, port: string | null, rules: string[]): boolean;
export function buildDispatcher(config: ProxySection & { proxy: string }): DispatcherLike;
export function buildSystemDispatcher(detected: SystemProxySpec | null, bypassLoopback?: boolean): DispatcherLike;
export function parseScutilProxy(text: string): SystemProxySpec;
export function detectSystemProxy(
	platform?: string,
	env?: Record<string, string | undefined>
): SystemProxySpec | null;
export function createEngine(logger: unknown): SwitchEngine;
export function apply(ctx: Context, config?: ProxySection | { get(): ProxySection }): void;
