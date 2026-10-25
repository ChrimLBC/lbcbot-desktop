'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The screen-share chooser's only capabilities: list the sources, pick one.
 *
 * Deliberately no general ipcRenderer surface — this window renders thumbnails of everything on the user's
 * screen, so it gets the narrowest bridge in the app.
 */
contextBridge.exposeInMainWorld('picker', {
    sources: () => ipcRenderer.invoke('picker-sources'),
    choose: (id) => ipcRenderer.invoke('picker-choose', id),
});
