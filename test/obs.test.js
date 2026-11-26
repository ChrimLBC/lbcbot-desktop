'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ObsBridge, retryDelay } = require('../src/main/obs');
const discovery = require('../src/main/obsdiscovery');

/** An obs-websocket-js stand-in: `connectResults` are what each connect() does in turn ('ok', or an error). */
class FakeClient extends EventEmitter {
    constructor(connectResults = ['ok'], responses = {}) {
        super();
        this.connectResults = connectResults;
        this.responses = responses;
        this.calls = [];
        this.connects = 0;
    }

    async connect() {
        const result = this.connectResults[Math.min(this.connects, this.connectResults.length - 1)];
        this.connects += 1;
        if (result !== 'ok') throw result;
    }

    async disconnect() {}

    async call(name) {
        this.calls.push(name);
        const response = this.responses[name];
        if (response instanceof Error) throw response;
        return response || {};
    }
}

function makeBridge(client, { password = 'pw', settings = {}, onStats, name } = {}) {
    const timers = [];
    const statuses = [];
    let clock = 1_000_000;
    const bridge = new ObsBridge({
        client,
        settings: () => ({ obsUrl: 'ws://10.0.0.88:4455', forwardObsEvents: true, ...settings }),
        password: () => password,
        setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimer: () => {},
        now: () => clock,
        onStatus: (s) => statuses.push(s),
        onStats,
        name,
    });
    return { bridge, timers, statuses, tick: (ms) => { clock += ms; } };
}

const unreachable = Object.assign(new Error('connect ECONNREFUSED'), { code: -1 });
const badPassword = Object.assign(new Error('Authentication failed.'), { code: 4009 });

test('retryDelay doubles from 1 s and stops at 30 s', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 20].map((n) => retryDelay(n)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test('an unreachable OBS keeps retrying with backoff until it answers', async () => {
    const client = new FakeClient([unreachable, unreachable, 'ok']);
    const { bridge, timers } = makeBridge(client);
    assert.equal(await bridge.connect(), false);
    assert.equal(bridge.state, 'retrying');
    assert.match(bridge.error, /10\.0\.0\.88/);
    assert.equal(timers[0].ms, 1000);
    await timers[0].fn();
    assert.equal(timers[1].ms, 2000);
    await timers[1].fn();
    assert.equal(bridge.connected, true);
    assert.equal(bridge.state, 'connected');
    assert.equal(bridge.error, null);
});

test('a wrong password stops the loop instead of retrying', async () => {
    const client = new FakeClient([badPassword]);
    const { bridge, timers } = makeBridge(client);
    assert.equal(await bridge.connect(), false);
    assert.equal(bridge.state, 'bad-password');
    assert.equal(bridge.wanted, false);
    assert.equal(timers.length, 0);
    assert.match(bridge.error, /rejected the password/);
});

test('no password saved says the OBS needs one', async () => {
    const { bridge } = makeBridge(new FakeClient([badPassword]), { password: null });
    await bridge.connect();
    assert.equal(bridge.state, 'needs-password');
    assert.match(bridge.error, /needs its password/);
});

test('Disconnect stops a waiting retry', async () => {
    const client = new FakeClient([unreachable, 'ok']);
    const { bridge, timers } = makeBridge(client);
    await bridge.connect();
    await bridge.disconnect();
    await timers[0].fn();
    assert.equal(client.connects, 1);
    assert.equal(bridge.state, 'off');
});

test('a dropped connection reconnects on its own while wanted', async () => {
    const client = new FakeClient(['ok']);
    const { bridge, timers } = makeBridge(client);
    await bridge.connect();
    client.emit('ConnectionClosed');
    assert.equal(bridge.connected, false);
    assert.equal(bridge.state, 'retrying');
    await timers[0].fn();
    assert.equal(bridge.connected, true);
});

test('connecting reads whether OBS is already live, and for how long', async () => {
    const client = new FakeClient(['ok'], { GetStreamStatus: { outputActive: true, outputDuration: 65_000, outputReconnecting: false } });
    const { bridge } = makeBridge(client);
    await bridge.connect();
    assert.equal(bridge.status.stream.state, 'live');
    assert.equal(bridge.status.stream.startedAt, 1_000_000 - 65_000);
});

test('stream state follows OBS through start, reconnect and stop', async () => {
    const { bridge, tick } = makeBridge(new FakeClient(['ok'], { GetStreamStatus: { outputActive: false } }));
    await bridge.connect();
    assert.equal(bridge.stream.state, 'off');
    bridge.obs.emit('StreamStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING' });
    assert.equal(bridge.stream.state, 'starting');
    bridge.obs.emit('StreamStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
    const startedAt = bridge.stream.startedAt;
    assert.equal(bridge.stream.state, 'live');
    tick(5000);
    bridge.obs.emit('StreamStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_RECONNECTING' });
    bridge.obs.emit('StreamStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_RECONNECTED' });
    assert.equal(bridge.stream.state, 'live');
    assert.equal(bridge.stream.startedAt, startedAt, 'a reconnect keeps the uptime');
    bridge.obs.emit('StreamStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' });
    assert.deepEqual(bridge.stream, { state: 'off', startedAt: null });
});

test('START_STREAM and STOP_STREAM from the server reach OBS', async () => {
    const client = new FakeClient(['ok']);
    const { bridge } = makeBridge(client);
    await bridge.connect();
    await bridge.execute({ action: JSON.stringify({ type: 'START_STREAM' }) });
    await bridge.execute({ action: { type: 'STOP_STREAM' } });
    assert.deepEqual(client.calls.filter((c) => /Stream$/.test(c)), ['StartStream', 'StopStream']);
});

test('starting a stream that is already live counts as done', async () => {
    const client = new FakeClient(['ok'], { StartStream: Object.assign(new Error('already active'), { code: 500 }) });
    const { bridge } = makeBridge(client);
    await bridge.connect();
    assert.deepEqual(await bridge.setStreaming(true), { ok: true });
});

test('Start without a connection says so', async () => {
    const { bridge } = makeBridge(new FakeClient());
    assert.equal((await bridge.setStreaming(true)).ok, false);
});

// ------------------------------------------------------------------------------------------------ discovery

test('scanTargets sweeps each private adapter\'s /24 and marks this PC', () => {
    const hosts = discovery.scanTargets({
        Ethernet: [
            { family: 'IPv4', address: '10.0.0.222', netmask: '255.255.255.0', cidr: '10.0.0.222/24', internal: false },
            { family: 'IPv6', address: 'fe80::1', internal: false },
        ],
        Loopback: [{ family: 'IPv4', address: '127.0.0.1', cidr: '127.0.0.1/8', internal: true }],
        Public: [{ family: 'IPv4', address: '8.8.8.8', cidr: '8.8.8.8/24', internal: false }],
    });
    assert.equal(hosts.size, 254);
    assert.ok(hosts.has('10.0.0.1') && hosts.has('10.0.0.254'));
    assert.ok(!hosts.has('10.0.0.0') && !hosts.has('10.0.0.255'));
    assert.equal(hosts.get('10.0.0.222').local, true);
    assert.equal(hosts.get('10.0.0.88').local, false);
});

test('scanTargets narrows a /16 to its own /24, never 65,000 hosts', () => {
    const hosts = discovery.scanTargets({ Wifi: [{ family: 'IPv4', address: '192.168.5.9', cidr: '192.168.5.9/16', internal: false }] });
    assert.equal(hosts.size, 254);
    assert.ok(hosts.has('192.168.5.1'));
});

test('isPrivate knows the three private ranges', () => {
    assert.deepEqual(['10.1.2.3', '172.16.0.1', '172.31.9.9', '172.32.0.1', '192.168.1.1', '8.8.8.8'].map(discovery.isPrivate),
        [true, true, true, false, true, false]);
});

test('parseNbtstat reads the machine name', () => {
    const out = `
    Ethernet:
    Node IpAddress: [10.0.0.222] Scope Id: []

               NetBIOS Remote Machine Name Table

           Name               Type         Status
        ---------------------------------------------
        CHRIMLBC       <00>  UNIQUE      Registered
        WORKGROUP      <00>  GROUP       Registered
        CHRIMLBC       <20>  UNIQUE      Registered
`;
    assert.equal(discovery.parseNbtstat(out), 'CHRIMLBC');
    assert.equal(discovery.parseNbtstat('Host not found.'), null);
});

test('discover keeps only real obs-websocket answers, this PC first and once', async () => {
    const found = await discovery.discover({
        interfaces: {
            Ethernet: [{ family: 'IPv4', address: '10.0.0.222', cidr: '10.0.0.222/24', internal: false }],
            WSL: [{ family: 'IPv4', address: '172.20.0.1', cidr: '172.20.0.1/24', internal: false }],
        },
        probeFn: async (host) => ['10.0.0.88', '10.0.0.222', '10.0.0.50', '172.20.0.1'].includes(host),
        helloFn: async (url) => (url.includes('10.0.0.50') ? null : { version: '5.6.0', authRequired: !url.includes('222') }),
        nameFn: async (host) => (host === '10.0.0.88' ? 'ChrimLBC' : null),
        localName: 'DESKTOP-SP5G8P7',
    });
    assert.deepEqual(found.map((r) => [r.host, r.name, r.local, r.authRequired]), [
        ['10.0.0.222', 'DESKTOP-SP5G8P7', true, false],
        ['10.0.0.88', 'ChrimLBC', false, true],
    ]);
    assert.equal(found[1].url, 'ws://10.0.0.88:4455');
});

test('readHello tells obs-websocket from anything else on the port', async () => {
    class FakeWs {
        constructor(url) { this.url = url; setTimeout(() => this.onmessage({ data: url.includes('obs') ? '{"op":0,"d":{"obsWebSocketVersion":"5.6.0","authentication":{"salt":"x"}}}' : 'HTTP/1.1 400' })); }
        close() {}
    }
    assert.deepEqual(await discovery.readHello('ws://obs:4455', 500, FakeWs), { version: '5.6.0', authRequired: true });
    assert.equal(await discovery.readHello('ws://other:4455', 500, FakeWs), null);
});

test('scanTargets skips WSL, Hyper-V and other virtual adapters', () => {
    const hosts = discovery.scanTargets({
        Ethernet: [{ family: 'IPv4', address: '10.0.0.222', cidr: '10.0.0.222/24', internal: false }],
        'vEthernet (WSL)': [{ family: 'IPv4', address: '172.27.224.1', cidr: '172.27.224.1/20', internal: false }],
        'vEthernet (Default Switch)': [{ family: 'IPv4', address: '172.23.112.1', cidr: '172.23.112.1/20', internal: false }],
    });
    assert.equal(hosts.size, 254);
    assert.ok(!hosts.has('172.27.224.1'));
});

// ------------------------------------------------------------------ live stats

const watch = (seconds) => ({ target: 'obs', action: JSON.stringify({ type: 'WATCH_STATS', seconds }) });

/** A connected bridge whose OBS answers GetStats/GetStreamStatus with `stream` and `stats`, posting into `posts`. */
async function statsBridge({ stream = {}, stats = {}, connect = true } = {}) {
    const client = new FakeClient(['ok'], {
        GetStreamStatus: { outputActive: true, outputDuration: 60000, outputBytes: 0, outputCongestion: 0.0123,
            outputSkippedFrames: 3, outputTotalFrames: 3600, ...stream },
        GetStats: { cpuUsage: 12.345, memoryUsage: 812.44, availableDiskSpace: 402113.6, activeFps: 59.9401,
            outputSkippedFrames: 1, outputTotalFrames: 3600, renderSkippedFrames: 2, renderTotalFrames: 3700, ...stats },
        GetVideoSettings: { fpsNumerator: 60000, fpsDenominator: 1001 },
    });
    const posts = [];
    const made = makeBridge(client, { onStats: (p) => posts.push(p), name: (host) => (host === '10.0.0.88' ? 'Streaming PC' : '') });
    if (connect) await made.bridge.connect();
    /** Run the one live stats timer (an older one is stale and does nothing). */
    const fire = async () => {
        const t = made.timers[made.timers.length - 1];
        await t.fn();
        return t.ms;
    };
    return { ...made, client, posts, fire };
}

test('WATCH_STATS posts a sample at once, then every 2 s until the lease ends', async () => {
    const { bridge, posts, fire, tick, timers } = await statsBridge();
    await bridge.execute(watch(60));
    assert.equal(timers[timers.length - 1].ms, 0);
    await fire();
    assert.equal(posts.length, 1);
    for (let i = 0; i < 29; i += 1) {
        assert.equal(timers[timers.length - 1].ms, 2000);
        tick(2000);
        await fire();
    }
    assert.equal(posts.length, 30); // 0 s … 58 s
    tick(2000); // 60 s: the lease is over
    const before = timers.length;
    await fire();
    assert.equal(posts.length, 30);
    assert.equal(timers.length, before, 'nothing more is scheduled');
    assert.equal(bridge.watched, false);
});

test('a renewal extends the lease without a second stream of posts, capped at 2 minutes', async () => {
    const { bridge, fire, tick, timers } = await statsBridge();
    await bridge.execute(watch(60));
    await fire();
    tick(45000);
    const scheduled = timers.length;
    await bridge.execute(watch(60));
    assert.equal(timers.length, scheduled, 'a renewal schedules nothing new');
    assert.equal(bridge.leaseUntil, 1_000_000 + 45000 + 60000);
    await bridge.execute(watch(9999));
    assert.equal(bridge.leaseUntil, 1_000_000 + 45000 + 120000);
    await bridge.execute(watch('nonsense'));
    assert.equal(bridge.leaseUntil, 1_000_000 + 45000 + 120000, 'never shortened');
});

test('a sample has the API\'s shape, each drop counter from its own source', async () => {
    const { bridge, posts, fire } = await statsBridge();
    bridge.stream = { state: 'live', startedAt: 1 };
    await bridge.execute(watch(60));
    await fire();
    assert.deepEqual(posts[0], {
        connected: true, host: '10.0.0.88', name: 'Streaming PC', sampledAt: 1_000_000,
        stream: { state: 'live', uptimeMs: 60000 },
        bitrateKbps: null, // one sample: no rate yet
        fps: 59.94, activeFps: 59.94, cpu: 12.3, memoryMb: 812.4, diskFreeMb: 402114, congestion: 0.012,
        dropped: { network: { skipped: 3, total: 3600 }, encoder: { skipped: 1, total: 3600 }, render: { skipped: 2, total: 3700 } },
    });
});

test('bitrate is the change in outputBytes over the time between samples, and restarts when the count goes down', async () => {
    const { bridge, client, posts, fire, tick } = await statsBridge();
    await bridge.execute(watch(60));
    client.responses.GetStreamStatus.outputBytes = 1_000_000;
    await fire();
    tick(2000);
    client.responses.GetStreamStatus.outputBytes = 2_500_000; // 1.5 MB in 2 s = 6000 kbit/s
    await fire();
    tick(2000);
    client.responses.GetStreamStatus.outputBytes = 100; // a new stream
    await fire();
    tick(2000);
    client.responses.GetStreamStatus.outputBytes = 750_100; // 0.75 MB in 2 s
    await fire();
    tick(2000);
    client.responses.GetStreamStatus.outputActive = false;
    await fire();
    assert.deepEqual(posts.map((p) => p.bitrateKbps), [null, 6000, null, 3000, 0]);
    assert.deepEqual(posts[4].stream, { state: 'off', uptimeMs: 0 });
});

test('while watched, OBS dropping posts connected: false at once, and reconnecting posts again', async () => {
    const { bridge, client, posts, fire, tick, timers } = await statsBridge();
    await bridge.execute(watch(60));
    await fire();
    tick(1500);
    client.emit('ConnectionClosed'); // also schedules the reconnect, the timer before the stats one
    const statsTimer = timers.findLast((t) => t.ms === 0);
    await statsTimer.fn();
    assert.deepEqual(posts[1], { connected: false, host: '10.0.0.88', name: 'Streaming PC', sampledAt: 1_001_500 });
    tick(1000);
    await bridge.connect();
    await fire();
    assert.equal(posts.length, 3);
    assert.equal(posts[2].connected, true);
});

test('a state change within a second of the last post waits for the API\'s floor', async () => {
    const { bridge, posts, fire, tick, timers } = await statsBridge();
    await bridge.execute(watch(60));
    await fire();
    tick(300);
    bridge.applyStreamState('OBS_WEBSOCKET_OUTPUT_STOPPING');
    assert.equal(timers[timers.length - 1].ms, 900, '1.2 s after the last post finished');
    tick(900);
    await fire();
    assert.equal(posts.length, 2);
    assert.equal(posts[1].stream.state, 'stopping');
    assert.equal(timers[timers.length - 1].ms, 2000, 'then back to every 2 s');
    tick(10);
    bridge.applyStreamState('OBS_WEBSOCKET_OUTPUT_STOPPING');
    assert.equal(timers[timers.length - 1].ms, 2000, 'the same state again is not a change');
});

test('a watch with OBS not connected posts connected: false and nothing else', async () => {
    const { bridge, posts, fire, client } = await statsBridge({ connect: false });
    bridge.url = 'ws://10.0.0.88:4455';
    bridge.wanted = true; // set up, still retrying
    await bridge.execute(watch(60));
    await fire();
    assert.deepEqual(posts, [{ connected: false, host: '10.0.0.88', name: 'Streaming PC', sampledAt: 1_000_000 }]);
    assert.deepEqual(client.calls, []);
});

test('no watch, no stats: state changes and connects post nothing', async () => {
    const { bridge, posts, timers } = await statsBridge();
    const scheduled = timers.length;
    bridge.applyStreamState('OBS_WEBSOCKET_OUTPUT_STARTED');
    assert.equal(timers.length, scheduled);
    assert.equal(posts.length, 0);
});

test('WATCH_STATS is never logged and never reaches OBS as an action', async () => {
    const logs = [];
    const { bridge, client } = await statsBridge();
    bridge.onLog = (l) => logs.push(l);
    const before = client.calls.length;
    await bridge.execute(watch(60));
    assert.deepEqual(logs, []);
    assert.equal(client.calls.length, before);
});

test('a desktop with no OBS set up ignores WATCH_STATS (the app on a second PC stays silent)', async () => {
    const { bridge, posts, timers } = await statsBridge({ connect: false });
    await bridge.execute(watch(60));
    assert.equal(timers.length, 0);
    assert.equal(bridge.watched, false);
    assert.equal(posts.length, 0);
});

test('a failed GetStreamStatus keeps the stream state and the bitrate baseline', async () => {
    const { bridge, client, posts, fire, tick } = await statsBridge();
    bridge.applyStreamState('OBS_WEBSOCKET_OUTPUT_STARTED');
    await bridge.execute(watch(60));
    client.responses.GetStreamStatus.outputBytes = 1_000_000;
    await fire();
    tick(2000);
    const ok = client.responses.GetStreamStatus;
    client.responses.GetStreamStatus = new Error('busy');
    await fire();
    assert.deepEqual(posts[1].stream, { state: 'live', uptimeMs: null });
    assert.equal(posts[1].bitrateKbps, null);
    assert.equal(posts[1].congestion, null);
    assert.equal(posts[1].dropped.network, null);
    tick(2000);
    client.responses.GetStreamStatus = { ...ok, outputBytes: 4_000_000 }; // 3 MB over the 4 s since the last read
    await fire();
    assert.equal(posts[2].bitrateKbps, 6000);
});

test('a sample that throws or a post that fails does not end the watch', async () => {
    const { bridge, fire, timers, tick } = await statsBridge();
    let calls = 0;
    bridge.onStats = () => { calls += 1; return Promise.reject(new Error('offline')); };
    await bridge.execute(watch(60));
    await fire();
    assert.equal(timers[timers.length - 1].ms, 2000);
    bridge.name = () => { throw new Error('settings unreadable'); };
    tick(2000);
    await fire();
    assert.equal(timers[timers.length - 1].ms, 2000, 'still scheduled');
    assert.equal(calls, 1);
});

test('a change while a sample is in flight is sent as soon as that one finishes', async () => {
    const { bridge, posts, fire, timers, tick } = await statsBridge();
    let release;
    bridge.onStats = (p) => { posts.push(p); return posts.length === 1 ? new Promise((r) => { release = r; }) : undefined; };
    await bridge.execute(watch(60));
    const first = fire();
    await new Promise((r) => setImmediate(r));
    bridge.applyStreamState('OBS_WEBSOCKET_OUTPUT_STARTED');
    await timers.filter((t) => t.ms !== 3000).at(-1).fn(); // the change's tick finds a sample in flight
    tick(100);
    release();
    await first;
    assert.equal(timers[timers.length - 1].ms, 1200, 'again at once, held only by the floor');
    await fire();
    assert.equal(posts.length, 2);
    assert.equal(posts[1].stream.state, 'live');
});

test('switching OBS reads the frame rate of the new one', async () => {
    const { bridge, client, posts, fire, tick } = await statsBridge();
    await bridge.execute(watch(60));
    await fire();
    assert.equal(posts[0].fps, 59.94);
    client.responses.GetVideoSettings = { fpsNumerator: 30, fpsDenominator: 1 };
    client.emit('ConnectionClosed');
    await bridge.connect();
    tick(2000);
    await fire();
    assert.equal(posts[posts.length - 1].fps, 30);
});

test('a desktop whose OBS refused the password still answers WATCH_STATS, with connected false', async () => {
    const client = new FakeClient([badPassword]);
    const posts = [];
    const { bridge, timers } = makeBridge(client, { onStats: (p) => posts.push(p) });
    await bridge.connect();
    assert.equal(bridge.passwordProblem, true);
    await bridge.execute(watch(60));
    await timers[timers.length - 1].fn();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].connected, false);
    assert.equal(posts[0].host, '10.0.0.88');
});

test('a stalled OBS request counts as failed, so the sample still goes out', async () => {
    const { bridge, client, posts, timers } = await statsBridge();
    await bridge.execute(watch(60));
    const call = client.call.bind(client);
    client.call = (name) => (name === 'GetStats' ? new Promise(() => {}) : call(name));
    const tickTimer = timers[timers.length - 1];
    const running = tickTimer.fn();
    await new Promise((resolve) => setImmediate(resolve));
    const stall = timers.find((t) => t.ms === 3000);
    assert.ok(stall, 'a 3 s limit is set on each OBS request');
    stall.fn();
    await running;
    assert.equal(posts.length, 1);
    assert.equal(posts[0].cpu, null);
    assert.equal(posts[0].stream.state, 'live');
});

test('a failed GetStreamStatus while off sends uptime 0, not null', async () => {
    const { bridge, client, posts, fire } = await statsBridge({ stream: { outputActive: false } });
    bridge.stream = { state: 'off', startedAt: null };
    client.responses.GetStreamStatus = new Error('busy');
    await bridge.execute(watch(60));
    await fire();
    assert.deepEqual(posts[0].stream, { state: 'off', uptimeMs: 0 });
});
