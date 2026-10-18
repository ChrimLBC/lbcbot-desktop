'use strict';

const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Settings and credential storage.
 *
 * The LBCBot credential and the OBS websocket password are encrypted with Electron's `safeStorage`, which is backed
 * by the OS keychain (Keychain on macOS, DPAPI on Windows, libsecret on Linux). Deliberately not `keytar`: that is an
 * unmaintained native module that needs rebuilding per Electron version, and safeStorage covers the same ground with
 * nothing to compile.
 *
 * Non-secret settings sit in plaintext in the same file so they stay readable when debugging a user's setup — the
 * point of encryption here is the two secrets, not the window size.
 */

const FILE = () => path.join(app.getPath('userData'), 'settings.json');

const DEFAULTS = {
    apiUrl: 'https://lbcbotapi.devsoperative.com',
    // The WEBSITE, not the API — the dashboard window loads a page, and the two live on different hosts in
    // every environment. Kept separate from apiUrl for that reason rather than derived from it.
    siteUrl: 'https://lbcbot.devsoperative.com',
    obsUrl: 'ws://127.0.0.1:4455',
    autoConnectObs: true,
    forwardObsEvents: true,
    /**
     * Per-dashboard window state, keyed by dashboardId:
     * `{ "<id>": { x, y, width, height, maximized, open } }`.
     *
     * `open` records whether the window was still up when the app QUIT, which is what gets reopened next
     * launch. Closing a dashboard by hand clears it — otherwise "close this one" would be undone on every
     * restart, which is indistinguishable from the close not working.
     */
    dashboardWindows: {},
};

let cache = null;

function read() {
    if (cache) {
        return cache;
    }
    try {
        cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE(), 'utf8')) };
    } catch (error) {
        cache = { ...DEFAULTS };
    }
    return cache;
}

function write() {
    try {
        fs.mkdirSync(path.dirname(FILE()), { recursive: true });
        fs.writeFileSync(FILE(), JSON.stringify(cache, null, 2), 'utf8');
    } catch (error) {
        console.error('[store] could not persist settings', error);
    }
}

/**
 * Encrypt a secret for storage. Falls back to plaintext with a loud warning when the OS has no usable keychain
 * (headless Linux, mainly) — failing closed there would make the app unusable for a reason the user cannot fix,
 * but it must never be silent.
 */
function encrypt(value) {
    if (!value) {
        return null;
    }
    if (!safeStorage.isEncryptionAvailable()) {
        console.warn('[store] OS encryption unavailable — storing secret in PLAINTEXT');
        return { plaintext: value };
    }
    return { encrypted: safeStorage.encryptString(value).toString('base64') };
}

function decrypt(stored) {
    if (!stored) {
        return null;
    }
    if (stored.plaintext) {
        return stored.plaintext;
    }
    if (!stored.encrypted) {
        return null;
    }
    try {
        return safeStorage.decryptString(Buffer.from(stored.encrypted, 'base64'));
    } catch (error) {
        // A keychain that cannot decrypt its own blob means the user's keychain or OS account changed. Treat it as
        // "not connected" so the UI offers a reconnect, rather than retrying a secret that will never decrypt.
        console.warn('[store] could not decrypt a stored secret — treating as absent');
        return null;
    }
}

module.exports = {
    settings() {
        const { credential, obsPassword, ...rest } = read();
        return rest;
    },

    update(patch) {
        read();
        Object.assign(cache, patch);
        write();
        return module.exports.settings();
    },

    /** Saved geometry + open-at-quit flag for one dashboard, or null if we have never shown it. */
    dashboardWindow(dashboardId) {
        const all = read().dashboardWindows || {};
        return all[String(dashboardId)] || null;
    },

    /** Merge a patch into one dashboard's window state. */
    saveDashboardWindow(dashboardId, patch) {
        read();
        if (!cache.dashboardWindows) {
            cache.dashboardWindows = {};
        }
        const key = String(dashboardId);
        cache.dashboardWindows[key] = { ...(cache.dashboardWindows[key] || {}), ...patch };
        write();
    },

    /** Dashboard ids that were open when the app last quit, in the order they were opened. */
    dashboardsToReopen() {
        const all = read().dashboardWindows || {};
        return Object.keys(all).filter((id) => all[id] && all[id].open);
    },

    getCredential() {
        return decrypt(read().credential);
    },

    setCredential(value) {
        read();
        cache.credential = encrypt(value);
        write();
    },

    getObsPassword() {
        return decrypt(read().obsPassword);
    },

    setObsPassword(value) {
        read();
        cache.obsPassword = encrypt(value);
        write();
    },

    hasCredential() {
        return Boolean(decrypt(read().credential));
    },
};
