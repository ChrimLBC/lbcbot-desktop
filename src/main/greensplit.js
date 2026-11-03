'use strict';

const net = require('node:net');

/**
 * The GreenSplit bridge — speedrun timer events into LBCBot, and LBCBot actions back into the timer.
 *
 * GreenSplit (greensplit.net) is a desktop speedrun timer that runs on the streamer's PC, like OBS, and ships two local
 * servers, both off until the user turns them on in GreenSplit's menus:
 *  - the WebSocket event server (read only): `ws://127.0.0.1:16835/v1/events?token=…`, which pushes every timer event
 *    with a full snapshot of the run after it, plus timer ticks at the rate we subscribe to;
 *  - the LiveSplit Server Adapter (control): plain TCP on 16834, one `command\r\n` line per action, no auth.
 *
 * Both directions live in this file, as they do for OBS in obs.js:
 *  - GreenSplit -> LBCBot: events become `GREENSPLIT_*` triggers, posted to `POST /api/users/greensplit/event`.
 *  - LBCBot -> GreenSplit: the `greensplitAction` attached to a trigger is executed over the adapter.
 *
 * Plain Node on purpose — no `electron` import. Settings and the access token are handed in, so the whole bridge, the
 * event mapping and the pace tracker run under `node --test` against a recorded session and a stub adapter.
 */

const DEFAULT_LIVESPLIT_PORT = 16834;
/** Ticks only feed the live "fell behind" check, and a quarter second is well inside what a viewer would notice. */
const TIMER_HZ = 4;
/**
 * A wrong (or missing) token is silent: GreenSplit opens the socket and then never sends anything — not even an answer
 * to a close. The right token gets `hello` within milliseconds, so a few seconds of silence means the token.
 */
const HELLO_TIMEOUT_MS = 5000;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 30000;
/** While connected but unable to control the timer, how often to look for the adapter being switched on. */
const CONTROL_PROBE_MS = 15000;

/** The trigger types, exactly as the API's enum spells them. */
const T = {
    RUN_STARTED: 'GREENSPLIT_RUN_STARTED',
    SPLIT: 'GREENSPLIT_SPLIT',
    GOLD: 'GREENSPLIT_GOLD',
    PACE_AHEAD: 'GREENSPLIT_PACE_AHEAD',
    PACE_BEHIND: 'GREENSPLIT_PACE_BEHIND',
    SPLIT_UNDONE: 'GREENSPLIT_SPLIT_UNDONE',
    SPLIT_SKIPPED: 'GREENSPLIT_SPLIT_SKIPPED',
    PAUSED: 'GREENSPLIT_PAUSED',
    RESUMED: 'GREENSPLIT_RESUMED',
    RUN_FINISHED: 'GREENSPLIT_RUN_FINISHED',
    PERSONAL_BEST: 'GREENSPLIT_PERSONAL_BEST',
    RESET: 'GREENSPLIT_RESET',
    COMPARISON_CHANGED: 'GREENSPLIT_COMPARISON_CHANGED',
};

// ------------------------------------------------------------------ the Connection URL

/**
 * Split the Connection URL GreenSplit copies (`ws://host:port/v1/events?token=…`) into the address, which is kept in
 * settings, and the access token, which is a secret like the OBS password and never written to settings.json.
 *
 * Errors are written for someone who only ever pressed "Copy Connection URL" — every one says to do exactly that.
 */
function parseConnectionUrl(text) {
    const value = String(text == null ? '' : text).trim();
    if (!value) {
        return { ok: false, error: 'Paste the Connection URL from GreenSplit.' };
    }
    let url;
    try {
        url = new URL(value);
    } catch (error) {
        return { ok: false, error: 'That isn\'t a Connection URL. In GreenSplit, use Copy Connection URL.' };
    }
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        return { ok: false, error: 'A Connection URL starts with ws:// — in GreenSplit, use Copy Connection URL.' };
    }
    const token = url.searchParams.get('token');
    if (!token) {
        return { ok: false, error: 'That URL has no access token. In GreenSplit, use Copy Connection URL.' };
    }
    url.searchParams.delete('token');
    url.hash = '';
    return { ok: true, url: url.toString(), token };
}

/** The address from settings with the token put back — only ever built in memory, at connect time. */
function buildConnectionUrl(url, token) {
    const full = new URL(url);
    full.searchParams.set('token', token);
    return full.toString();
}

/** The adapter lives on the same machine as the event server, so it shares the Connection URL's host. */
function livesplitHost(url) {
    try {
        return new URL(url).hostname.replace(/^\[|\]$/g, '') || '127.0.0.1';
    } catch (error) {
        return '127.0.0.1';
    }
}

function livesplitPort(value) {
    const port = Number(value);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_LIVESPLIT_PORT;
}

// ------------------------------------------------------------------ GreenSplit -> LBCBot (pure)

const MEDALS = new Set(['gold', 'silver', 'bronze']);

const ns = (value) => (Number.isFinite(value) ? value : undefined);

const segmentsOf = (run) => (run && Array.isArray(run.segments) ? run.segments : []);

/** Drop what GreenSplit did not say, so a body carries only real values (false and 0 are real). */
function compact(body) {
    const out = {};
    Object.entries(body).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            out[key] = value;
        }
    });
    return out;
}

/** A segment's CUMULATIVE time in a comparison, or undefined when the comparison has none for it. */
function comparisonTime(segment, comparison) {
    const entry = segment && segment.comparisons && segment.comparisons[comparison];
    return entry ? ns(entry.real_time_ns) : undefined;
}

/**
 * The fields on every trigger: game, category, comparison, attempt.
 *
 * `attempt_count` only goes up when GreenSplit commits the attempt, after the reset — the reset event's own snapshot
 * still has the old count — so the attempt in progress, and the one being reset, is one more than it.
 */
function runFields(run, comparison) {
    const r = run || {};
    return {
        game: r.game_name,
        category: r.category_name,
        comparison: comparison || r.current_comparison,
        attempt: Number.isInteger(r.attempt_count) ? r.attempt_count + 1 : undefined,
    };
}

/** The segment the timer is on now: what a pause, an undo or a live pace change is "at". */
function currentSegmentFields(run, timer) {
    const segments = segmentsOf(run);
    const index = timer ? timer.current_segment_index : undefined;
    const segment = Number.isInteger(index) ? segments[index] : undefined;
    return {
        splitName: segment ? segment.name : undefined,
        splitNumber: segment ? index + 1 : undefined,
        totalSplits: segments.length || undefined,
    };
}

/** A split's fields — also a gold's, whether it came from a split or from the finish. */
function splitFields(event, run, { finish = false } = {}) {
    const completed = event.completed_segment || {};
    const index = Number.isInteger(event.completed_route_index) ? event.completed_route_index : completed.route_index;
    return {
        splitName: completed.name,
        splitNumber: Number.isInteger(index) ? index + 1 : undefined,
        totalSplits: segmentsOf(run).length || undefined,
        // At the finish GreenSplit names the final segment as "next" too; there is no next split to announce.
        nextSplitName: finish ? undefined : event.next_segment && event.next_segment.name,
        splitTimeNs: ns(event.split_time_ns),
        segmentTimeNs: ns(event.segment_time_ns),
        deltaNs: ns(event.delta_ns),
        segmentDeltaNs: ns(event.segment_delta_ns),
        medal: MEDALS.has(event.medal) ? event.medal : undefined,
    };
}

/** The personal best a finish is measured against: the final segment's PB split time, as it stood before the run. */
function previousBest(run) {
    const segments = segmentsOf(run);
    const last = segments[segments.length - 1];
    return last && last.personal_best ? ns(last.personal_best.real_time_ns) : undefined;
}

/**
 * Translate one GreenSplit event message into the `POST /api/users/greensplit/event` bodies it fires, in order — one
 * body per trigger type. Pace changes are not here; they need history, which `RunTracker` keeps.
 *
 * Field names are a contract with the API's event map, which is what `{splitName}`, `{delta}` and the rest resolve
 * against. Renaming one side alone leaves tokens rendering literally in alerts, with nothing failing anywhere.
 */
function mapEvent(message) {
    if (!message || message.type !== 'event') {
        return [];
    }
    const event = message.event || {};
    const run = message.run || {};
    const timer = message.timer || {};
    const body = (eventType, fields, comparison) => compact({ eventType, ...runFields(run, comparison), ...fields });

    switch (message.name) {
        case 'timer_started':
            return [body(T.RUN_STARTED, {})];
        case 'split': {
            const fields = splitFields(event, run);
            const out = [body(T.SPLIT, fields, event.comparison_name)];
            if (event.is_gold) {
                out.push(body(T.GOLD, fields, event.comparison_name));
            }
            return out;
        }
        case 'run_finished': {
            // The final split arrives as run_finished, never as split — so a gold on the last segment is found here.
            const fields = splitFields(event, run, { finish: true });
            const out = [body(T.RUN_FINISHED, {
                splitName: fields.splitName,
                totalSplits: fields.totalSplits,
                finalTimeNs: fields.splitTimeNs,
                deltaNs: fields.deltaNs,
                personalBest: event.personal_best_candidate === true,
                medal: fields.medal,
            }, event.comparison_name)];
            if (event.is_gold) {
                out.push(body(T.GOLD, fields, event.comparison_name));
            }
            /*
             * The PB fires at the finish, the moment it happens on stream. GreenSplit's own `personal_best` event only
             * comes at the reset afterwards, and never for a first-ever completion, so it is not what drives this.
             */
            if (event.personal_best_candidate === true) {
                out.push(body(T.PERSONAL_BEST, {
                    finalTimeNs: fields.splitTimeNs,
                    previousBestNs: previousBest(run),
                }, event.comparison_name));
            }
            return out;
        }
        case 'split_undone':
            // The timer is back on the segment whose split was undone.
            return [body(T.SPLIT_UNDONE, currentSegmentFields(run, timer))];
        case 'split_skipped': {
            const skipped = event.skipped_segment || {};
            const index = Number.isInteger(event.skipped_route_index) ? event.skipped_route_index : skipped.route_index;
            return [body(T.SPLIT_SKIPPED, {
                splitName: skipped.name,
                splitNumber: Number.isInteger(index) ? index + 1 : undefined,
                totalSplits: segmentsOf(run).length || undefined,
                nextSplitName: event.next_segment && event.next_segment.name,
            }, event.comparison_name)];
        }
        case 'paused':
        case 'resumed':
            return [body(message.name === 'paused' ? T.PAUSED : T.RESUMED, {
                ...currentSegmentFields(run, timer),
                timeNs: ns(timer.real_time_ns),
            })];
        case 'reset': {
            // Reset mid-run names the segment it was reset on; reset after a finish has none, so it names the last one.
            const at = event.reset_segment || event.last_completed_segment || {};
            const total = segmentsOf(run).length || undefined;
            const index = event.reset_segment ? event.reset_route_index : at.route_index;
            return [body(T.RESET, {
                splitName: at.name,
                splitNumber: Number.isInteger(index) ? index + 1 : undefined,
                totalSplits: total,
                splitsCompleted: Number.isInteger(event.completed_split_count) ? event.completed_split_count : undefined,
                completed: event.completed === true,
                timeNs: ns(event.final_time_ns),
            })];
        }
        case 'comparison_changed':
            return [body(T.COMPARISON_CHANGED, {}, event.comparison)];
        default:
            // run_saved, attempt_committed, run_changed and GreenSplit's own personal_best are bookkeeping, not
            // moments on stream.
            return [];
    }
}

/**
 * Whether the running time has already passed the comparison's split time for the segment being run — "behind",
 * live, before the split that would prove it. Answers how far past, or undefined.
 */
function liveBehindBy(run, timer) {
    if (!timer || (timer.phase !== 'running' && timer.phase !== 'paused')) {
        return undefined;
    }
    const index = timer.current_segment_index;
    const segment = Number.isInteger(index) ? segmentsOf(run)[index] : undefined;
    const target = comparisonTime(segment, timer.current_comparison || (run && run.current_comparison));
    const now = ns(timer.real_time_ns);
    return target !== undefined && now !== undefined && now > target ? now - target : undefined;
}

/**
 * The pace a snapshot implies, without firing anything: the sign of the newest completed split that has a comparison
 * time, then "behind" if the running time is already past the current segment's comparison.
 *
 * Used after an undo and on (re)connecting mid-run. The live half matters for the undo: a runner who was already
 * behind, split, then undid it is still behind — re-deriving from the splits alone would say "ahead" and the very next
 * tick would announce "behind" a second time.
 */
function derivePace(run, timer) {
    if (!timer || !run || timer.phase === 'not_running') {
        return null;
    }
    const segments = segmentsOf(run);
    const comparison = timer.current_comparison || run.current_comparison;
    const times = Array.isArray(timer.split_times_ns) ? timer.split_times_ns : [];
    // Splits before the current segment are the completed ones; once the run has ended they all are.
    const upTo = timer.phase === 'ended' || !Number.isInteger(timer.current_segment_index)
        ? times.length
        : Math.min(timer.current_segment_index, times.length);
    let pace = null;
    for (let i = 0; i < upTo; i += 1) {
        const time = ns(times[i]);
        const target = comparisonTime(segments[i], comparison);
        if (time !== undefined && target !== undefined && time !== target) {
            pace = time < target ? 'ahead' : 'behind';
        }
    }
    if (timer.phase !== 'ended' && liveBehindBy(run, timer) !== undefined) {
        pace = 'behind';
    }
    return pace;
}

/**
 * Follows one GreenSplit session: keeps the latest run snapshot (ticks do not carry one) and the pace, and turns each
 * message into the trigger bodies it fires, in the order they should reach LBCBot.
 *
 * The pace machine: no pace at the start, at a reset and on a comparison change; a split or finish with a delta below
 * zero is ahead, above zero behind, no delta leaves it alone; a tick whose running time passes the comparison's split
 * time for the current segment is behind (`live: true`). PACE_AHEAD / PACE_BEHIND fire only on a change, so a run that
 * stays ahead announces it once.
 */
class RunTracker {
    constructor() {
        this.run = null;
        this.pace = null;
    }

    /** Message in, trigger bodies out. Safe to call with anything GreenSplit sends. */
    handle(message) {
        if (!message || typeof message !== 'object') {
            return [];
        }
        const before = this.run;
        // Events and snapshots carry the whole run after the change — the comparisons a tick is measured against.
        if (message.run) {
            this.run = message.run;
        }
        switch (message.type) {
            case 'snapshot':
                this.pace = derivePace(message.run, message.timer);
                return [];
            case 'timer_tick':
                return this.tick(message.timer);
            case 'event':
                // GreenSplit announces a comparison change even when it was set to the one already showing; that is
                // not a change on stream, and must not clear the pace either.
                if (message.name === 'comparison_changed' && before && message.event
                    && message.event.comparison === before.current_comparison) {
                    return [];
                }
                return [...mapEvent(message), ...this.paceAfter(message)];
            default:
                return [];
        }
    }

    tick(timer) {
        if (!timer || timer.phase !== 'running' || this.pace === 'behind') {
            return [];
        }
        const by = liveBehindBy(this.run, timer);
        if (by === undefined) {
            return [];
        }
        this.pace = 'behind';
        return [compact({
            eventType: T.PACE_BEHIND,
            ...runFields(this.run, timer.current_comparison),
            ...currentSegmentFields(this.run, timer),
            deltaNs: by,
            live: true,
        })];
    }

    paceAfter(message) {
        const event = message.event || {};
        switch (message.name) {
            case 'timer_started':
            case 'reset':
            case 'comparison_changed':
                this.pace = null;
                return [];
            case 'split_undone':
                this.pace = derivePace(message.run, message.timer);
                return [];
            case 'split':
            case 'run_finished': {
                const delta = ns(event.delta_ns);
                if (delta === undefined || delta === 0) {
                    return [];
                }
                const pace = delta < 0 ? 'ahead' : 'behind';
                if (pace === this.pace) {
                    return [];
                }
                this.pace = pace;
                const fields = splitFields(event, message.run);
                return [compact({
                    eventType: pace === 'ahead' ? T.PACE_AHEAD : T.PACE_BEHIND,
                    ...runFields(message.run, event.comparison_name),
                    splitName: fields.splitName,
                    splitNumber: fields.splitNumber,
                    totalSplits: fields.totalSplits,
                    deltaNs: delta,
                    live: false,
                })];
            }
            default:
                return [];
        }
    }
}

// ------------------------------------------------------------------ LBCBot -> GreenSplit (pure)

/** Action types that are one fixed LiveSplit command. */
const SIMPLE_ACTIONS = {
    START_TIMER: 'starttimer',
    SPLIT: 'split',
    START_OR_SPLIT: 'startorsplit',
    UNDO_SPLIT: 'unsplit',
    SKIP_SPLIT: 'skipsplit',
    PAUSE: 'pause',
    RESUME: 'resume',
    RESET: 'reset',
};

/** A GreenSplit event must never drive GreenSplit: a split that fires a trigger that splits would run the timer away. */
function isLoopedCommand(command) {
    return Boolean(command && typeof command.triggerType === 'string' && command.triggerType.startsWith('GREENSPLIT_'));
}

/** The comparison `step` places from the current one in the run's list, wrapping round. */
function cycleComparison(run, step) {
    const names = (run && Array.isArray(run.comparisons) ? run.comparisons : [])
        .map((c) => (c && typeof c.name === 'string' ? c.name : null))
        .filter(Boolean);
    if (names.length === 0) {
        return null;
    }
    const at = names.indexOf(run.current_comparison);
    if (at === -1) {
        return step > 0 ? names[0] : names[names.length - 1];
    }
    return names[(at + step + names.length * Math.abs(step)) % names.length];
}

/** TOGGLE_PAUSE: what to send for the phase `getcurrenttimerphase` answered, or null when there is nothing to toggle. */
function pauseCommandFor(phase) {
    if (phase === 'Running') {
        return 'pause';
    }
    if (phase === 'Paused') {
        return 'resume';
    }
    return null;
}

/**
 * What one greensplitAction asks of the adapter. Pure, so the whole vocabulary is unit-tested.
 *
 * `{ command }` is a line to send; `{ toggle: true }` asks the phase first (TOGGLE_PAUSE); `{ skip }` is a readable
 * reason to do nothing; `{ unknown: true }` is a type this version does not know.
 */
function planAction(action, run) {
    const type = action && action.type;
    if (Object.prototype.hasOwnProperty.call(SIMPLE_ACTIONS, type)) {
        return { command: SIMPLE_ACTIONS[type] };
    }
    switch (type) {
        case 'TOGGLE_PAUSE':
            return { toggle: true };
        case 'SET_COMPARISON': {
            const name = typeof action.comparison === 'string' ? action.comparison : '';
            if (!name.trim()) {
                return { skip: 'SET_COMPARISON has no comparison name' };
            }
            // One line is one command: a name with a line break in it would smuggle a second one (a reset, say) in.
            if (/[\r\n]/.test(name)) {
                return { skip: 'SET_COMPARISON name has a line break in it' };
            }
            return { command: `setcomparison ${name}` };
        }
        case 'NEXT_COMPARISON':
        case 'PREVIOUS_COMPARISON': {
            const name = cycleComparison(run, type === 'NEXT_COMPARISON' ? 1 : -1);
            return name ? { command: `setcomparison ${name}` } : { skip: 'no comparisons known yet' };
        }
        default:
            return { unknown: true };
    }
}

// ------------------------------------------------------------------ the LiveSplit adapter (TCP)

/** `[Error]: System.Exception: There is no comparison called "X"` -> `There is no comparison called "X"`. */
function adapterError(line) {
    return new Error(line.replace(/^\[Error\]:?\s*/, '').replace(/^System\.\w+:\s*/, '') || 'GreenSplit refused it');
}

/**
 * One persistent connection to GreenSplit's LiveSplit Server Adapter, with commands sent one at a time.
 *
 * The protocol has no ids: a getter answers one line, an action that works answers nothing, and an action that fails
 * (an unknown comparison, say) answers an `[Error]: …` line. Sending one command at a time — an action waits a short
 * moment for a possible error — is what lets every line be matched to the command it answers.
 */
class LiveSplitClient {
    constructor({
        host, port, connect = net.connect, settleMs = 150, replyTimeoutMs = 2000, connectTimeoutMs = 2000, onClose,
    }) {
        this.host = host;
        this.port = port;
        this.connectFn = connect;
        this.settleMs = settleMs;
        this.replyTimeoutMs = replyTimeoutMs;
        this.connectTimeoutMs = connectTimeoutMs;
        this.onClose = onClose || (() => {});
        this.socket = null;
        this.opening = null;
        this.buffer = '';
        this.waiter = null;
        this.queue = Promise.resolve();
    }

    /** Connect if not already. Rejects with the socket error (ECONNREFUSED when the adapter is off). */
    open() {
        if (this.socket) {
            return Promise.resolve();
        }
        if (this.opening) {
            return this.opening;
        }
        this.opening = new Promise((resolve, reject) => {
            const socket = this.connectFn({ host: this.host, port: this.port });
            const fail = (error) => {
                clearTimeout(timer);
                socket.destroy();
                reject(error);
            };
            const timer = setTimeout(() => {
                fail(Object.assign(new Error('GreenSplit did not answer'), { code: 'ETIMEDOUT' }));
            }, this.connectTimeoutMs);
            socket.once('error', fail);
            socket.once('connect', () => {
                clearTimeout(timer);
                socket.removeListener('error', fail);
                this.attach(socket);
                resolve();
            });
        }).finally(() => {
            this.opening = null;
        });
        return this.opening;
    }

    attach(socket) {
        this.socket = socket;
        this.buffer = '';
        socket.setEncoding('utf8');
        if (socket.setNoDelay) {
            socket.setNoDelay(true);
        }
        socket.on('data', (chunk) => {
            this.buffer += chunk;
            let end = this.buffer.indexOf('\n');
            while (end !== -1) {
                const line = this.buffer.slice(0, end).replace(/\r$/, '');
                this.buffer = this.buffer.slice(end + 1);
                this.onLine(line);
                end = this.buffer.indexOf('\n');
            }
        });
        socket.on('error', () => {}); // 'close' follows, and is where it is handled
        socket.on('close', () => {
            if (this.socket !== socket) {
                return;
            }
            this.socket = null;
            this.failWaiter(new Error('GreenSplit closed the connection'));
            this.onClose();
        });
    }

    /** An action: resolves once GreenSplit has had a moment to object, rejects with its error if it did. */
    send(command) {
        return this.enqueue(command, false);
    }

    /** A getter: resolves with GreenSplit's one-line answer. */
    query(command) {
        return this.enqueue(command, true);
    }

    enqueue(command, expectReply) {
        const job = this.queue.then(() => this.exchange(command, expectReply));
        this.queue = job.catch(() => {});
        return job;
    }

    async exchange(command, expectReply) {
        if (/[\r\n]/.test(command)) {
            throw new Error('A LiveSplit command is a single line.');
        }
        await this.open();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiter = null;
                if (!expectReply) {
                    resolve(null);
                    return;
                }
                // A late answer would be taken as the next command's, so start the next one on a clean line.
                this.close();
                reject(new Error(`GreenSplit did not answer ${command}`));
            }, expectReply ? this.replyTimeoutMs : this.settleMs);
            this.waiter = {
                resolve: (line) => { clearTimeout(timer); resolve(line); },
                reject: (error) => { clearTimeout(timer); reject(error); },
            };
            this.socket.write(`${command}\r\n`);
        });
    }

    onLine(line) {
        const waiter = this.waiter;
        if (!waiter) {
            return; // nothing asked; GreenSplit does not volunteer lines, so this is noise
        }
        this.waiter = null;
        if (line.startsWith('[Error]')) {
            waiter.reject(adapterError(line));
        } else {
            waiter.resolve(line);
        }
    }

    failWaiter(error) {
        const waiter = this.waiter;
        this.waiter = null;
        if (waiter) {
            waiter.reject(error);
        }
    }

    close() {
        const socket = this.socket;
        this.socket = null;
        this.failWaiter(new Error('closed'));
        if (socket) {
            socket.destroy();
        }
    }
}

// ------------------------------------------------------------------ the bridge

class GreenSplitBridge {
    /**
     * @param settings   () => the app settings (greensplitUrl, greensplitLivesplitPort, forwardGreensplitEvents)
     * @param token      () => the access token, or null
     * @param onGreenSplitEvent  (body) => promise — one trigger for LBCBot; called strictly in order
     * @param onConnected  ({ appVersion }) => void — GreenSplit said hello
     */
    constructor({
        settings, token, onLog, onStatus, onGreenSplitEvent, onConnected,
        WebSocketImpl = globalThis.WebSocket, connectTcp = net.connect,
        helloTimeoutMs = HELLO_TIMEOUT_MS, retryMinMs = RETRY_MIN_MS, retryMaxMs = RETRY_MAX_MS,
        controlProbeMs = CONTROL_PROBE_MS, settleMs,
    }) {
        this.settings = settings;
        this.token = token;
        this.onLog = onLog || (() => {});
        this.onStatus = onStatus || (() => {});
        this.onGreenSplitEvent = onGreenSplitEvent || (async () => {});
        this.onConnected = onConnected || (() => {});
        this.WebSocketImpl = WebSocketImpl;
        this.connectTcp = connectTcp;
        this.helloTimeoutMs = helloTimeoutMs;
        this.retryMinMs = retryMinMs;
        this.retryMaxMs = retryMaxMs;
        this.controlProbeMs = controlProbeMs;
        this.settleMs = settleMs;

        /** The user wants GreenSplit on: keep (re)connecting until they turn it off. */
        this.enabled = false;
        /** off | connecting | connected | bad-token | unreachable */
        this.state = 'off';
        this.connected = false;
        this.appVersion = null;
        /** Can LBCBot drive the timer? null until the adapter has been tried. */
        this.controlAvailable = null;
        this.ws = null;
        this.helloTimer = null;
        this.retryTimer = null;
        this.retryDelay = retryMinMs;
        this.probeTimer = null;
        this.reportedOutage = false;
        this.tracker = new RunTracker();
        /** Posts go out one after another, so a split's SPLIT, GOLD and PACE reach LBCBot in that order. */
        this.outbox = Promise.resolve();
        this.livesplit = null;
        this.livesplitKey = null;
    }

    configured() {
        const { greensplitUrl } = this.settings();
        return Boolean(greensplitUrl && this.token());
    }

    get status() {
        return {
            state: this.state,
            configured: this.configured(),
            appVersion: this.appVersion,
            controlAvailable: this.controlAvailable,
            url: this.settings().greensplitUrl || '',
        };
    }

    setState(state) {
        this.state = state;
        this.connected = state === 'connected';
        this.onStatus(this.status);
    }

    // ------------------------------------------------------------------ connection

    /** Turn GreenSplit on: connect now, and keep reconnecting while it is closed — it often starts after this app. */
    connect() {
        if (!this.configured()) {
            this.setState('off');
            return false;
        }
        this.enabled = true;
        this.retryDelay = this.retryMinMs;
        this.reportedOutage = false;
        this.open(true);
        return true;
    }

    /** Turn GreenSplit off. The caller tells LBCBot (DELETE) — quitting the app is not turning it off. */
    disconnect() {
        this.enabled = false;
        this.dropSocket();
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.stopControl();
        this.appVersion = null;
        this.setState('off');
    }

    open(first) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.dropSocket();
        if (first) {
            this.setState('connecting');
        }
        const { greensplitUrl } = this.settings();
        let ws;
        try {
            ws = new this.WebSocketImpl(buildConnectionUrl(greensplitUrl, this.token()));
        } catch (error) {
            this.onLog(`Could not connect to GreenSplit: ${error.message}`);
            this.scheduleRetry();
            return;
        }
        this.ws = ws;
        ws.onopen = () => {
            if (this.ws !== ws) {
                return;
            }
            this.helloTimer = setTimeout(() => this.onNoHello(ws), this.helloTimeoutMs);
        };
        ws.onmessage = (message) => this.onMessage(ws, message.data);
        ws.onerror = () => {}; // close follows, and is where it is handled
        ws.onclose = () => this.onSocketGone(ws);
    }

    /** Forget the socket without waiting on it: GreenSplit never answers a close on a socket it did not accept. */
    dropSocket() {
        clearTimeout(this.helloTimer);
        this.helloTimer = null;
        const ws = this.ws;
        this.ws = null;
        if (ws) {
            ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
            try {
                ws.close();
            } catch (error) {
                // Already closed.
            }
        }
    }

    onNoHello(ws) {
        if (this.ws !== ws) {
            return;
        }
        // Not retried: the same token will be refused the same way. Pasting the URL again (or Connect) starts over.
        this.dropSocket();
        this.stopControl();
        this.onLog('GreenSplit did not accept the access token. Copy the Connection URL from GreenSplit again.');
        this.setState('bad-token');
    }

    onSocketGone(ws) {
        if (this.ws !== ws) {
            return;
        }
        this.ws = null;
        clearTimeout(this.helloTimer);
        this.helloTimer = null;
        const wasConnected = this.connected;
        this.stopControl();
        if (!this.enabled) {
            return;
        }
        // One line per outage, not one per retry: GreenSplit can be closed for a whole stream.
        if (wasConnected) {
            this.onLog('GreenSplit closed the connection. Reconnecting when it is back.');
        } else if (!this.reportedOutage) {
            this.onLog('Waiting for GreenSplit — is it open, with its WebSocket server on?');
        }
        this.reportedOutage = true;
        if (this.state !== 'unreachable') {
            this.setState('unreachable');
        }
        this.scheduleRetry();
    }

    scheduleRetry() {
        if (!this.enabled) {
            return;
        }
        const delay = this.retryDelay;
        this.retryDelay = Math.min(this.retryDelay * 2, this.retryMaxMs);
        this.retryTimer = setTimeout(() => this.open(false), delay);
    }

    onMessage(ws, data) {
        if (this.ws !== ws || typeof data !== 'string') {
            return;
        }
        let message;
        try {
            message = JSON.parse(data);
        } catch (error) {
            return;
        }
        if (!message || typeof message !== 'object') {
            return;
        }
        switch (message.type) {
            case 'hello':
                this.onHello(ws, message);
                return;
            case 'error':
                this.onLog(`GreenSplit: ${message.message || message.code}`);
                return;
            default:
                this.tracker.handle(message).forEach((body) => this.emit(body));
        }
    }

    onHello(ws, hello) {
        clearTimeout(this.helloTimer);
        this.helloTimer = null;
        this.retryDelay = this.retryMinMs;
        this.reportedOutage = false;
        this.appVersion = hello.app_version || null;
        if (hello.version !== undefined && hello.version !== 1) {
            this.onLog(`GreenSplit sends a newer event format (v${hello.version}); update this app if events go missing.`);
        }
        try {
            ws.send(JSON.stringify({ type: 'subscribe', timer_hz: TIMER_HZ }));
        } catch (error) {
            // The close that follows reconnects.
        }
        this.tracker.pace = null; // the snapshot that follows hello re-derives it
        this.onLog(`Connected to GreenSplit${this.appVersion ? ` ${this.appVersion}` : ''}.`);
        this.setState('connected');
        this.onConnected({ appVersion: this.appVersion });
        this.probeControl();
    }

    emit(body) {
        if (this.settings().forwardGreensplitEvents === false) {
            return;
        }
        this.outbox = this.outbox
            .then(() => this.onGreenSplitEvent(body))
            .catch((error) => this.onLog(`Could not forward ${body.eventType}: ${error.message}`));
    }

    // ------------------------------------------------------------------ control (LiveSplit adapter)

    /** The adapter client for the current host and port, rebuilt when either changes. */
    adapter() {
        const settings = this.settings();
        const host = livesplitHost(settings.greensplitUrl);
        const port = livesplitPort(settings.greensplitLivesplitPort);
        const key = `${host}:${port}`;
        if (!this.livesplit || this.livesplitKey !== key) {
            if (this.livesplit) {
                this.livesplit.close();
            }
            this.livesplitKey = key;
            const client = new LiveSplitClient({
                host,
                port,
                connect: this.connectTcp,
                settleMs: this.settleMs,
                // The adapter being switched off in GreenSplit drops the connection: look again shortly.
                onClose: () => {
                    if (this.livesplit === client && this.connected) {
                        this.scheduleProbe(1000);
                    }
                },
            });
            this.livesplit = client;
        }
        return this.livesplit;
    }

    /** Settings changed: a new adapter port takes effect at once. */
    settingsChanged() {
        if (!this.livesplit) {
            return;
        }
        const before = this.livesplitKey;
        this.adapter();
        if (this.livesplitKey !== before && this.connected) {
            this.probeControl();
        }
    }

    /** Is the adapter on? Asked on every hello, then every few seconds while it is not — nothing announces it. */
    async probeControl() {
        clearTimeout(this.probeTimer);
        this.probeTimer = null;
        let available = true;
        try {
            await this.adapter().open();
        } catch (error) {
            available = false;
        }
        // The answer can land after GreenSplit went away or was turned off; it no longer means anything then.
        if (!this.connected) {
            return;
        }
        if (this.setControl(available) && !available) {
            this.onLog('LBCBot can\'t control GreenSplit until its LiveSplit Server Adapter is on.');
        }
        if (!available) {
            this.scheduleProbe(this.controlProbeMs);
        }
    }

    scheduleProbe(delay) {
        clearTimeout(this.probeTimer);
        this.probeTimer = setTimeout(() => {
            this.probeTimer = null;
            if (this.connected) {
                this.probeControl();
            }
        }, delay);
    }

    /** Record whether the adapter answers; true when that changed (and the renderer was told). */
    setControl(available) {
        if (this.controlAvailable === available) {
            return false;
        }
        this.controlAvailable = available;
        this.onStatus(this.status);
        return true;
    }

    stopControl() {
        clearTimeout(this.probeTimer);
        this.probeTimer = null;
        if (this.livesplit) {
            this.livesplit.close();
        }
        this.controlAvailable = null;
    }

    /**
     * Execute one GreenSplit action sent by the server.
     *
     * Like the OBS actions, the server forwards it as an opaque JSON string and never parses it, so this is the only
     * place that knows the vocabulary — a new action type is a desktop release with no API deploy. Nothing validated it
     * on the way here, so every field is untrusted and an unknown type is logged rather than thrown.
     */
    async execute(command) {
        if (isLoopedCommand(command)) {
            this.onLog(`Ignored a GreenSplit action fired by ${command.triggerType} — `
                + 'GreenSplit events never drive GreenSplit.');
            return;
        }
        if (!this.enabled || !this.configured()) {
            this.onLog('Ignored a GreenSplit action — GreenSplit is not connected in this app.');
            return;
        }
        let action;
        try {
            action = typeof command.action === 'string' ? JSON.parse(command.action) : command.action;
        } catch (error) {
            this.onLog(`Ignored an unreadable GreenSplit action: ${error.message}`);
            return;
        }
        if (!action || !action.type) {
            return;
        }

        const plan = planAction(action, this.tracker.run);
        if (plan.unknown) {
            this.onLog(`Unknown GreenSplit action type "${action.type}" — ignoring.`);
            return;
        }
        if (plan.skip) {
            this.onLog(`Ignored GreenSplit ${action.type}: ${plan.skip}.`);
            return;
        }

        const adapter = this.adapter();
        try {
            let line = plan.command;
            if (plan.toggle) {
                const phase = await adapter.query('getcurrenttimerphase');
                line = pauseCommandFor(phase);
                if (!line) {
                    this.onLog(`GreenSplit: nothing to pause or resume (the timer is ${phase}).`);
                    return;
                }
            }
            await adapter.send(line);
            this.setControl(true);
            this.onLog(`GreenSplit: ${action.type}${line.startsWith('setcomparison ') ? ` (${line.slice(14)})` : ''}`);
        } catch (error) {
            if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
                this.onLog(`Could not run GreenSplit ${action.type} — turn on its LiveSplit Server Adapter.`);
                this.setControl(false);
                if (this.connected) {
                    this.scheduleProbe(this.controlProbeMs);
                }
                return;
            }
            this.onLog(`GreenSplit action ${action.type} failed: ${error.message}`);
        }
    }
}

module.exports = {
    GreenSplitBridge,
    LiveSplitClient,
    RunTracker,
    TRIGGERS: T,
    DEFAULT_LIVESPLIT_PORT,
    TIMER_HZ,
    parseConnectionUrl,
    buildConnectionUrl,
    livesplitHost,
    livesplitPort,
    mapEvent,
    derivePace,
    planAction,
    cycleComparison,
    pauseCommandFor,
    isLoopedCommand,
};
