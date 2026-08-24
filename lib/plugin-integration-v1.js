/**
 * DSH Plugin Integration v1 — internal browser runtime (not a product feature).
 *
 * A tiny, dependency-free, idempotent-singleton coordinator for independent
 * DSH page plugins. It exists so plugins can share a small capability
 * contract (register / status snapshot / lifecycle hooks) through one neutral
 * global, WITHOUT creating any user-visible unified UI (no dock, no overview,
 * no console, no brand).
 *
 * Why this exists: dsh-lifecycle, dsh-quota-panel and dsh-pet-shura are
 * installed independently and inject their own page scripts. When several are
 * present we want a clean seam between them (e.g. lifecycle hosts a compact
 * quota capsule without reaching into quota's DOM classes). This runtime is
 * that seam — and it doubles as the internal extension point a future
 * "Whale Breath"/鲸息 layer can reuse without anyone rearchitecting.
 *
 * Contract (each plugin registers one module):
 * {
 *   id,            // unique module id, e.g. 'quota', 'lifecycle', 'guardian'
 *   kind,          // 'resource' | 'control' | 'ambient'  (informational)
 *   title,         // short display label (informational only)
 *   getSnapshot(), // () => plain JSON-able status object  (guarded)
 *   actions,       // { name: fn() } actions controllable by peers (guarded)
 *   mountCompact?,// (container) => void — render own compact self into a host-provided node
 *   unmountCompact?, // () => void — take the compact self back out
 *   openDetail?    // () => void — open full detail
 * }
 *
 * Guarantees:
 *  - Idempotent: repeated injection of this file never creates a second runtime.
 *  - Order-independent: late-loading plugins and late-loading shells both work.
 *  - Failure isolation: a throwing listener or module never breaks the runtime.
 *  - Version boundary: a future v2 uses a different key; here we stay at v1.
 *  - NO DOM is touched by this runtime itself; UI stays in each plugin.
 *
 * The runtime may be built and unit-tested standalone (see tests/contract.test.mjs).
 */

/* global window, document */
(function (global) {
	'use strict';

	var KEY = 'DSH_PLUGIN_INTEGRATION_V1';
	var VERSION = 1;

	// Already installed → reuse (and if a mismatched version exists, leave it alone).
	if (global[KEY]) return;

	var modules = new Map(); // id -> module
	var listeners = new Set(); // listener fns

	function safe(fn, label) {
		try {
			return fn();
		} catch (error) {
			// A failing module/listener must never poison the runtime.
			try {
				// eslint-disable-next-line no-console
				if (global.console && global.console.warn) global.console.warn('[dsh-plugin-integration]', label || '', error);
			} catch { /* never throw from the safety net */ }
			return undefined;
		}
	}

	function broadcast(event) {
		var snapshot = Array.from(listeners);
		for (var i = 0; i < snapshot.length; i++) {
			// Capture to avoid a listener removing itself mid-loop breaking the rest.
			(function (fn) { safe(function () { fn(event); }, 'listener'); })(snapshot[i]);
		}
	}

	var api = {
		version: VERSION,
		key: KEY,

		/** Register (or update) a module. Returns true when newly added. */
		register: function (module) {
			if (!module || typeof module.id !== 'string' || !module.id) return false;
			var isNew = !modules.has(module.id);
			modules.set(module.id, module);
			// Notify peers so a late-registering module is discovered by an
			// already-running shell, and vice versa.
			safe(function () { broadcast({ type: isNew ? 'register' : 'update', id: module.id, module: module }); }, 'register.broadcast');
			return isNew;
		},

		/** Remove a module. Returns true when it existed. */
		unregister: function (id) {
			if (!modules.has(id)) return false;
			modules.delete(id);
			safe(function () { broadcast({ type: 'unregister', id: id }); }, 'unregister.broadcast');
			return true;
		},

		/** Return a module by id, or null. */
		get: function (id) {
			return modules.get(id) || null;
		},

		/** Whether a module with this id is registered. */
		has: function (id) {
			return modules.has(id);
		},

		/** List known modules (array of `{ id, kind, title }`), stable order. */
		list: function () {
			return Array.from(modules.values()).map(function (m) {
				return { id: m.id, kind: m.kind || '', title: m.title || '' };
			});
		},

		/**
		 * Subscribe to integration events. Returns an unsubscribe function.
		 * Events: { type: 'register'|'update'|'unregister', id }.
		 */
		subscribe: function (listener) {
			if (typeof listener !== 'function') return function () {};
			listeners.add(listener);
			var active = true;
			return function () {
				if (!active) return;
				active = false;
				listeners.delete(listener);
			};
		},

		/** Read a module's status snapshot defensively (null when N/A or it throws). */
		snapshotOf: function (id) {
			var m = modules.get(id);
			if (!m || typeof m.getSnapshot !== 'function') return null;
			var value = safe(function () { return m.getSnapshot(); }, 'snapshot.' + id);
			return value === undefined ? null : value;
		},

		/** Invoke one of a module's actions defensively; returns true when called. */
		callAction: function (id, name) {
			var m = modules.get(id);
			if (!m || !m.actions || typeof m.actions[name] !== 'function') return false;
			safe(function () { m.actions[name](); }, 'action.' + id + '.' + name);
			return true;
		},

		/** Ask a module to render its compact self into a host-provided container. */
		mountCompact: function (id, container) {
			var m = modules.get(id);
			if (!m || typeof m.mountCompact !== 'function' || !container) return false;
			safe(function () { m.mountCompact(container); }, 'mountCompact.' + id);
			return true;
		},

		/** Ask a module to detach its compact self. */
		unmountCompact: function (id) {
			var m = modules.get(id);
			if (!m || typeof m.unmountCompact !== 'function') return false;
			safe(function () { m.unmountCompact(); }, 'unmountCompact.' + id);
			return true;
		}
	};

	global[KEY] = api;
})(typeof window !== 'undefined' ? window : globalThis);
