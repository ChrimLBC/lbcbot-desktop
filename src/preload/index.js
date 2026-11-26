'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The entire renderer-facing API surface.
 *
 * Deliberately narrow and verb-shaped rather than exposing `ipcRenderer` directly: the renderer never sees the
 * credential, never talks to OBS or GreenSplit, and never calls the LBCBot API. With `contextIsolation` on and
 * `nodeIntegration` off, this list is the hard boundary — anything not named here is unreachable from the page.
 */
contextBridge.exposeInMainWorld('lbcbot', {
    getState: () => ipcRenderer.invoke('get-state'),
    updateSettings: (patch) => ipcRenderer.invoke('update-settings', patch),

    // LBCBot accounts on this computer. The pane names them by an id of this app's own; credentials stay in main.
    addAccount: () => ipcRenderer.invoke('add-account'),
    switchAccount: (id) => ipcRenderer.invoke('switch-account', id),
    removeAccount: (id) => ipcRenderer.invoke('remove-account', id),

    // The OBS connections (several: the source PC's and the streaming PC's). Each is named by its id; a password goes
    // one way, to the main process, and is never sent back.
    findObs: () => ipcRenderer.invoke('find-obs'),
    addObs: (options) => ipcRenderer.invoke('add-obs', options),
    removeObs: (id) => ipcRenderer.invoke('remove-obs', id),
    renameObs: (id, name) => ipcRenderer.invoke('rename-obs', { id, name }),
    moveObs: (id, delta) => ipcRenderer.invoke('move-obs', { id, delta }),
    connectObs: (id, password) => ipcRenderer.invoke('obs-connect', { id, password }),
    disconnectObs: (id) => ipcRenderer.invoke('obs-disconnect', id),
    setStreaming: (id, on) => ipcRenderer.invoke('set-streaming', { id, on }),

    // GreenSplit. The pasted Connection URL goes one way: its token is kept in the main process and never sent back.
    connectGreenSplit: (connectionUrl) => ipcRenderer.invoke('connect-greensplit', connectionUrl),
    disconnectGreenSplit: () => ipcRenderer.invoke('disconnect-greensplit'),
    forgetGreenSplit: () => ipcRenderer.invoke('forget-greensplit'),

    getOverlays: () => ipcRenderer.invoke('get-overlays'),
    getScenes: () => ipcRenderer.invoke('get-scenes'),
    addOverlayToObs: (options) => ipcRenderer.invoke('add-overlay-to-obs', options),

    // The dashboard window. The renderer only asks for it to open — it never gets a handle to that window, and
    // that window never gets this bridge (it loads the remote site and must stay untrusted).
    getDashboards: () => ipcRenderer.invoke('get-dashboards'),
    openDashboard: (dashboardId) => ipcRenderer.invoke('open-dashboard', dashboardId),

    // Linked streaming platforms. Read-only here — changing them happens on the website.
    getPlatforms: () => ipcRenderer.invoke('get-platforms'),
    openIntegrations: () => ipcRenderer.invoke('open-integrations'),

    // Stream templates. The renderer edits plain objects; the main process owns the credential and the calls.
    getStreamTemplates: () => ipcRenderer.invoke('get-stream-templates'),
    saveStreamTemplate: (id, template) => ipcRenderer.invoke('save-stream-template', { id, template }),
    deleteStreamTemplate: (id) => ipcRenderer.invoke('delete-stream-template', id),
    applyStreamTemplate: (id) => ipcRenderer.invoke('apply-stream-template', id),
    searchTwitchCategories: (query) => ipcRenderer.invoke('search-twitch-categories', query),

    // Updates. The renderer can ask for a check and can apply a downloaded one; it never sees a URL or a file,
    // and cannot make the app install anything that electron-updater has not already verified by checksum.
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    restartForUpdate: () => ipcRenderer.invoke('restart-for-update'),

    // Push channels. Each returns an unsubscribe so a re-render cannot stack duplicate listeners.
    onState: (handler) => {
        const listener = (_event, payload) => handler(payload);
        ipcRenderer.on('state', listener);
        return () => ipcRenderer.removeListener('state', listener);
    },
    onLog: (handler) => {
        const listener = (_event, line) => handler(line);
        ipcRenderer.on('log', listener);
        return () => ipcRenderer.removeListener('log', listener);
    },
    onObsStatus: (handler) => {
        const listener = (_event, status) => handler(status);
        ipcRenderer.on('obs-status', listener);
        return () => ipcRenderer.removeListener('obs-status', listener);
    },
    onGreenSplitStatus: (handler) => {
        const listener = (_event, status) => handler(status);
        ipcRenderer.on('greensplit-status', listener);
        return () => ipcRenderer.removeListener('greensplit-status', listener);
    },
    onUpdateStatus: (handler) => {
        const listener = (_event, status) => handler(status);
        ipcRenderer.on('update-status', listener);
        return () => ipcRenderer.removeListener('update-status', listener);
    },
    // How an "Add account" ended: `{ ok, username }` or `{ ok: false, error }`, the words to show.
    onAddAccountDone: (handler) => {
        const listener = (_event, outcome) => handler(outcome);
        ipcRenderer.on('add-account-done', listener);
        return () => ipcRenderer.removeListener('add-account-done', listener);
    },
});
