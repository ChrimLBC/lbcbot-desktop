'use strict';

/**
 * The obs-websocket bridge — the whole reason this app exists.
 *
 * obs-websocket v5 ships *inside* OBS 28+, so nothing needs installing on the OBS side: it just needs enabling under
 * Tools -> WebSocket Server Settings. That is why LBCBot does not need a native C++ OBS plugin. Everything the
 * integration promised is here — scene switching, source visibility, recording control, and an event stream — and it
 * only ever needed one long-running local process to talk to.
 *
 * The OBS can be on another computer (2026-11-26): with NDI, the PC running this app is often the source and a second
 * PC runs the OBS that goes live. That is why the connection retries on its own (a LAN link drops and comes back, and
 * the other PC's OBS may start after this app) and why this bridge can start and stop the stream.
 *
 * Both directions live in this file:
 *  - OBS -> LBCBot: scene/stream/source events become LBCBot triggers.
 *  - LBCBot -> OBS: the OBS actions attached to triggers are executed here.
 */

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30000;
/** obs-websocket's close code for a wrong password: retrying can't fix it, so the loop stops there. */
const AUTH_FAILED = 4009;
/** obs-websocket request statuses for "already streaming" / "not streaming": the stream is already as asked. */
const OUTPUT_RUNNING = 500;
const OUTPUT_NOT_RUNNING = 501;

/** The wait before retry number `attempt` (0-based): 1 s, 2 s, 4 s … capped at 30 s. */
function retryDelay(attempt, min = RETRY_MIN_MS, max = RETRY_MAX_MS) {
    return Math.min(min * (2 ** Math.max(0, attempt)), max);
}

/** obs-websocket's output states as what the stream is doing. A state not listed leaves the stream as it was. */
const STREAM_STATES = {
    OBS_WEBSOCKET_OUTPUT_STARTING: 'starting',
    OBS_WEBSOCKET_OUTPUT_STARTED: 'live',
    OBS_WEBSOCKET_OUTPUT_RECONNECTING: 'reconnecting',
    OBS_WEBSOCKET_OUTPUT_RECONNECTED: 'live',
    OBS_WEBSOCKET_OUTPUT_STOPPING: 'stopping',
    OBS_WEBSOCKET_OUTPUT_STOPPED: 'off',
};

function isAuthError(error) {
    return Boolean(error) && (error.code === AUTH_FAILED || /auth/i.test(error.message || ''));
}

/** The host part of a ws:// URL, for "Connected to 10.0.0.88". */
function hostOf(url) {
    try {
        return new URL(url).hostname;
    } catch (error) {
        return '';
    }
}

class ObsBridge {
    constructor({
        onLog, onStatus, onObsEvent,
        // Loaded here, not at the top, so the tests can pass a stand-in without the package installed.
        client = new (require('obs-websocket-js').default)(),
        settings = () => require('./store').settings(),
        password = () => require('./store').getObsPassword(),
        setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
    }) {
        this.obs = client;
        this.settings = settings;
        this.password = password;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.now = now;
        this.onLog = onLog || (() => {});
        this.onStatus = onStatus || (() => {});
        this.onObsEvent = onObsEvent || (() => {});
        this.connected = false;
        this.currentScene = null;
        /** Whether a connection is wanted: Connect sets it, Disconnect clears it. Retries run only while it is set. */
        this.wanted = false;
        this.retryTimer = null;
        this.retryAttempt = 0;
        /** One log line per outage, not one per retry: the other PC can be off for a whole evening. */
        this.outageLogged = false;
        /** `off`, `connecting`, `retrying`, `connected`, `needs-password` (none saved) or `bad-password`. */
        this.state = 'off';
        this.error = null;
        this.url = '';
        /** What the stream is doing (`off`, `starting`, `live`, `reconnecting`, `stopping`), and since when it's live. */
        this.stream = { state: 'off', startedAt: null };
        /** Timers for SET_SOURCE_VISIBLE actions with a revertAfterSeconds, keyed so repeats restart the clock. */
        this.revertTimers = new Map();
        this.wireEvents();
    }

    get status() {
        return {
            connected: this.connected,
            state: this.state,
            url: this.url,
            host: hostOf(this.url),
            error: this.error,
            stream: { ...this.stream },
        };
    }

    /** Whether the last try failed only on the password: a new one should be tried at once. */
    get passwordProblem() {
        return this.state === 'bad-password' || this.state === 'needs-password';
    }

    publish() {
        this.onStatus(this.status);
    }

    /**
     * Connect, and keep reconnecting until it works or Disconnect is pressed. Answers whether the first attempt
     * connected. A wrong password stops the loop: only a new password can fix that.
     */
    async connect() {
        this.wanted = true;
        this.retryAttempt = 0;
        this.outageLogged = false;
        this.cancelRetry();
        return this.attempt();
    }

    async attempt() {
        const { obsUrl } = this.settings();
        const password = this.password();
        this.url = obsUrl;
        if (!this.connected) {
            this.state = this.retryAttempt === 0 ? 'connecting' : 'retrying';
            this.publish();
        }
        try {
            await this.obs.connect(obsUrl, password || undefined);
        } catch (error) {
            this.connected = false;
            if (!this.wanted) {
                return false;
            }
            if (isAuthError(error)) {
                this.wanted = false;
                this.state = password ? 'bad-password' : 'needs-password';
                this.error = password
                    ? 'OBS rejected the password. Check Tools → WebSocket Server Settings on that PC.'
                    : 'That OBS needs its password, from Tools → WebSocket Server Settings on that PC.';
                this.onLog(`${this.error} (${error.message})`);
                this.publish();
                return false;
            }
            this.error = `Can't reach OBS at ${hostOf(obsUrl) || obsUrl}. Check that OBS is open there, its WebSocket server is on, and its firewall allows it.`;
            if (!this.outageLogged) {
                this.onLog(`${this.error} Trying again until it answers. (${error.message})`);
                this.outageLogged = true;
            }
            this.scheduleRetry();
            return false;
        }
        if (!this.wanted) {
            // Disconnect was pressed while this attempt was in flight.
            await this.obs.disconnect().catch(() => {});
            return false;
        }
        this.connected = true;
        this.state = 'connected';
        this.error = null;
        this.retryAttempt = 0;
        this.outageLogged = false;
        const scene = await this.obs.call('GetCurrentProgramScene').catch(() => null);
        this.currentScene = scene ? scene.sceneName || scene.currentProgramSceneName : null;
        await this.readStreamStatus();
        this.onLog(`Connected to OBS at ${obsUrl}.`);
        this.publish();
        return true;
    }

    scheduleRetry() {
        this.cancelRetry();
        this.state = 'retrying';
        this.publish();
        const delay = retryDelay(this.retryAttempt);
        this.retryAttempt += 1;
        this.retryTimer = this.setTimer(() => {
            this.retryTimer = null;
            if (this.wanted) this.attempt();
        }, delay);
    }

    cancelRetry() {
        if (this.retryTimer) {
            this.clearTimer(this.retryTimer);
            this.retryTimer = null;
        }
    }

    async disconnect() {
        this.wanted = false;
        this.cancelRetry();
        try {
            await this.obs.disconnect();
        } catch (error) {
            // Already gone.
        }
        this.connected = false;
        this.state = 'off';
        this.error = null;
        this.stream = { state: 'off', startedAt: null };
        this.clearRevertTimers();
        this.publish();
    }

    /**
     * Point at another OBS (a new address or password): reconnect there if a connection was wanted, or if the last
     * try failed only on the password.
     */
    async reconnect() {
        if (!this.wanted && !this.passwordProblem) {
            return false;
        }
        this.wanted = false;
        this.cancelRetry();
        await this.obs.disconnect().catch(() => {});
        this.connected = false;
        return this.connect();
    }

    // ------------------------------------------------------------------ the stream

    async readStreamStatus() {
        const status = await this.obs.call('GetStreamStatus').catch(() => null);
        if (!status || !status.outputActive) {
            this.stream = { state: 'off', startedAt: null };
            return;
        }
        this.stream = {
            state: status.outputReconnecting ? 'reconnecting' : 'live',
            startedAt: this.now() - (Number(status.outputDuration) || 0),
        };
    }

    applyStreamState(outputState) {
        const state = STREAM_STATES[outputState];
        if (!state) {
            return;
        }
        let { startedAt } = this.stream;
        if (state === 'live' && startedAt == null) startedAt = this.now();
        if (state === 'off') startedAt = null;
        this.stream = { state, startedAt };
        this.publish();
    }

    /** Start or stop the stream. Answers `{ ok }`, or `{ ok: false, error }` in words to show. */
    async setStreaming(on) {
        if (!this.connected) {
            return { ok: false, error: 'Not connected to OBS.' };
        }
        try {
            await this.obs.call(on ? 'StartStream' : 'StopStream');
            this.onLog(on ? 'Asked OBS to start the stream.' : 'Asked OBS to stop the stream.');
            return { ok: true };
        } catch (error) {
            if (error && (error.code === OUTPUT_RUNNING || error.code === OUTPUT_NOT_RUNNING)) {
                return { ok: true };
            }
            this.onLog(`Could not ${on ? 'start' : 'stop'} the stream: ${error.message}`);
            return { ok: false, error: on ? 'OBS could not start the stream. Check its Stream settings.' : 'OBS could not stop the stream.' };
        }
    }

    // ------------------------------------------------------------------ OBS -> LBCBot

    /**
     * Translate OBS events into the shapes `POST /api/users/obs/event` expects.
     *
     * Field names here are a contract with `ObsEventService.buildEvent` on the server, which in turn is what the
     * `{scene}` / `{source}` placeholder tokens resolve against. Renaming one side alone leaves tokens rendering
     * literally in alerts, with nothing failing anywhere.
     */
    wireEvents() {
        this.obs.on('ConnectionClosed', () => {
            if (this.connected) {
                this.connected = false;
                this.stream = { state: 'off', startedAt: null };
                this.clearRevertTimers();
                if (this.wanted) {
                    this.onLog('Lost the connection to OBS. Reconnecting…');
                    this.outageLogged = true;
                    this.retryAttempt = 0;
                    this.scheduleRetry();
                } else {
                    this.state = 'off';
                    this.onLog('OBS connection closed.');
                    this.publish();
                }
            }
        });

        this.obs.on('CurrentProgramSceneChanged', ({ sceneName }) => {
            const previousSceneName = this.currentScene;
            this.currentScene = sceneName;
            this.emit('OBS_SCENE_CHANGED', { sceneName, previousSceneName: previousSceneName || '' });
        });

        this.obs.on('StreamStateChanged', ({ outputActive, outputState }) => {
            this.applyStreamState(outputState);
            // OBS emits intermediate states (STARTING, STOPPING) on the same event; only the settled ones are
            // meaningful as a trigger, or a single "go live" would fire twice.
            if (outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') {
                this.emit('OBS_STREAM_STARTED', {});
            } else if (outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
                this.emit('OBS_STREAM_STOPPED', {});
            } else if (outputActive === undefined) {
                this.onLog(`Ignoring intermediate stream state ${outputState}.`);
            }
        });

        this.obs.on('SceneItemEnableStateChanged', async ({ sceneName, sceneItemId, sceneItemEnabled }) => {
            // The event carries an item id, not a name — resolve it so conditions can match on something a user
            // recognises. A failed lookup still fires, with an empty name, rather than dropping the event.
            let sourceName = '';
            try {
                const list = await this.obs.call('GetSceneItemList', { sceneName });
                const item = (list.sceneItems || []).find((i) => i.sceneItemId === sceneItemId);
                sourceName = item ? item.sourceName : '';
            } catch (error) {
                this.onLog(`Could not resolve source name for item ${sceneItemId}: ${error.message}`);
            }
            this.emit(sceneItemEnabled ? 'OBS_SOURCE_SHOWN' : 'OBS_SOURCE_HIDDEN', { sourceName, sceneName });
        });
    }

    emit(eventType, payload) {
        if (!this.settings().forwardObsEvents) {
            return;
        }
        this.onObsEvent({ eventType, ...payload });
    }

    // ------------------------------------------------------------------ LBCBot -> OBS

    /**
     * Execute one OBS action sent by the server.
     *
     * The server forwards the action as an opaque JSON string and never parses it, so this method is the only place
     * that knows the vocabulary. That is deliberate: a new action type ships as a desktop release with no API deploy
     * and no enum constant — and the flip side is that nothing validated it on the way here, so every field is
     * treated as untrusted and an unknown type is logged rather than thrown.
     */
    async execute(command) {
        if (!this.connected) {
            this.onLog('Ignored an OBS action — not connected to OBS.');
            return;
        }
        let action;
        try {
            action = typeof command.action === 'string' ? JSON.parse(command.action) : command.action;
        } catch (error) {
            this.onLog(`Ignored an unreadable OBS action: ${error.message}`);
            return;
        }
        if (!action || !action.type) {
            return;
        }

        try {
            switch (action.type) {
                case 'SET_SOURCE_VISIBLE':
                    // Reports false when the source isn't in the scene; without this the log below would claim
                    // success immediately after saying it couldn't find the source.
                    if (!(await this.setSourceVisible(action))) {
                        return;
                    }
                    break;
                case 'SWITCH_SCENE':
                    await this.obs.call('SetCurrentProgramScene', { sceneName: action.sceneName });
                    break;
                case 'TOGGLE_MUTE':
                    await this.obs.call('SetInputMute', {
                        inputName: action.inputName,
                        inputMuted: action.muted !== false,
                    });
                    break;
                case 'REFRESH_BROWSER_SOURCE':
                    await this.obs.call('PressInputPropertiesButton', {
                        inputName: action.sourceName,
                        propertyName: 'refreshnocache',
                    });
                    break;
                case 'START_RECORDING':
                    await this.obs.call('StartRecord');
                    break;
                case 'STOP_RECORDING':
                    await this.obs.call('StopRecord');
                    break;
                case 'SAVE_REPLAY_BUFFER':
                    await this.obs.call('SaveReplayBuffer');
                    break;
                case 'START_STREAM':
                case 'STOP_STREAM': {
                    const result = await this.setStreaming(action.type === 'START_STREAM');
                    if (!result.ok) return;
                    break;
                }
                default:
                    this.onLog(`Unknown OBS action type "${action.type}" — ignoring.`);
                    return;
            }
            this.onLog(`OBS: ${action.type}${action.sceneName ? ` (${action.sceneName})` : ''}`);
        } catch (error) {
            this.onLog(`OBS action ${action.type} failed: ${error.message}`);
        }
    }

    async setSourceVisible(action) {
        const sceneName = action.sceneName || this.currentScene;
        const itemId = await this.findSceneItemId(sceneName, action.sourceName);
        if (itemId == null) {
            this.onLog(`Source "${action.sourceName}" not found in scene "${sceneName}".`);
            return false;
        }
        const enabled = action.visible !== false;
        await this.obs.call('SetSceneItemEnabled', { sceneName, sceneItemId: itemId, sceneItemEnabled: enabled });

        // "Show it for 8 seconds" is the common case for an alert-driven source, so it is built in rather than left
        // to the user to add a second inverse trigger they would have to keep in sync.
        const key = `${sceneName}::${action.sourceName}`;
        const existing = this.revertTimers.get(key);
        if (existing) {
            clearTimeout(existing);
            this.revertTimers.delete(key);
        }
        const revertAfter = Number(action.revertAfterSeconds);
        if (Number.isFinite(revertAfter) && revertAfter > 0) {
            // A repeat fire restarts the clock rather than stacking timers, so rapid alerts leave the source
            // visible for the full window after the LAST one instead of snapping off mid-sequence.
            this.revertTimers.set(key, setTimeout(async () => {
                this.revertTimers.delete(key);
                try {
                    await this.obs.call('SetSceneItemEnabled', {
                        sceneName,
                        sceneItemId: itemId,
                        sceneItemEnabled: !enabled,
                    });
                } catch (error) {
                    this.onLog(`Could not revert "${action.sourceName}": ${error.message}`);
                }
            }, revertAfter * 1000));
        }
        return true;
    }

    async findSceneItemId(sceneName, sourceName) {
        const list = await this.obs.call('GetSceneItemList', { sceneName });
        const item = (list.sceneItems || []).find((i) => i.sourceName === sourceName);
        return item ? item.sceneItemId : null;
    }

    clearRevertTimers() {
        this.revertTimers.forEach((timer) => clearTimeout(timer));
        this.revertTimers.clear();
    }

    // ------------------------------------------------------------------ one-click overlay setup

    /**
     * Create (or update) a browser source for an overlay — the convenience that removes copy-pasting a URL entirely.
     *
     * The URL never touches the clipboard, which matters: a component-view URL used to carry the user's Twitch access
     * AND refresh token, and now carries a scoped overlay key. Minting it here and handing it straight to OBS means it
     * is never displayed, screenshotted, or pasted into a support thread.
     */
    async createBrowserSource({ sceneName, inputName, url, width, height }) {
        const targetScene = sceneName || this.currentScene;
        const settings = {
            url,
            width: width || 1920,
            height: height || 1080,
            // An overlay that keeps rendering while hidden burns GPU for nothing; OBS reloads it when shown.
            shutdown: true,
            restart_when_active: false,
        };

        const existingId = await this.findSceneItemId(targetScene, inputName).catch(() => null);
        if (existingId != null) {
            // Re-running setup should refresh the existing source (new key, new size) rather than pile up
            // "Overlay (2)" inputs next to it.
            await this.obs.call('SetInputSettings', { inputName, inputSettings: settings, overlay: true });
            return { created: false, sceneName: targetScene, inputName };
        }

        await this.obs.call('CreateInput', {
            sceneName: targetScene,
            inputName,
            inputKind: 'browser_source',
            inputSettings: settings,
            sceneItemEnabled: true,
        });
        return { created: true, sceneName: targetScene, inputName };
    }

    async getSceneList() {
        if (!this.connected) {
            return [];
        }
        const result = await this.obs.call('GetSceneList').catch(() => null);
        return result ? (result.scenes || []).map((s) => s.sceneName) : [];
    }
}

module.exports = { ObsBridge, retryDelay, STREAM_STATES };
