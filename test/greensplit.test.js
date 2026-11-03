'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const gs = require('../src/main/greensplit');
const { routeDeviceCommand } = require('../src/main/devicecontrol');

/*
 * The fixture is a trimmed real GreenSplit 0.3.4 session, one message per line, in order: hello, snapshot,
 * subscribed, then three runs — a PB with golds on every split, a run with a silver split + a skip + a reset, and a
 * slower run (bronze, silver, then a gold last segment) that finishes behind.
 */
const SESSION = fs.readFileSync(path.join(__dirname, 'fixtures', 'greensplit-session.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));

const replay = (messages) => {
    const tracker = new gs.RunTracker();
    return { tracker, posts: messages.flatMap((message) => tracker.handle(message)) };
};

const COMMON = { game: 'Test Game', category: 'Any%', comparison: 'Personal Best' };
const clone = (value) => JSON.parse(JSON.stringify(value));

// ------------------------------------------------------------------ Connection URL

test('a Connection URL splits into the address (kept in settings) and the token (a secret)', () => {
    assert.deepEqual(gs.parseConnectionUrl('  ws://127.0.0.1:16835/v1/events?token=testtoken123 '), {
        ok: true, url: 'ws://127.0.0.1:16835/v1/events', token: 'testtoken123',
    });
    assert.deepEqual(gs.parseConnectionUrl('wss://192.168.1.20:16835/v1/events?token=a%2Bb&x=1'), {
        ok: true, url: 'wss://192.168.1.20:16835/v1/events?x=1', token: 'a+b',
    });
    assert.equal(
        gs.buildConnectionUrl('ws://127.0.0.1:16835/v1/events', 'testtoken123'),
        'ws://127.0.0.1:16835/v1/events?token=testtoken123',
    );
});

test('a pasted URL that cannot work says why, in plain words', () => {
    for (const bad of ['', '   ', null, 'not a url', 'http://127.0.0.1:16835/v1/events?token=x',
        'ws://127.0.0.1:16835/v1/events', 'ws://127.0.0.1:16835/v1/events?token=']) {
        const result = gs.parseConnectionUrl(bad);
        assert.equal(result.ok, false, String(bad));
        assert.match(result.error, /Connection URL/);
    }
    assert.match(gs.parseConnectionUrl('ws://127.0.0.1:16835/v1/events').error, /no access token/);
    assert.match(gs.parseConnectionUrl('http://x/?token=a').error, /starts with ws:\/\//);
});

test('the LiveSplit adapter shares the event server host; a bad port falls back to 16834', () => {
    assert.equal(gs.livesplitHost('ws://192.168.1.20:16835/v1/events'), '192.168.1.20');
    assert.equal(gs.livesplitHost('ws://[::1]:16835/v1/events'), '::1');
    assert.equal(gs.livesplitHost(''), '127.0.0.1');
    assert.equal(gs.livesplitPort(17000), 17000);
    assert.equal(gs.livesplitPort('17000'), 17000);
    for (const bad of [undefined, '', 0, 70000, 'abc', 1.5]) {
        assert.equal(gs.livesplitPort(bad), gs.DEFAULT_LIVESPLIT_PORT);
    }
});

// ------------------------------------------------------------------ event mapping, replayed

test('the recorded session posts exactly these triggers, in this order', () => {
    const { posts } = replay(SESSION);
    assert.deepEqual(posts.map((p) => `${p.eventType.replace('GREENSPLIT_', '')}:${p.attempt}`), [
        // Run 1 — attempt 2: golds everywhere, ahead from the first split, a PB at the finish.
        'RUN_STARTED:2', 'SPLIT:2', 'GOLD:2', 'PACE_AHEAD:2', 'SPLIT:2', 'GOLD:2',
        'RUN_FINISHED:2', 'GOLD:2', 'PERSONAL_BEST:2', 'RESET:2',
        // Run 2 — attempt 3: behind live before the first split, a silver split (no repeat), a skip, a reset.
        'RUN_STARTED:3', 'PACE_BEHIND:3', 'SPLIT:3', 'SPLIT_SKIPPED:3', 'RESET:3',
        // Run 3 — attempt 4: behind live, bronze and silver splits, a gold last segment, a finish behind PB.
        'RUN_STARTED:4', 'PACE_BEHIND:4', 'SPLIT:4', 'SPLIT:4', 'RUN_FINISHED:4', 'GOLD:4', 'RESET:4',
    ]);
    // Every post carries the run's identity.
    posts.forEach((post) => assert.deepEqual(
        { game: post.game, category: post.category, comparison: post.comparison }, COMMON,
    ));
});

test('a gold split posts SPLIT then GOLD with the split\'s full fields', () => {
    const posts = replay(SESSION.slice(0, 11)).posts; // through run 1's first split
    const split = {
        ...COMMON,
        attempt: 2,
        splitName: 'Forest',
        splitNumber: 1,
        totalSplits: 3,
        nextSplitName: 'Castle',
        splitTimeNs: 2606462425,
        segmentTimeNs: 2606462425,
        deltaNs: -7393537575,
        segmentDeltaNs: -7393537575,
        medal: 'gold',
    };
    assert.deepEqual(posts.slice(1), [
        { eventType: 'GREENSPLIT_SPLIT', ...split },
        { eventType: 'GREENSPLIT_GOLD', ...split },
        {
            eventType: 'GREENSPLIT_PACE_AHEAD', ...COMMON, attempt: 2,
            splitName: 'Forest', splitNumber: 1, totalSplits: 3, deltaNs: -7393537575, live: false,
        },
    ]);
});

test('the finish posts RUN_FINISHED, GOLD, then PERSONAL_BEST against the PB it beat', () => {
    const { posts } = replay(SESSION);
    const finish = posts.findIndex((p) => p.eventType === 'GREENSPLIT_RUN_FINISHED');
    assert.deepEqual(posts[finish], {
        eventType: 'GREENSPLIT_RUN_FINISHED', ...COMMON, attempt: 2,
        splitName: 'Dragon', totalSplits: 3, finalTimeNs: 8827796134, deltaNs: -21172203866,
        personalBest: true, medal: 'gold',
    });
    // The final segment's gold: a split's fields, but no "next" split after the last one.
    assert.equal(posts[finish + 1].eventType, 'GREENSPLIT_GOLD');
    assert.equal(posts[finish + 1].splitName, 'Dragon');
    assert.equal(posts[finish + 1].splitNumber, 3);
    assert.equal(posts[finish + 1].segmentTimeNs, 2611438564);
    assert.equal('nextSplitName' in posts[finish + 1], false);
    assert.deepEqual(posts[finish + 2], {
        eventType: 'GREENSPLIT_PERSONAL_BEST', ...COMMON, attempt: 2,
        finalTimeNs: 8827796134, previousBestNs: 30000000000,
    });
    // Exactly one PB: GreenSplit's own personal_best event at the reset is not forwarded, and run 3 was no PB.
    assert.equal(posts.filter((p) => p.eventType === 'GREENSPLIT_PERSONAL_BEST').length, 1);
    const slowFinish = posts.filter((p) => p.eventType === 'GREENSPLIT_RUN_FINISHED')[1];
    assert.equal(slowFinish.personalBest, false);
    assert.equal(slowFinish.deltaNs, 1602344666);
});

test('a first-ever completion is a PB with no previous best to compare', () => {
    const finished = clone(SESSION[24]);
    finished.run.segments.forEach((segment) => { delete segment.personal_best; });
    const pb = gs.mapEvent(finished).find((p) => p.eventType === 'GREENSPLIT_PERSONAL_BEST');
    assert.deepEqual(pb, { eventType: 'GREENSPLIT_PERSONAL_BEST', ...COMMON, attempt: 2, finalTimeNs: 8827796134 });
});

test('skip, reset mid-run and reset after a finish name the right split', () => {
    const { posts } = replay(SESSION);
    assert.deepEqual(posts.find((p) => p.eventType === 'GREENSPLIT_SPLIT_SKIPPED'), {
        eventType: 'GREENSPLIT_SPLIT_SKIPPED', ...COMMON, attempt: 3,
        splitName: 'Castle', splitNumber: 2, totalSplits: 3, nextSplitName: 'Dragon',
    });
    const resets = posts.filter((p) => p.eventType === 'GREENSPLIT_RESET');
    assert.deepEqual(resets[1], {
        eventType: 'GREENSPLIT_RESET', ...COMMON, attempt: 3,
        splitName: 'Dragon', splitNumber: 3, totalSplits: 3, splitsCompleted: 2, completed: false, timeNs: 6324058555,
    });
    assert.deepEqual(resets[0], {
        eventType: 'GREENSPLIT_RESET', ...COMMON, attempt: 2,
        splitName: 'Dragon', splitNumber: 3, totalSplits: 3, splitsCompleted: 3, completed: true, timeNs: 8827880509,
    });
});

test('pause, resume, undo and comparison change carry the segment the timer is on', () => {
    const at = clone(SESSION[18]); // run 1, on Castle (index 1)
    const message = (name, event = {}) => ({ ...at, name, event });
    assert.deepEqual(gs.mapEvent(message('paused')), [{
        eventType: 'GREENSPLIT_PAUSED', ...COMMON, attempt: 2,
        splitName: 'Dragon', splitNumber: 3, totalSplits: 3, timeNs: 6216552987,
    }]);
    assert.equal(gs.mapEvent(message('resumed'))[0].eventType, 'GREENSPLIT_RESUMED');
    const undone = clone(at);
    undone.timer.current_segment_index = 1;
    assert.deepEqual(gs.mapEvent({ ...undone, name: 'split_undone', event: {} }), [{
        eventType: 'GREENSPLIT_SPLIT_UNDONE', ...COMMON, attempt: 2, splitName: 'Castle', splitNumber: 2, totalSplits: 3,
    }]);
    assert.deepEqual(gs.mapEvent(message('comparison_changed', { comparison: 'Best Segments' })), [{
        eventType: 'GREENSPLIT_COMPARISON_CHANGED', ...COMMON, comparison: 'Best Segments', attempt: 2,
    }]);
    for (const name of ['run_saved', 'attempt_committed', 'run_changed', 'personal_best']) {
        assert.deepEqual(gs.mapEvent(message(name)), [], name);
    }
});

test('a split with no comparison time leaves out the delta and medal it does not have', () => {
    const split = clone(SESSION[10]);
    for (const key of ['delta_ns', 'segment_delta_ns', 'comparison_split_time_ns', 'comparison_segment_time_ns']) {
        delete split.event[key];
    }
    split.event.medal = null;
    split.event.is_gold = false;
    const posts = gs.mapEvent(split);
    assert.equal(posts.length, 1);
    assert.equal('deltaNs' in posts[0], false);
    assert.equal('medal' in posts[0], false);
});

// ------------------------------------------------------------------ the pace machine

test('live behind fires mid-segment the moment the running time passes the comparison split', () => {
    const { posts } = replay(SESSION);
    const live = posts.filter((p) => p.live === true);
    assert.deepEqual(live[0], {
        eventType: 'GREENSPLIT_PACE_BEHIND', ...COMMON, attempt: 3,
        splitName: 'Forest', splitNumber: 1, totalSplits: 3,
        // 2 853 257 697 (the first tick past it) − 2 606 462 425 (the new PB's Forest split, ~2.6 s)
        deltaNs: 246795272, live: true,
    });
    // The tick before it (2.35 s) was not past the comparison, so nothing fired early.
    const run2 = replay(SESSION.slice(0, 42)).posts;
    assert.equal(run2.filter((p) => p.eventType === 'GREENSPLIT_PACE_BEHIND').length, 0);
    assert.equal(live.length, 2);
    assert.equal(live[1].attempt, 4);
});

test('no double fire: a behind split after a live behind, or another ahead split, says nothing', () => {
    const { posts } = replay(SESSION);
    // Run 1 has two ahead splits and an ahead finish; one PACE_AHEAD. Runs 2 and 3 split behind after live behind.
    assert.equal(posts.filter((p) => p.eventType === 'GREENSPLIT_PACE_AHEAD').length, 1);
    assert.equal(posts.filter((p) => p.eventType === 'GREENSPLIT_PACE_BEHIND').length, 2);
});

test('reset, a new run and a comparison change clear the pace', () => {
    const tracker = new gs.RunTracker();
    SESSION.slice(0, 11).forEach((m) => tracker.handle(m));
    assert.equal(tracker.pace, 'ahead');
    const changed = { ...clone(SESSION[18]), name: 'comparison_changed', event: { comparison: 'Best Segments' } };
    changed.run.current_comparison = 'Best Segments';
    tracker.handle(changed);
    assert.equal(tracker.pace, null);
    // So the next ahead split announces it again.
    assert.equal(tracker.handle(SESSION[18]).some((p) => p.eventType === 'GREENSPLIT_PACE_AHEAD'), true);
    tracker.handle(SESSION[27]); // reset
    assert.equal(tracker.pace, null);
});

test('a comparison "changed" to the one already showing is not a change (GreenSplit sends it anyway)', () => {
    const tracker = new gs.RunTracker();
    SESSION.slice(0, 11).forEach((m) => tracker.handle(m));
    const same = { ...clone(SESSION[18]), name: 'comparison_changed', event: { comparison: 'Personal Best' } };
    assert.deepEqual(tracker.handle(same), []);
    assert.equal(tracker.pace, 'ahead');
    const other = clone(same);
    other.event.comparison = 'Best Segments';
    other.run.current_comparison = 'Best Segments';
    assert.deepEqual(tracker.handle(other).map((p) => p.comparison), ['Best Segments']);
    assert.equal(tracker.pace, null);
});

test('an undo re-derives the pace from the splits that remain, without firing', () => {
    const tracker = new gs.RunTracker();
    SESSION.slice(0, 19).forEach((m) => tracker.handle(m)); // run 1, Forest and Castle split ahead
    // A third, behind split on Dragon flips to behind…
    const behind = clone(SESSION[18]);
    Object.assign(behind.event, {
        completed_route_index: 2, completed_segment: { name: 'Dragon', route_index: 2 }, delta_ns: 500, is_gold: false,
    });
    assert.deepEqual(tracker.handle(behind).map((p) => p.eventType), ['GREENSPLIT_SPLIT', 'GREENSPLIT_PACE_BEHIND']);
    // …and undoing it goes back to ahead, from Castle's split, quietly.
    const undo = { ...clone(SESSION[18]), name: 'split_undone', event: {} };
    undo.timer.current_segment_index = 2;
    assert.deepEqual(tracker.handle(undo).map((p) => p.eventType), ['GREENSPLIT_SPLIT_UNDONE']);
    assert.equal(tracker.pace, 'ahead');
    // Undoing back past every split leaves no pace at all.
    const undoAll = { ...clone(SESSION[10]), name: 'split_undone', event: {} };
    Object.assign(undoAll.timer, { current_segment_index: 0, split_times_ns: [null, null, null], real_time_ns: 3e9 });
    tracker.handle(undoAll);
    assert.equal(tracker.pace, null);
});

test('undoing a split while live behind stays behind, so the next tick does not announce it twice', () => {
    const tracker = new gs.RunTracker();
    SESSION.slice(0, 45).forEach((m) => tracker.handle(m)); // run 2: live behind, then Forest split behind
    assert.equal(tracker.pace, 'behind');
    const undo = { ...clone(SESSION[44]), name: 'split_undone', event: {} };
    Object.assign(undo.timer, { current_segment_index: 0, split_times_ns: [null, null, null], real_time_ns: 3700000000 });
    assert.deepEqual(tracker.handle(undo).map((p) => p.eventType), ['GREENSPLIT_SPLIT_UNDONE']);
    assert.equal(tracker.pace, 'behind');
    const tick = { type: 'timer_tick', timer: { phase: 'running', real_time_ns: 3900000000, current_segment_index: 0, current_comparison: 'Personal Best' } };
    assert.deepEqual(tracker.handle(tick), []);
});

test('connecting mid-run takes the pace from the snapshot without firing it', () => {
    const tracker = new gs.RunTracker();
    const snapshot = { ...clone(SESSION[18]), type: 'snapshot' };
    delete snapshot.name;
    delete snapshot.event;
    assert.deepEqual(tracker.handle(snapshot), []);
    assert.equal(tracker.pace, 'ahead');
    // Already ahead, so the next ahead split stays quiet.
    const next = tracker.handle(SESSION[24]);
    assert.equal(next.some((p) => p.eventType.startsWith('GREENSPLIT_PACE')), false);
});

test('ticks while paused, or with no comparison time for the segment, never fire', () => {
    const tracker = new gs.RunTracker();
    tracker.handle(SESSION[36]); // run 2 started, PB comparisons known
    const tick = (phase, index, ns) => tracker.handle({
        type: 'timer_tick', timer: { phase, real_time_ns: ns, current_segment_index: index, current_comparison: 'Personal Best' },
    });
    assert.deepEqual(tick('paused', 0, 9e9), []);
    assert.deepEqual(tick('running', 7, 9e9), []);
    assert.deepEqual(tick('running', 0, 1e9), []);
    assert.equal(tick('running', 0, 3e9)[0].eventType, 'GREENSPLIT_PACE_BEHIND');
});

// ------------------------------------------------------------------ actions -> LiveSplit commands

const RUN = SESSION[1].run; // comparisons: Personal Best … None; current Personal Best

test('every action type maps to its LiveSplit command', () => {
    const simple = {
        START_TIMER: 'starttimer', SPLIT: 'split', START_OR_SPLIT: 'startorsplit', UNDO_SPLIT: 'unsplit',
        SKIP_SPLIT: 'skipsplit', PAUSE: 'pause', RESUME: 'resume', RESET: 'reset',
    };
    Object.entries(simple).forEach(([type, command]) => assert.deepEqual(gs.planAction({ type }, RUN), { command }));
    assert.deepEqual(gs.planAction({ type: 'TOGGLE_PAUSE' }, RUN), { toggle: true });
    assert.deepEqual(gs.planAction({ type: 'SET_COMPARISON', comparison: 'Best Segments' }, RUN),
        { command: 'setcomparison Best Segments' });
    assert.deepEqual(gs.planAction({ type: 'NEXT_COMPARISON' }, RUN), { command: 'setcomparison Best Segments' });
    assert.deepEqual(gs.planAction({ type: 'PREVIOUS_COMPARISON' }, RUN), { command: 'setcomparison None' });
    assert.deepEqual(gs.planAction({ type: 'EXPLODE' }, RUN), { unknown: true });
    assert.deepEqual(gs.planAction({ type: 'toString' }, RUN), { unknown: true });
});

test('a comparison name cannot smuggle a second command onto the line', () => {
    assert.ok(gs.planAction({ type: 'SET_COMPARISON', comparison: 'PB\r\nreset' }, RUN).skip);
    assert.ok(gs.planAction({ type: 'SET_COMPARISON', comparison: 'PB\nreset' }, RUN).skip);
    assert.ok(gs.planAction({ type: 'SET_COMPARISON', comparison: '  ' }, RUN).skip);
    assert.ok(gs.planAction({ type: 'SET_COMPARISON', comparison: 42 }, RUN).skip);
    assert.ok(gs.planAction({ type: 'NEXT_COMPARISON' }, null).skip);
});

test('comparisons cycle from the current one and wrap both ways', () => {
    const run = { comparisons: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], current_comparison: 'C' };
    assert.equal(gs.cycleComparison(run, 1), 'A');
    assert.equal(gs.cycleComparison(run, -1), 'B');
    assert.equal(gs.cycleComparison({ ...run, current_comparison: 'A' }, -1), 'C');
    assert.equal(gs.cycleComparison({ ...run, current_comparison: 'gone' }, 1), 'A');
    assert.equal(gs.cycleComparison({ ...run, current_comparison: 'gone' }, -1), 'C');
    assert.equal(gs.cycleComparison({ comparisons: [] }, 1), null);
});

test('TOGGLE_PAUSE pauses a running timer, resumes a paused one, and leaves anything else alone', () => {
    assert.equal(gs.pauseCommandFor('Running'), 'pause');
    assert.equal(gs.pauseCommandFor('Paused'), 'resume');
    assert.equal(gs.pauseCommandFor('NotRunning'), null);
    assert.equal(gs.pauseCommandFor('Ended'), null);
});

test('the loop guard: a GreenSplit trigger never drives GreenSplit', () => {
    assert.equal(gs.isLoopedCommand({ triggerType: 'GREENSPLIT_SPLIT' }), true);
    assert.equal(gs.isLoopedCommand({ triggerType: 'GREENSPLIT_PERSONAL_BEST' }), true);
    assert.equal(gs.isLoopedCommand({ triggerType: 'CHEER' }), false);
    assert.equal(gs.isLoopedCommand({}), false);
});

// ------------------------------------------------------------------ routing

test('device commands route by target: none means OBS, greensplit means GreenSplit, anything else is dropped', () => {
    const calls = [];
    const logs = [];
    const bridges = {
        obs: { execute: (c) => calls.push(['obs', c.action]) },
        greensplit: { execute: (c) => calls.push(['greensplit', c.action]) },
        onLog: (line) => logs.push(line),
    };
    routeDeviceCommand({ action: '{"type":"SWITCH_SCENE"}' }, bridges);
    routeDeviceCommand({ target: 'obs', action: 'o' }, bridges);
    routeDeviceCommand({ target: 'greensplit', action: '{"type":"SPLIT"}' }, bridges);
    routeDeviceCommand({ target: 'toaster', action: 't' }, bridges);
    assert.deepEqual(calls, [['obs', '{"type":"SWITCH_SCENE"}'], ['obs', 'o'], ['greensplit', '{"type":"SPLIT"}']]);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /toaster/);
});

// ------------------------------------------------------------------ the bridge, against stubs

/** A stand-in for Node's WebSocket that the test drives by hand. */
class FakeWebSocket {
    constructor(url) {
        this.url = url;
        this.sent = [];
        this.closed = false;
        FakeWebSocket.instances.push(this);
    }

    send(data) { this.sent.push(JSON.parse(data)); }

    close() { this.closed = true; }

    open() { if (this.onopen) this.onopen(); }

    receive(message) { if (this.onmessage) this.onmessage({ data: JSON.stringify(message) }); }

    drop() { if (this.onclose) this.onclose({ code: 1006 }); }
}
FakeWebSocket.instances = [];

/** A LiveSplit Server Adapter stand-in: records every line, answers the phase, refuses unknown comparisons. */
async function stubAdapter(t, { phase = 'Running' } = {}) {
    const lines = [];
    const sockets = new Set();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        let buffer = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
            buffer += chunk;
            let end;
            while ((end = buffer.indexOf('\r\n')) !== -1) {
                const line = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                lines.push(line);
                if (line === 'getcurrenttimerphase') socket.write(`${server.phase}\r\n`);
                if (line.startsWith('setcomparison ') && line !== 'setcomparison Best Segments' && line !== 'setcomparison None') {
                    socket.write(`[Error]: System.Exception: There is no comparison called "${line.slice(14)}"\r\n`);
                }
            }
        });
    });
    server.phase = phase;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => {
        sockets.forEach((socket) => socket.destroy());
        server.close(resolve);
    }));
    return { server, lines, port: server.address().port };
}

/** A free port with nothing listening — the adapter switched off. */
async function closedPort() {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

function makeBridge(t, overrides = {}) {
    FakeWebSocket.instances = [];
    const settings = {
        greensplitUrl: 'ws://127.0.0.1:16835/v1/events',
        greensplitLivesplitPort: 1, // overridden per test; never the real adapter
        forwardGreensplitEvents: true,
        ...overrides.settings,
    };
    const logs = [];
    const posts = [];
    const statuses = [];
    const connected = [];
    const bridge = new gs.GreenSplitBridge({
        settings: () => settings,
        token: () => ('token' in overrides ? overrides.token : 'testtoken123'),
        onLog: (line) => logs.push(line),
        onStatus: (status) => statuses.push(status.state),
        onGreenSplitEvent: async (body) => { posts.push(body); },
        onConnected: (info) => connected.push(info),
        WebSocketImpl: FakeWebSocket,
        helloTimeoutMs: 30,
        retryMinMs: 20,
        controlProbeMs: 60000,
        settleMs: 40,
        ...overrides.options,
    });
    t.after(() => bridge.disconnect());
    return { bridge, settings, logs, posts, statuses, connected };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('hello: subscribes at 4 Hz, reports the version, and posts the session\'s triggers in order', async (t) => {
    const { port } = await stubAdapter(t);
    const { bridge, posts, statuses, connected } = makeBridge(t, { settings: { greensplitLivesplitPort: port } });
    assert.equal(bridge.connect(), true);
    const ws = FakeWebSocket.instances[0];
    assert.equal(ws.url, 'ws://127.0.0.1:16835/v1/events?token=testtoken123');
    ws.open();
    ws.receive({ type: 'hello', app_name: 'GreenSplit', app_version: '0.3.4', version: 1 });
    assert.deepEqual(ws.sent, [{ type: 'subscribe', timer_hz: 4 }]);
    assert.deepEqual(connected, [{ appVersion: '0.3.4' }]);
    assert.equal(bridge.connected, true);
    assert.deepEqual(statuses.slice(0, 2), ['connecting', 'connected']);
    SESSION.slice(1).forEach((message) => ws.receive(message));
    await bridge.outbox;
    assert.deepEqual(posts, replay(SESSION).posts);
    await wait(30);
    assert.equal(bridge.status.controlAvailable, true);
});

test('"Send GreenSplit events" off: nothing is posted, but the pace is still followed', async (t) => {
    const { bridge, settings, posts } = makeBridge(t, { settings: { greensplitLivesplitPort: await closedPort() } });
    settings.forwardGreensplitEvents = false;
    bridge.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: 'hello', app_version: '0.3.4' });
    SESSION.slice(1, 12).forEach((message) => ws.receive(message));
    await bridge.outbox;
    assert.deepEqual(posts, []);
    assert.equal(bridge.tracker.pace, 'ahead');
});

test('an open socket with no hello is a wrong token: said so, and not retried', async (t) => {
    const { bridge, statuses, logs } = makeBridge(t);
    bridge.connect();
    FakeWebSocket.instances[0].open();
    await wait(80);
    assert.equal(bridge.state, 'bad-token');
    assert.equal(statuses.at(-1), 'bad-token');
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(logs.filter((l) => /access token/.test(l)).length, 1);
});

test('GreenSplit not running: "isn\'t running", retried with backoff, and logged once', async (t) => {
    const { bridge, logs } = makeBridge(t);
    bridge.connect();
    FakeWebSocket.instances[0].drop();
    assert.equal(bridge.state, 'unreachable');
    await wait(35); // first retry after 20 ms, then 40, then 80
    FakeWebSocket.instances[1].drop();
    await wait(60);
    FakeWebSocket.instances[2].drop();
    assert.ok(FakeWebSocket.instances.length >= 3);
    assert.equal(logs.filter((l) => /Waiting for GreenSplit/.test(l)).length, 1);
    // It opens at last.
    await wait(120);
    const latest = FakeWebSocket.instances.at(-1);
    latest.open();
    latest.receive({ type: 'hello', app_version: '0.3.4' });
    assert.equal(bridge.state, 'connected');
    bridge.disconnect();
    assert.equal(bridge.state, 'off');
    const count = FakeWebSocket.instances.length;
    await wait(60);
    assert.equal(FakeWebSocket.instances.length, count, 'no retry once turned off');
});

test('not set up: connect refuses and stays off', (t) => {
    const { bridge } = makeBridge(t, { token: null });
    assert.equal(bridge.configured(), false);
    assert.equal(bridge.connect(), false);
    assert.equal(bridge.state, 'off');
    assert.equal(FakeWebSocket.instances.length, 0);
});

/** A bridge that is on (as after Connect) with the fixture's run known, over a stub adapter. */
async function controlBridge(t, adapterOptions) {
    const adapter = await stubAdapter(t, adapterOptions);
    const made = makeBridge(t, { settings: { greensplitLivesplitPort: adapter.port } });
    made.bridge.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: 'hello', app_version: '0.3.4' });
    ws.receive(SESSION[1]); // the snapshot: comparisons to cycle through
    return { ...made, adapter };
}

const command = (action, triggerType = 'CHANNEL_POINTS') => ({
    eventId: 'e1', target: 'greensplit', action: JSON.stringify(action), triggerType, overlayType: 'X', overlayId: 1,
});

test('execute sends each action as its LiveSplit line', async (t) => {
    const { bridge, adapter } = await controlBridge(t);
    for (const type of ['START_TIMER', 'SPLIT', 'START_OR_SPLIT', 'UNDO_SPLIT', 'SKIP_SPLIT', 'PAUSE', 'RESUME', 'RESET']) {
        await bridge.execute(command({ type }));
    }
    await bridge.execute(command({ type: 'SET_COMPARISON', comparison: 'Best Segments' }));
    await bridge.execute(command({ type: 'NEXT_COMPARISON' }));
    await bridge.execute(command({ type: 'PREVIOUS_COMPARISON' }));
    assert.deepEqual(adapter.lines, [
        'starttimer', 'split', 'startorsplit', 'unsplit', 'skipsplit', 'pause', 'resume', 'reset',
        'setcomparison Best Segments', 'setcomparison Best Segments', 'setcomparison None',
    ]);
});

test('TOGGLE_PAUSE asks the phase first, over the stub adapter', async (t) => {
    const { bridge, adapter, logs } = await controlBridge(t);
    await bridge.execute(command({ type: 'TOGGLE_PAUSE' }));
    adapter.server.phase = 'Paused';
    await bridge.execute(command({ type: 'TOGGLE_PAUSE' }));
    adapter.server.phase = 'NotRunning';
    await bridge.execute(command({ type: 'TOGGLE_PAUSE' }));
    assert.deepEqual(adapter.lines, [
        'getcurrenttimerphase', 'pause', 'getcurrenttimerphase', 'resume', 'getcurrenttimerphase',
    ]);
    assert.ok(logs.some((l) => /nothing to pause or resume \(the timer is NotRunning\)/.test(l)));
});

test('the loop guard holds in execute: a GREENSPLIT_ trigger sends nothing', async (t) => {
    const { bridge, adapter, logs } = await controlBridge(t);
    await bridge.execute(command({ type: 'SPLIT' }, 'GREENSPLIT_SPLIT'));
    await bridge.execute(command({ type: 'RESET' }, 'GREENSPLIT_PACE_BEHIND'));
    await wait(30);
    assert.deepEqual(adapter.lines, []);
    assert.equal(logs.filter((l) => /never drive GreenSplit/.test(l)).length, 2);
});

test('GreenSplit\'s refusal is logged in its words; unknown and unreadable actions are ignored', async (t) => {
    const { bridge, adapter, logs } = await controlBridge(t);
    await bridge.execute(command({ type: 'SET_COMPARISON', comparison: 'Nope' }));
    await bridge.execute(command({ type: 'SPLIT' }));
    await bridge.execute(command({ type: 'EXPLODE' }));
    await bridge.execute({ target: 'greensplit', action: '{not json', triggerType: 'CHEER' });
    assert.deepEqual(adapter.lines, ['setcomparison Nope', 'split']);
    assert.ok(logs.some((l) => l === 'GreenSplit action SET_COMPARISON failed: There is no comparison called "Nope"'));
    assert.ok(logs.includes('GreenSplit: SPLIT'), 'the next command is not blamed for the error');
    assert.ok(logs.some((l) => /Unknown GreenSplit action type "EXPLODE"/.test(l)));
    assert.ok(logs.some((l) => /unreadable GreenSplit action/.test(l)));
});

test('adapter off: control is reported unavailable and the action is logged, not thrown', async (t) => {
    const { bridge, logs } = makeBridge(t, { settings: { greensplitLivesplitPort: await closedPort() } });
    bridge.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: 'hello', app_version: '0.3.4' });
    await wait(50);
    assert.equal(bridge.status.controlAvailable, false);
    assert.ok(logs.some((l) => /until its LiveSplit Server Adapter is on/.test(l)));
    await bridge.execute(command({ type: 'SPLIT' }));
    assert.ok(logs.some((l) => /Could not run GreenSplit SPLIT/.test(l)));
});

test('turned off in the app: actions are ignored', async (t) => {
    const { bridge, adapter, logs } = await controlBridge(t);
    bridge.disconnect();
    await bridge.execute(command({ type: 'SPLIT' }));
    await wait(30);
    assert.deepEqual(adapter.lines, []);
    assert.ok(logs.some((l) => /not connected in this app/.test(l)));
});
