'use strict';

/**
 * Several OBS connections (2026-11-26, handoffs/HANDOFF-obs-multi.md in lbcbot-workspace).
 *
 * With NDI a streamer often runs two OBS: one on the source PC (this one, usually) and one on the PC that goes live.
 * Each connection is one `ObsBridge` (obs.js, which keeps its own reconnect loop and stats sampler); this manager
 * owns the list, the one connection that "goes live", and where each command from LBCBot goes.
 *
 * A connection: `{ id, url, name, reported, local, live, enabled }`. `id` is `obs_` + 8 hex, never the address
 * (addresses change on DHCP). `name` is the user's rename ('' for none), `reported` the name the network gave, `local`
 * whether it is this PC, `live` whether it is the one that goes live (exactly one has it), `enabled` whether a
 * connection is wanted (Disconnect clears it, so it survives a restart).
 *
 * Routing: a command may carry `obsId`. Without one, everything goes to the "goes live" connection, so triggers made
 * before there were several behave exactly as before. A command for an id that is no longer here is dropped: a scene
 * switch meant for a removed PC must not land on the streaming one.
 */

const crypto = require('node:crypto');

const ID_PATTERN = /^obs_[0-9a-f]{8}$/;
const DEFAULT_PORT = 4455;
const LOCAL_URL = /^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i;

function newId(randomBytes = crypto.randomBytes) {
    return `obs_${randomBytes(4).toString('hex')}`;
}

function hostOf(url) {
    try {
        return new URL(url).hostname;
    } catch (error) {
        return '';
    }
}

function portOf(url) {
    try {
        return new URL(url).port || String(DEFAULT_PORT);
    } catch (error) {
        return '';
    }
}

/**
 * A typed address as a ws:// URL: "10.0.0.88", "10.0.0.88:4456", "ws://pc.lan:4455" all work. Null for anything that
 * isn't one (a path, another scheme, a port out of range).
 */
function normalizeAddress(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `ws://${raw}`;
    let url;
    try {
        url = new URL(withScheme);
    } catch (error) {
        return null;
    }
    if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    if ((url.pathname && url.pathname !== '/') || url.search || url.hash) return null;
    // URL drops a scheme's own port (443 for wss): put it back, and OBS's for a bare ws address.
    const port = url.port || (url.protocol === 'wss:' ? '443' : String(DEFAULT_PORT));
    return `${url.protocol}//${url.hostname.includes(':') && !url.hostname.startsWith('[') ? `[${url.hostname}]` : url.hostname}:${port}`;
}

/** What the app calls a connection: the user's name, else "This PC", else what the network reported, else its address. */
function displayName(conn) {
    if (!conn) return '';
    return conn.name || (conn.local ? 'This PC' : conn.reported) || hostOf(conn.url) || conn.url || '';
}

/**
 * The settings from before there were several connections become connection #1, the one that goes live, once. The old
 * keys stay for a downgrade, and the saved password's encrypted blob moves as it is (it is the same secret).
 * `raw` is the settings file as read; answers `{ settings, changed }`.
 */
function migrateSettings(raw, makeId = newId) {
    if (!raw || Array.isArray(raw.obsConnections)) {
        return { settings: raw, changed: false };
    }
    const url = typeof raw.obsUrl === 'string' && raw.obsUrl ? raw.obsUrl : `ws://127.0.0.1:${DEFAULT_PORT}`;
    const host = hostOf(url);
    const id = makeId();
    const conn = {
        id,
        url,
        name: (raw.obsNames && raw.obsNames[host]) || '',
        reported: raw.obsName || '',
        local: raw.obsLocal !== undefined ? raw.obsLocal !== false : LOCAL_URL.test(url),
        live: true,
        enabled: true,
    };
    const obsPasswords = { ...(raw.obsPasswords || {}) };
    if (raw.obsPassword) obsPasswords[id] = raw.obsPassword;
    return { settings: { ...raw, obsConnections: [conn], obsPasswords }, changed: true };
}

/**
 * Whether a connection being added takes the "goes live" role: the first one does, and a second one from another PC
 * takes it from This PC (the usual NDI layout: the source here, the stream there).
 */
function takesLive(list, adding) {
    const live = list.find((c) => c.live);
    if (!live) return true;
    return Boolean(live.local) && !adding.local;
}

/** The list with exactly one connection marked live (the first, when none or several are). */
function withOneLive(list, liveId) {
    if (!list.length) return list;
    const id = liveId && list.some((c) => c.id === liveId) ? liveId : (list.find((c) => c.live) || list[0]).id;
    return list.map((c) => (Boolean(c.live) === (c.id === id) ? c : { ...c, live: c.id === id }));
}

class ObsConnections {
    /**
     * `store`: `{ list(), save(list), password(id), setPassword(id, value), deletePassword(id), settings() }`.
     * `makeBridge(conn, hooks)` builds one ObsBridge for a connection (index.js passes the real one; tests a fake).
     */
    constructor({ store, makeBridge, onLog = () => {}, onStatus = () => {}, onObsEvent = () => {}, onStats = () => {}, makeId = newId }) {
        this.store = store;
        this.makeBridge = makeBridge;
        this.onLog = onLog;
        this.onStatus = onStatus;
        this.onObsEvent = onObsEvent;
        this.onStats = onStats;
        this.makeId = makeId;
        /** id -> ObsBridge, for the saved connections only (an add being tried is not in here until it connects). */
        this.bridges = new Map();
        this.list = withOneLive(store.list() || [], null);
        this.list.forEach((conn) => this.bridges.set(conn.id, this.bridgeFor(conn)));
    }

    conn(id) {
        return this.list.find((c) => c.id === id) || null;
    }

    get liveConn() {
        return this.list.find((c) => c.live) || this.list[0] || null;
    }

    /** The bridge of the connection that goes live, or null with none set up. */
    get live() {
        const conn = this.liveConn;
        return conn ? this.bridges.get(conn.id) || null : null;
    }

    bridgeFor(conn) {
        const id = conn.id;
        const bridge = this.makeBridge(conn, {
            // Each bridge reads its own address over the shared settings (forwardObsEvents and the rest).
            settings: () => ({ ...this.store.settings(), obsUrl: (this.conn(id) || conn).url }),
            password: () => this.store.password(id),
            name: () => displayName(this.conn(id) || conn),
            onStatus: () => {
                if (this.bridges.get(id) === bridge) this.publish();
            },
            onObsEvent: (event) => {
                if (this.bridges.get(id) !== bridge) return undefined;
                const current = this.conn(id);
                return this.onObsEvent({ ...event, obsId: id, obsName: displayName(current) });
            },
            onStats: (payload, options) => {
                const current = this.conn(id);
                if (!current || this.bridges.get(id) !== bridge) return undefined;
                return this.onStats({ ...payload, obsId: id, name: displayName(current), role: current.live ? 'live' : 'other' }, options);
            },
            onLog: (line) => this.onLog(this.list.length > 1 ? `${displayName(this.conn(id) || conn)}: ${line}` : line),
        });
        return bridge;
    }

    /** Every connection with its bridge's state, for the app's list. Never a password. */
    get status() {
        return {
            connections: this.list.map((conn) => {
                const bridge = this.bridges.get(conn.id);
                const s = bridge ? bridge.status : { connected: false, state: 'off', error: null, stream: { state: 'off', startedAt: null } };
                return {
                    id: conn.id,
                    name: conn.name || '',
                    displayName: displayName(conn),
                    host: hostOf(conn.url),
                    url: conn.url,
                    local: Boolean(conn.local),
                    live: Boolean(conn.live),
                    enabled: conn.enabled !== false,
                    hasPassword: Boolean(this.store.password(conn.id)),
                    connected: Boolean(s.connected),
                    state: s.state,
                    error: s.error,
                    stream: s.stream,
                };
            }),
        };
    }

    /** Whether the connection that goes live is connected (the sidebar's OBS line). */
    get connected() {
        const bridge = this.live;
        return Boolean(bridge && bridge.connected);
    }

    publish() {
        this.onStatus(this.status);
    }

    save() {
        this.list = withOneLive(this.list, null);
        this.store.save(this.list);
    }

    /** Connect each connection that wasn't disconnected by hand (on launch, when auto-connect is on). */
    async connectAll() {
        await Promise.all(this.list.filter((c) => c.enabled !== false).map((c) => this.bridges.get(c.id).connect()));
    }

    async disconnectAll() {
        await Promise.all([...this.bridges.values()].map((b) => b.disconnect().catch(() => {})));
    }

    /**
     * Add a connection: try it first, and keep it only once it connects, so the list never holds a half-added PC.
     * `{ url, reported, local, password }`. Answers `{ ok, id }`, or `{ ok: false, needsPassword, badPassword, error }`
     * with the words to show under the field.
     */
    async add({ url, reported = '', local = false, password = '' }) {
        const address = normalizeAddress(url);
        if (!address) {
            return { ok: false, error: 'That isn\'t an address. Try one like 10.0.0.88 or 10.0.0.88:4455.' };
        }
        const host = hostOf(address);
        const isLocal = Boolean(local) || LOCAL_URL.test(address);
        // This PC answers on 127.0.0.1 and on each of its adapters: one OBS, whichever address found it.
        const existing = this.list.find((c) => c.url === address || (isLocal && c.local && portOf(c.url) === portOf(address)));
        if (existing) {
            return { ok: false, error: `${displayName(existing)} is already added.` };
        }
        const conn = {
            id: this.makeId(),
            url: address,
            name: '',
            reported: reported || '',
            local: isLocal,
            live: false,
            enabled: true,
        };
        while (this.conn(conn.id)) conn.id = this.makeId();
        if (password) await this.store.setPassword(conn.id, password);
        // Tried outside the list: its status is not published until it is in.
        const trial = this.bridgeFor(conn);
        this.bridges.set(conn.id, trial);
        const ok = await trial.connect();
        if (!ok) {
            const { state, error } = trial.status;
            this.bridges.delete(conn.id);
            await trial.disconnect().catch(() => {});
            await this.store.deletePassword(conn.id);
            if (state === 'needs-password') {
                return { ok: false, needsPassword: true, error: 'This OBS needs its password.' };
            }
            if (state === 'bad-password') {
                return { ok: false, badPassword: true, error: 'Wrong password. It\'s in OBS under Tools → WebSocket Server Settings.' };
            }
            return { ok: false, error: error || `Can't reach OBS at ${host}.` };
        }
        const live = takesLive(this.list, conn);
        this.list = [...this.list.map((c) => (live ? { ...c, live: false } : c)), { ...conn, live }];
        this.save();
        this.onLog(`Added ${displayName(conn)}${live ? ', the OBS that goes live' : ''}.`);
        this.publish();
        return { ok: true, id: conn.id };
    }

    /** Forget a connection and its password. The one that goes live hands the role to the next. */
    async remove(id) {
        const conn = this.conn(id);
        if (!conn) return false;
        const bridge = this.bridges.get(id);
        this.bridges.delete(id);
        this.list = this.list.filter((c) => c.id !== id);
        this.save();
        await this.store.deletePassword(id);
        if (bridge) await bridge.disconnect().catch(() => {});
        this.onLog(`Removed ${displayName(conn)}.`);
        this.publish();
        return true;
    }

    rename(id, name) {
        const conn = this.conn(id);
        if (!conn) return false;
        const next = String(name || '').trim().slice(0, 40);
        this.list = this.list.map((c) => (c.id === id ? { ...c, name: next } : c));
        this.save();
        this.publish();
        return true;
    }

    setLive(id) {
        if (!this.conn(id)) return false;
        this.list = withOneLive(this.list, id);
        this.store.save(this.list);
        this.publish();
        return true;
    }

    /** Connect one (a password given here is saved for it first). Answers whether it connected. */
    async connect(id, password) {
        const bridge = this.bridges.get(id);
        if (!bridge) return false;
        if (password) await this.store.setPassword(id, password);
        this.setEnabled(id, true);
        return bridge.connect();
    }

    async disconnect(id) {
        const bridge = this.bridges.get(id);
        if (!bridge) return false;
        this.setEnabled(id, false);
        await bridge.disconnect();
        return true;
    }

    setEnabled(id, enabled) {
        const conn = this.conn(id);
        if (conn && (conn.enabled !== false) !== enabled) {
            this.list = this.list.map((c) => (c.id === id ? { ...c, enabled } : c));
            this.store.save(this.list);
        }
    }

    /** Start or stop the stream on one connection (the one that goes live when no id is given). */
    async setStreaming(id, on) {
        const bridge = id ? this.bridges.get(id) : this.live;
        if (!bridge) return { ok: false, error: 'That OBS isn\'t set up here any more.' };
        return bridge.setStreaming(on);
    }

    /** A scan's rows: a PC already in the list that now reports a name keeps it (Network discovery turned on there). */
    noteScan(rows) {
        let changed = false;
        this.list = this.list.map((c) => {
            const row = (rows || []).find((r) => r.url === c.url);
            if (row && row.name && !row.local && row.name !== c.reported) {
                changed = true;
                return { ...c, reported: row.name };
            }
            return c;
        });
        if (changed) {
            this.store.save(this.list);
            this.publish();
        }
    }

    /**
     * One command from `/topic/deviceControl/{user}` (routeDeviceCommand). `obsId` on the command or in its action
     * picks the connection; none means the one that goes live. WATCH_STATS with `all: true` asks every connection
     * (sent only by an API that keeps each connection's stats apart, HANDOFF-obs-multi step 2); without it only the one
     * that goes live answers, so an older API never gets two OBS's samples interleaved under one user.
     */
    execute(command) {
        let action;
        try {
            action = typeof command.action === 'string' ? JSON.parse(command.action) : command.action;
        } catch (error) {
            action = null; // the bridge logs an unreadable action
        }
        const obsId = (command && command.obsId) || (action && action.obsId) || null;
        if (obsId && !ID_PATTERN.test(String(obsId))) {
            this.onLog('Ignored an OBS action for an unknown OBS.');
            return undefined;
        }
        if (action && action.type === 'WATCH_STATS' && action.all === true && !obsId) {
            return Promise.all([...this.bridges.values()].map((b) => b.execute(command)));
        }
        const bridge = obsId ? this.bridges.get(obsId) : this.live;
        if (!bridge) {
            // No OBS set up here (the app on a second PC) stays silent for WATCH_STATS, as before.
            if (obsId || !(action && action.type === 'WATCH_STATS')) {
                this.onLog(obsId ? 'Ignored an OBS action for an OBS that is no longer set up here.' : 'Ignored an OBS action — no OBS set up.');
            }
            return undefined;
        }
        return bridge.execute(command);
    }
}

module.exports = {
    ObsConnections, migrateSettings, normalizeAddress, displayName, takesLive, withOneLive, newId, hostOf, ID_PATTERN,
};
