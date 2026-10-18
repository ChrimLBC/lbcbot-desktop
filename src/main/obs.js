'use strict';

const OBSWebSocket = require('obs-websocket-js').default;
const store = require('./store');

/**
 * The obs-websocket bridge — the whole reason this app exists.
 *
 * obs-websocket v5 ships *inside* OBS 28+, so nothing needs installing on the OBS side: it just needs enabling under
 * Tools -> WebSocket Server Settings. That is why LBCBot does not need a native C++ OBS plugin. Everything the
 * integration promised is here — scene switching, source visibility, recording control, and an event stream — and it
 * only ever needed one long-running local process to talk to.
 *
 * Both directions live in this file:
 *  - OBS -> LBCBot: scene/stream/source events become LBCBot triggers.
 *  - LBCBot -> OBS: the OBS actions attached to triggers are executed here.
 */

class ObsBridge {
    constructor({ onLog, onStatus, onObsEvent }) {
        this.obs = new OBSWebSocket();
        this.onLog = onLog || (() => {});
        this.onStatus = onStatus || (() => {});
        this.onObsEvent = onObsEvent || (() => {});
        this.connected = false;
        this.currentScene = null;
        /** Timers for SET_SOURCE_VISIBLE actions with a revertAfterSeconds, keyed so repeats restart the clock. */
        this.revertTimers = new Map();
        this.wireEvents();
    }

    async connect() {
        const { obsUrl } = store.settings();
        const password = store.getObsPassword();
        try {
            await this.obs.connect(obsUrl, password || undefined);
            this.connected = true;
            const scene = await this.obs.call('GetCurrentProgramScene').catch(() => null);
            this.currentScene = scene ? scene.sceneName || scene.currentProgramSceneName : null;
            this.onLog(`Connected to OBS at ${obsUrl}.`);
            this.onStatus({ connected: true, currentScene: this.currentScene });
            return true;
        } catch (error) {
            this.connected = false;
            // The two realistic causes are worth separating, because the fix differs and the raw message is cryptic.
            const hint = /auth/i.test(error.message)
                ? 'OBS rejected the password — check Tools → WebSocket Server Settings.'
                : 'Could not reach OBS. Is it running, with the WebSocket server enabled?';
            this.onLog(`${hint} (${error.message})`);
            this.onStatus({ connected: false, error: hint });
            return false;
        }
    }

    async disconnect() {
        try {
            await this.obs.disconnect();
        } catch (error) {
            // Already gone.
        }
        this.connected = false;
        this.clearRevertTimers();
        this.onStatus({ connected: false });
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
                this.onLog('OBS connection closed.');
                this.onStatus({ connected: false });
            }
        });

        this.obs.on('CurrentProgramSceneChanged', ({ sceneName }) => {
            const previousSceneName = this.currentScene;
            this.currentScene = sceneName;
            this.emit('OBS_SCENE_CHANGED', { sceneName, previousSceneName: previousSceneName || '' });
        });

        this.obs.on('StreamStateChanged', ({ outputActive, outputState }) => {
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
        if (!store.settings().forwardObsEvents) {
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

module.exports = { ObsBridge };
