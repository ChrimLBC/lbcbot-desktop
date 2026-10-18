'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The entire renderer-facing API surface.
 *
 * Deliberately narrow and verb-shaped rather than exposing `ipcRenderer` directly: the renderer never sees the
 * credential, never talks to OBS, and never calls the LBCBot API. With `contextIsolation` on and `nodeIntegration`
 * off, this list is the hard boundary — anything not named here is unreachable from the page.
 */
contextBridge.exposeInMainWorld('lbcbot', {
    getState: () => ipcRenderer.invoke('get-state'),
    updateSettings: (patch) => ipcRenderer.invoke('update-settings', patch),
    setObsPassword: (password) => ipcRenderer.invoke('set-obs-password', password),

    connectLbcbot: () => ipcRenderer.invoke('connect-lbcbot'),
    disconnectLbcbot: () => ipcRenderer.invoke('disconnect-lbcbot'),

    connectObs: () => ipcRenderer.invoke('connect-obs'),
    disconnectObs: () => ipcRenderer.invoke('disconnect-obs'),

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
    onUpdateStatus: (handler) => {
        const listener = (_event, status) => handler(status);
        ipcRenderer.on('update-status', listener);
        return () => ipcRenderer.removeListener('update-status', listener);
    },
    onDeviceCode: (handler) => {
        const listener = (_event, grant) => handler(grant);
        ipcRenderer.on('device-code', listener);
        return () => ipcRenderer.removeListener('device-code', listener);
    },
});
