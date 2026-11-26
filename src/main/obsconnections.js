'use strict';

/**
 * Several OBS connections (2026-11-26, handoffs/HANDOFF-obs-multi.md in lbcbot-workspace).
 *
 * With NDI a streamer often runs two OBS: one on the source PC (this one, usually) and one on the PC that streams.
 * Each connection is one `ObsBridge` (obs.js, which keeps its own reconnect loop and stats sampler); this manager
 * owns the list, in the user's own order, and where each command from LBCBot goes. There is no "goes live" role
 * (Chris, 2026-11-26: which one streams is the user's business): every OBS has its own Start and Stop.
 *
 * A connection: `{ id, url, name, reported, local, enabled }`. `id` is `obs_` + 8 hex, never the address (addresses
 * change on DHCP). `name` is the user's rename ('' for none), `reported` the name the network gave, `local` whether it
 * is this PC, `enabled` whether a connection is wanted (Disconnect clears it, so it survives a restart).
 *
 * Routing: a command may carry `obsId`. Without one (a trigger, an older dashboard) it goes to the FIRST OBS in the
 * list, so a one-OBS user sees no change. A command for an id that is no longer here is dropped: a scene switch meant
 * for a removed PC must not land on another. OBS events come from every connection, each tagged with its id and name;
 * stats from each watched one, each sample carrying the whole list (`connections`) for the dashboard's picker.
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
 * The settings from before there were several connections become connection #1, once. The old
 * keys stay for a downgrade, and the saved password's encrypted blob moves as it is (it is the same secret).
 * `raw` is the settings file as read; answers `{ settings, changed }`.
 */
function migrateSettings(raw, makeId = newId) {
    if (!raw || Array.isArray(raw.obsConnections)) {
        return { settings: raw, changed: false };
    }
    const typed = typeof raw.obsUrl === 'string' && raw.obsUrl ? raw.obsUrl : `ws://127.0.0.1:${DEFAULT_PORT}`;
    // Stored the way add() and a scan spell it, so the same OBS is never listed twice ("ws://10.0.0.88" was valid).
    const url = normalizeAddress(typed) || typed;
    const host = hostOf(url);
    const id = makeId();
    const conn = {
        id,
        url,
        name: (raw.obsNames && raw.obsNames[host]) || '',
        reported: raw.obsName || '',
        local: raw.obsLocal !== undefined ? raw.obsLocal !== false : LOCAL_URL.test(url),
        enabled: true,
    };
    const obsPasswords = { ...(raw.obsPasswords || {}) };
    if (raw.obsPassword) obsPasswords[id] = raw.obsPassword;
    return { settings: { ...raw, obsConnections: [conn], obsPasswords }, changed: true };
}

/**
 * A list saved by v1.3.3, which marked one connection `live`: that one moves to the top (where a command with no obsId
 * now goes, so nothing changes for it) and the key is dropped. Answers `{ list, changed }`.
 */
function dropLiveRole(list) {
    if (!list.some((c) => 'live' in c)) return { list, changed: false };
    const live = list.findIndex((c) => c.live);
    const ordered = live > 0 ? [list[live], ...list.slice(0, live), ...list.slice(live + 1)] : list;
    return { list: ordered.map(({ live: _drop, ...c }) => c), changed: true };
}

class ObsConnections {
    /**
     * `store`: `{ list(), save(list), password(id), setPassword(id, value), deletePassword(id), settings() }`.
     * `makeBridge(conn, hooks)` builds one ObsBridge for a connection (index.js passes the real one; tests a fake).
     */
    constructor({ store, makeBridge, onLog = () => {}, onStatus = () => {}, onObsEvent = () => {}, onStats = () => {}, makeId = newId, now = Date.now }) {
        this.store = store;
        this.makeBridge = makeBridge;
        this.onLog = onLog;
        this.onStatus = onStatus;
        this.onObsEvent = onObsEvent;
        this.onStats = onStats;
        this.makeId = makeId;
        this.now = now;
        /**
         * The last WATCH_STATS that named no OBS (an older dashboard): which connection it went to and until when. When
         * the first changes (a move, a remove) that watch follows it, so the dashboard never gets two OBS's samples
         * at once. `watchedById` is each named watch's end, so following never stops a watch a picker asked for.
         */
        this.untaggedWatch = { id: null, until: 0 };
        this.watchedById = new Map();
        /** id -> ObsBridge, for the saved connections only (an add being tried is not in here until it connects). */
        this.bridges = new Map();
        /** Adds being tried: id -> bridge, and the addresses they hold, so the same PC can't be added twice at once. */
        this.trials = new Map();
        this.adding = new Set();
        const { list, changed } = dropLiveRole(store.list() || []);
        this.list = list;
        if (changed) store.save(this.list);
        this.list.forEach((conn) => this.bridges.set(conn.id, this.bridgeFor(conn)));
    }

    conn(id) {
        return this.list.find((c) => c.id === id) || null;
    }

    /** The bridge of the first OBS in the list (where a command with no obsId goes), or null with none set up. */
    get first() {
        const conn = this.list[0];
        return conn ? this.bridges.get(conn.id) || null : null;
    }

    /** Every OBS, in the list's order, as a stats sample carries it for the dashboard's picker. */
    get summary() {
        return this.list.map((conn) => {
            const bridge = this.bridges.get(conn.id);
            const s = bridge ? bridge.status : null;
            return {
                obsId: conn.id,
                name: displayName(conn),
                connected: Boolean(s && s.connected),
                streamState: (s && s.stream && s.stream.state) || 'off',
            };
        });
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
            // Every OBS fires triggers, tagged: a trigger that names none fires for any (the API, flow 10).
            onObsEvent: (event) => {
                const current = this.conn(id);
                if (!current || this.bridges.get(id) !== bridge) return undefined;
                return this.onObsEvent({ ...event, obsId: id, name: displayName(current) });
            },
            onStats: (payload, options) => {
                const current = this.conn(id);
                if (!current || this.bridges.get(id) !== bridge) return undefined;
                return this.onStats({ ...payload, obsId: id, name: displayName(current), connections: this.summary }, options);
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

    /** Whether any OBS is connected (the sidebar's OBS line). */
    get connected() {
        return [...this.bridges.values()].some((b) => b.connected);
    }

    publish() {
        this.onStatus(this.status);
    }

    save() {
        this.store.save(this.list);
    }

    /** Connect each connection that wasn't disconnected by hand (on launch, when auto-connect is on). */
    async connectAll() {
        await Promise.all(this.list.filter((c) => c.enabled !== false).map((c) => this.bridges.get(c.id).connect()));
    }

    async disconnectAll() {
        await Promise.all([...this.bridges.values(), ...this.trials.values()].map((b) => b.disconnect().catch(() => {})));
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
        const key = isLocal ? `local:${portOf(address)}` : address;
        if (this.adding.has(key)) {
            return { ok: false, error: `Already connecting to ${host}.` };
        }
        this.adding.add(key);
        try {
            return await this.tryAdd({ address, host, isLocal, reported, password });
        } finally {
            this.adding.delete(key);
        }
    }

    async tryAdd({ address, host, isLocal, reported, password }) {
        const conn = {
            id: this.makeId(),
            url: address,
            name: '',
            reported: reported || '',
            local: isLocal,
            enabled: true,
        };
        while (this.conn(conn.id) || this.trials.has(conn.id)) conn.id = this.makeId();
        if (password) await this.store.setPassword(conn.id, password);
        // Tried outside the list: until it is in, its status, events and stats go nowhere and commands don't reach it.
        const trial = this.bridgeFor(conn);
        this.trials.set(conn.id, trial);
        const ok = await trial.connect();
        this.trials.delete(conn.id);
        if (!ok) {
            const { state, error } = trial.status;
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
        this.bridges.set(conn.id, trial);
        this.list = [...this.list, conn];
        this.save();
        this.onLog(`Added ${displayName(conn)}.`);
        this.publish();
        return { ok: true, id: conn.id };
    }

    /** Forget a connection and its password. A watch on it ends with it. */
    async remove(id) {
        const conn = this.conn(id);
        if (!conn) return false;
        const bridge = this.bridges.get(id);
        const prevFirst = this.list[0] && this.list[0].id;
        this.bridges.delete(id);
        this.list = this.list.filter((c) => c.id !== id);
        this.watchedById.delete(id);
        this.save();
        if (bridge && bridge.stopStats) bridge.stopStats();
        this.followFirst(prevFirst);
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

    /** Move a connection up (-1) or down (+1) the list. The first is where a command with no obsId goes. */
    move(id, delta) {
        const from = this.list.findIndex((c) => c.id === id);
        const to = from + Math.sign(Number(delta) || 0);
        if (from < 0 || to < 0 || to >= this.list.length || to === from) return false;
        const prevFirst = this.list[0].id;
        const list = [...this.list];
        [list[from], list[to]] = [list[to], list[from]];
        this.list = list;
        this.save();
        this.followFirst(prevFirst);
        this.publish();
        return true;
    }

    /** The first was `prevId` and may not be now: a watch that named no OBS moves to the new first, for what it had left. */
    followFirst(prevId) {
        const next = this.list[0];
        if (!next || next.id === prevId || this.untaggedWatch.id !== prevId) return;
        const now = this.now();
        const left = Math.ceil((this.untaggedWatch.until - now) / 1000);
        this.untaggedWatch = { id: next.id, until: this.untaggedWatch.until };
        if (left <= 0) return;
        const prev = this.bridges.get(prevId);
        if (prev && prev.stopStats && !((this.watchedById.get(prevId) || 0) > now)) prev.stopStats();
        const bridge = this.bridges.get(next.id);
        if (bridge && bridge.watchStats) bridge.watchStats(left);
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

    /** Start or stop the stream on one connection (the first when no id is given). */
    async setStreaming(id, on) {
        const bridge = id ? this.bridges.get(id) : this.first;
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
     * picks the connection; none means the first in the list. WATCH_STATS works the same way: the API keeps each
     * OBS's samples apart by obsId, and every sample lists all of them, so a dashboard can then pick another.
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
        const bridge = obsId ? this.bridges.get(obsId) : this.first;
        if (!bridge) {
            // No OBS set up here (the app on a second PC) stays silent for WATCH_STATS, as before.
            if (obsId || !(action && action.type === 'WATCH_STATS')) {
                this.onLog(obsId ? 'Ignored an OBS action for an OBS that is no longer set up here.' : 'Ignored an OBS action — no OBS set up.');
            }
            return undefined;
        }
        if (action && action.type === 'WATCH_STATS') {
            const asked = Number(action.seconds);
            const until = this.now() + Math.min(Number.isFinite(asked) && asked > 0 ? asked : 60, 120) * 1000;
            if (obsId) this.watchedById.set(obsId, Math.max(this.watchedById.get(obsId) || 0, until));
            else this.untaggedWatch = { id: this.list[0].id, until };
        }
        return bridge.execute(command);
    }
}

module.exports = {
    ObsConnections, migrateSettings, normalizeAddress, displayName, dropLiveRole, newId, hostOf, ID_PATTERN,
};
