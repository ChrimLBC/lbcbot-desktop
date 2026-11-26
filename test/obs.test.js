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

function makeBridge(client, { password = 'pw', settings = {} } = {}) {
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
