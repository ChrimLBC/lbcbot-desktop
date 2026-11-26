'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    ObsConnections, migrateSettings, normalizeAddress, displayName, dropLiveRole, newId, ID_PATTERN,
} = require('../src/main/obsconnections');
const { routeDeviceCommand } = require('../src/main/devicecontrol');

/** A stand-in ObsBridge: records what it was asked, and connects as `outcomes[url]` says ('ok' by default). */
class FakeBridge {
    constructor(conn, hooks, outcomes) {
        this.conn = conn;
        this.hooks = hooks;
        this.outcomes = outcomes;
        this.executed = [];
        this.connects = 0;
        this.connected = false;
        this.state = 'off';
        this.disconnected = false;
    }

    get status() {
        return { connected: this.connected, state: this.state, error: null, stream: { state: 'off', startedAt: null } };
    }

    async connect() {
        this.connects += 1;
        const outcome = this.outcomes[this.hooks.settings().obsUrl] || 'ok';
        this.connected = outcome === 'ok';
        this.state = outcome === 'ok' ? 'connected' : outcome;
        this.hooks.onStatus(this.status);
        return this.connected;
    }

    async disconnect() {
        this.disconnected = true;
        this.connected = false;
        this.state = 'off';
        this.hooks.onStatus(this.status);
    }

    execute(command) {
        this.executed.push(command);
    }

    async setStreaming(on) {
        this.executed.push({ streaming: on });
        return { ok: true };
    }
}

function makeManager(list = [], { outcomes = {}, passwords = {} } = {}) {
    const saved = [];
    const secrets = new Map(Object.entries(passwords));
    const statuses = [];
    const events = [];
    const stats = [];
    const logs = [];
    const bridges = [];
    let n = 0;
    const manager = new ObsConnections({
        store: {
            list: () => list,
            save: (next) => saved.push(next),
            password: (id) => secrets.get(id) || null,
            setPassword: async (id, value) => { secrets.set(id, value); },
            deletePassword: async (id) => { secrets.delete(id); },
            settings: () => ({ forwardObsEvents: true }),
        },
        makeBridge: (conn, hooks) => {
            const bridge = new FakeBridge(conn, hooks, outcomes);
            bridges.push(bridge);
            return bridge;
        },
        makeId: () => `obs_${String(++n).padStart(8, '0')}`,
        onStatus: (s) => statuses.push(s),
        onObsEvent: (e) => events.push(e),
        onStats: (p) => stats.push(p),
        onLog: (line) => logs.push(line),
    });
    return { manager, saved, secrets, statuses, events, stats, logs, bridges };
}

const here = { id: 'obs_aaaaaaaa', url: 'ws://127.0.0.1:4455', name: '', reported: '', local: true, enabled: true };
const there = { id: 'obs_bbbbbbbb', url: 'ws://10.0.0.88:4455', name: 'Streaming PC', reported: '', local: false, enabled: true };

// ------------------------------------------------------------------ ids, addresses, names

test('ids are obs_ and 8 hex, never the address', () => {
    for (let i = 0; i < 20; i += 1) assert.match(newId(), ID_PATTERN);
    assert.equal(newId(() => Buffer.from([0xde, 0xad, 0xbe, 0xef])), 'obs_deadbeef');
});

test('a typed address becomes a ws:// URL with the OBS port', () => {
    assert.equal(normalizeAddress('10.0.0.88'), 'ws://10.0.0.88:4455');
    assert.equal(normalizeAddress(' 10.0.0.88:4460 '), 'ws://10.0.0.88:4460');
    assert.equal(normalizeAddress('ws://streampc.lan:4455/'), 'ws://streampc.lan:4455');
    assert.equal(normalizeAddress('wss://obs.example:443'), 'wss://obs.example:443');
    for (const bad of ['', 'http://10.0.0.88', 'ws://10.0.0.88:4455/x', 'ws://u:p@10.0.0.88', 'ws://10.0.0.88:99999', '10.0.0.88?x=1']) {
        assert.equal(normalizeAddress(bad), null, bad);
    }
});

test('a connection is called by its rename, else This PC, else the reported name, else its address', () => {
    assert.equal(displayName({ ...there }), 'Streaming PC');
    assert.equal(displayName({ ...here }), 'This PC');
    assert.equal(displayName({ ...there, name: '', reported: 'CHRIMLBC' }), 'CHRIMLBC');
    assert.equal(displayName({ ...there, name: '' }), '10.0.0.88');
});

// ------------------------------------------------------------------ migration

test('the one OBS from before becomes connection #1 and keeps its name and password', () => {
    const raw = {
        obsUrl: 'ws://10.0.0.88:4455', obsName: 'CHRIMLBC', obsLocal: false, obsNames: { '10.0.0.88': 'Streaming PC' },
        obsPassword: { encrypted: 'BLOB' },
    };
    const { settings, changed } = migrateSettings(raw, () => 'obs_12345678');
    assert.equal(changed, true);
    assert.deepEqual(settings.obsConnections, [{
        id: 'obs_12345678', url: 'ws://10.0.0.88:4455', name: 'Streaming PC', reported: 'CHRIMLBC', local: false, enabled: true,
    }]);
    assert.deepEqual(settings.obsPasswords, { obs_12345678: { encrypted: 'BLOB' } });
    // The old keys stay, for a downgrade.
    assert.equal(settings.obsUrl, 'ws://10.0.0.88:4455');
    assert.deepEqual(settings.obsPassword, { encrypted: 'BLOB' });
});

test('a migrated address is spelled the way a scan spells it, so it shows as already added', () => {
    const { settings } = migrateSettings({ obsUrl: 'ws://10.0.0.88' }, () => 'obs_00000001');
    assert.equal(settings.obsConnections[0].url, 'ws://10.0.0.88:4455');
});

test('migration runs once: a list already there is left alone', () => {
    const raw = { obsUrl: 'ws://10.0.0.1:4455', obsConnections: [] };
    const { settings, changed } = migrateSettings(raw);
    assert.equal(changed, false);
    assert.equal(settings, raw);
});

test('a settings file from before any OBS setup migrates the default local OBS, with no password', () => {
    const { settings } = migrateSettings({ autoConnectObs: true }, () => 'obs_00000001');
    assert.equal(settings.obsConnections[0].url, 'ws://127.0.0.1:4455');
    assert.equal(settings.obsConnections[0].local, true);
    assert.deepEqual(settings.obsPasswords, {});
});

// ------------------------------------------------------------------ v1.3.3's live role

test('a list saved with a live role puts that one first and drops the key, once', () => {
    const { list, changed } = dropLiveRole([{ ...here, live: false }, { ...there, live: true }]);
    assert.equal(changed, true);
    assert.deepEqual(list.map((c) => c.id), [there.id, here.id]);
    assert.equal(list.some((c) => 'live' in c), false);
    assert.equal(dropLiveRole(list).changed, false);
    const { manager, saved } = makeManager([{ ...here, live: false }, { ...there, live: true }]);
    assert.deepEqual(manager.list.map((c) => c.id), [there.id, here.id]);
    assert.deepEqual(saved.pop().map((c) => c.id), [there.id, here.id]);
});

// ------------------------------------------------------------------ add, remove, rename, move

test('an added PC goes to the end of the list; the first stays where commands with no obsId go', async () => {
    const { manager, saved } = makeManager([{ ...here }]);
    const result = await manager.add({ url: 'ws://10.0.0.88:4455', reported: 'CHRIMLBC' });
    assert.equal(result.ok, true);
    const list = saved.pop();
    assert.deepEqual(list.map((c) => c.id), [here.id, result.id]);
    assert.equal(list[1].reported, 'CHRIMLBC');
    assert.equal('live' in list[1], false);
    assert.equal(manager.first, manager.bridges.get(here.id));
});

test('an add that needs a password is not kept, and says so', async () => {
    const { manager, saved, secrets } = makeManager([], { outcomes: { 'ws://10.0.0.88:4455': 'needs-password' } });
    const result = await manager.add({ url: '10.0.0.88' });
    assert.deepEqual({ ok: result.ok, needsPassword: result.needsPassword }, { ok: false, needsPassword: true });
    assert.equal(manager.list.length, 0);
    assert.equal(manager.bridges.size, 0);
    assert.equal(saved.length, 0);
    assert.equal(secrets.size, 0);
});

test('a wrong password is not kept: the list stays as it was and the password is forgotten', async () => {
    const { manager, secrets } = makeManager([{ ...here }], { outcomes: { 'ws://10.0.0.88:4455': 'bad-password' } });
    const result = await manager.add({ url: '10.0.0.88', password: 'nope' });
    assert.equal(result.badPassword, true);
    assert.match(result.error, /Wrong password/);
    assert.equal(manager.list.length, 1);
    assert.equal(secrets.size, 0);
});

test('an unreachable address is not added', async () => {
    const { manager } = makeManager([], { outcomes: { 'ws://10.0.0.99:4455': 'retrying' } });
    const result = await manager.add({ url: '10.0.0.99' });
    assert.equal(result.ok, false);
    assert.equal(manager.list.length, 0);
});

test('the same OBS is not added twice, This PC under any of its addresses included', async () => {
    const { manager } = makeManager([{ ...here }, { ...there }]);
    assert.match((await manager.add({ url: 'ws://10.0.0.88:4455' })).error, /already added/);
    assert.match((await manager.add({ url: 'ws://10.0.0.222:4455', local: true })).error, /already added/);
    assert.match((await manager.add({ url: 'not an address!' })).error, /isn't an address/);
});

test('a password given with an add is saved under the new id only once it connects', async () => {
    const { manager, secrets } = makeManager([]);
    const result = await manager.add({ url: '10.0.0.88', password: 'secret' });
    assert.equal(secrets.get(result.id), 'secret');
});

test('removing the first makes the next one first and forgets its password', async () => {
    const { manager, saved, secrets, bridges } = makeManager([{ ...here }, { ...there }], { passwords: { [here.id]: 'pw' } });
    await manager.remove(here.id);
    const list = saved.pop();
    assert.deepEqual(list.map((c) => c.id), [there.id]);
    assert.equal(manager.first, manager.bridges.get(there.id));
    assert.equal(secrets.has(here.id), false);
    assert.equal(bridges[0].disconnected, true);
    assert.equal(manager.bridges.has(here.id), false);
});

test('rename, move and disconnect are saved; a rename is cut to 40 characters', async () => {
    const { manager, saved } = makeManager([{ ...here }, { ...there }]);
    manager.rename(here.id, `  Source PC${'x'.repeat(50)} `);
    assert.equal(saved.pop()[0].name.length, 40);
    assert.equal(manager.move(there.id, -1), true);
    assert.deepEqual(saved.pop().map((c) => c.id), [there.id, here.id]);
    assert.equal(manager.move(there.id, -1), false); // already first
    assert.equal(manager.move(here.id, 1), false); // already last
    assert.equal(manager.move('obs_deadbeef', 1), false);
    assert.equal(manager.first, manager.bridges.get(there.id));
    await manager.disconnect(there.id);
    assert.equal(saved.pop()[0].enabled, false);
});

test('connectAll skips a connection disconnected by hand', async () => {
    const { manager, bridges } = makeManager([{ ...here }, { ...there, enabled: false }]);
    await manager.connectAll();
    assert.deepEqual(bridges.map((b) => b.connects), [1, 0]);
});

test('the status lists every connection, never a password', () => {
    const { manager } = makeManager([{ ...here }, { ...there }], { passwords: { [there.id]: 'hunter2' } });
    const { connections } = manager.status;
    assert.deepEqual(connections.map((c) => [c.displayName, c.host, c.hasPassword]), [
        ['This PC', '127.0.0.1', false], ['Streaming PC', '10.0.0.88', true],
    ]);
    assert.equal(JSON.stringify(manager.status).includes('hunter2'), false);
});

test('a scan that now reports a name for a listed PC keeps it', () => {
    const { manager, saved } = makeManager([{ ...here }, { ...there, name: '' }]);
    manager.noteScan([{ url: 'ws://10.0.0.88:4455', name: 'CHRIMLBC', local: false }]);
    assert.equal(saved.pop()[1].reported, 'CHRIMLBC');
    assert.equal(manager.status.connections[1].displayName, 'CHRIMLBC');
});

// ------------------------------------------------------------------ routing

const command = (action, extra = {}) => ({ action: JSON.stringify(action), ...extra });

test('a command with no obsId goes to the first OBS in the list, so a one-OBS user sees no change', () => {
    const { manager, bridges } = makeManager([{ ...there }, { ...here }]);
    routeDeviceCommand(command({ type: 'SWITCH_SCENE', sceneName: 'BRB' }), { obs: manager, greensplit: null });
    routeDeviceCommand(command({ type: 'START_STREAM' }), { obs: manager, greensplit: null });
    assert.equal(bridges[0].executed.length, 2);
    assert.equal(bridges[1].executed.length, 0);
});

test('a command with an obsId goes to that connection, on the command or in its action', () => {
    const { manager, bridges } = makeManager([{ ...here }, { ...there }]);
    manager.execute(command({ type: 'TOGGLE_MUTE', inputName: 'Mic' }, { obsId: there.id }));
    manager.execute(command({ type: 'STOP_STREAM', obsId: there.id }));
    assert.equal(bridges[0].executed.length, 0);
    assert.equal(bridges[1].executed.length, 2);
});

test('a command for an OBS that is no longer here is dropped, never sent to the first', () => {
    const { manager, bridges, logs } = makeManager([{ ...here }]);
    manager.execute(command({ type: 'STOP_STREAM' }, { obsId: 'obs_deadbeef' }));
    manager.execute(command({ type: 'STOP_STREAM' }, { obsId: '10.0.0.88' }));
    assert.equal(bridges[0].executed.length, 0);
    assert.equal(logs.length, 2);
});

test('WATCH_STATS watches the OBS it names, else the first', () => {
    const { manager, bridges } = makeManager([{ ...here }, { ...there }]);
    manager.execute(command({ type: 'WATCH_STATS', seconds: 60 }));
    assert.deepEqual(bridges.map((b) => b.executed.length), [1, 0]);
    manager.execute(command({ type: 'WATCH_STATS', seconds: 60, obsId: there.id }));
    assert.deepEqual(bridges.map((b) => b.executed.length), [1, 1]);
});

test('with no OBS set up, WATCH_STATS is silent and nothing is logged for it', () => {
    const { manager, logs } = makeManager([]);
    assert.equal(manager.execute(command({ type: 'WATCH_STATS', seconds: 60 })), undefined);
    assert.equal(logs.length, 0);
});

test('setStreaming with no id starts the first', async () => {
    const { manager, bridges } = makeManager([{ ...there }, { ...here }]);
    await manager.setStreaming(null, true);
    await manager.setStreaming(here.id, false);
    assert.deepEqual(bridges.map((b) => b.executed), [[{ streaming: true }], [{ streaming: false }]]);
});

// ------------------------------------------------------------------ events and stats tagging

test('every OBS fires triggers, each tagged with its id and name', () => {
    const { bridges, events } = makeManager([{ ...here }, { ...there }]);
    bridges[0].hooks.onObsEvent({ eventType: 'OBS_SCENE_CHANGED', sceneName: 'Game' });
    bridges[1].hooks.onObsEvent({ eventType: 'OBS_STREAM_STARTED' });
    assert.deepEqual(events, [
        { eventType: 'OBS_SCENE_CHANGED', sceneName: 'Game', obsId: here.id, name: 'This PC' },
        { eventType: 'OBS_STREAM_STARTED', obsId: there.id, name: 'Streaming PC' },
    ]);
});

test('every watched OBS posts stats, each with its obsId and name and the whole list for the picker', async () => {
    const { manager, bridges, stats } = makeManager([{ ...here }, { ...there }]);
    await bridges[1].connect();
    bridges[0].hooks.onStats({ connected: false, host: '127.0.0.1', name: '', sampledAt: 1 });
    bridges[1].hooks.onStats({ connected: true, host: '10.0.0.88', name: '', sampledAt: 2 });
    assert.deepEqual(stats.map((s) => [s.obsId, s.name]), [[here.id, 'This PC'], [there.id, 'Streaming PC']]);
    assert.deepEqual(stats[1].connections, [
        { obsId: here.id, name: 'This PC', connected: false, streamState: 'off' },
        { obsId: there.id, name: 'Streaming PC', connected: true, streamState: 'off' },
    ]);
    manager.move(there.id, -1);
    bridges[0].hooks.onStats({ connected: false });
    assert.deepEqual(stats[2].connections.map((c) => c.obsId), [there.id, here.id]);
});

test('the same PC added twice at once is tried once', async () => {
    const { manager, saved } = makeManager([]);
    const [a, b] = await Promise.all([manager.add({ url: '10.0.0.88' }), manager.add({ url: '10.0.0.88:4455' })]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    assert.equal(saved.at(-1).length, 1);
});

test('a PC still being tried fires no triggers and gets no commands', async () => {
    const { manager, bridges, events } = makeManager([]);
    const pending = manager.add({ url: '10.0.0.88' });
    bridges[0].hooks.onObsEvent({ eventType: 'OBS_SCENE_CHANGED' });
    manager.execute({ action: JSON.stringify({ type: 'WATCH_STATS' }) });
    assert.equal(events.length, 0);
    assert.equal(bridges[0].executed.length, 0);
    await pending;
});

test('a removed connection\'s bridge can no longer post events, stats or status', async () => {
    const { manager, bridges, events, stats, statuses } = makeManager([{ ...here }, { ...there }]);
    await manager.remove(there.id);
    const before = statuses.length;
    bridges[1].hooks.onObsEvent({ eventType: 'OBS_STREAM_STARTED' });
    bridges[1].hooks.onStats({ connected: false });
    bridges[1].hooks.onStatus({});
    assert.deepEqual([events.length, stats.length, statuses.length], [0, 0, before]);
});

test('each bridge reads its own address over the shared settings', () => {
    const { bridges } = makeManager([{ ...here }, { ...there }]);
    assert.deepEqual(bridges.map((b) => b.hooks.settings().obsUrl), [here.url, there.url]);
    assert.equal(bridges[1].hooks.settings().forwardObsEvents, true);
    assert.equal(bridges[1].hooks.name(), 'Streaming PC');
});
