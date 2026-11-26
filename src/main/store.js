'use strict';

const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Settings and credential storage.
 *
 * Each account's LBCBot credential, the OBS websocket password and the GreenSplit access token are encrypted with Electron's
 * `safeStorage`, which is backed by the OS keychain (Keychain on macOS, DPAPI on Windows, libsecret on Linux).
 * Deliberately not `keytar`: that is an unmaintained native module that needs rebuilding per Electron version, and
 * safeStorage covers the same ground with nothing to compile.
 *
 * Non-secret settings sit in plaintext in the same file so they stay readable when debugging a user's setup — the
 * point of encryption here is the secrets, not the window size.
 */

const sites = require('./sites');
const accounts = require('./accounts');

const FILE = () => path.join(app.getPath('userData'), 'settings.json');

const DEFAULTS = {
    obsUrl: 'ws://127.0.0.1:4455',
    /** The name of the PC at obsUrl when it was picked from "Find OBS on my network": empty for a typed address. */
    obsName: '',
    /** Whether obsUrl is this PC, as the scan found it ("This PC" on the card). */
    obsLocal: true,
    /**
     * Names given to OBS PCs in the app, keyed by address: `{ "10.0.0.88": "Streaming PC" }`. They beat the name the
     * network reports, which beats the bare address, and outlive a new scan.
     */
    obsNames: {},
    autoConnectObs: true,
    forwardObsEvents: true,
    /**
     * GreenSplit's Connection URL WITHOUT its `token` — the token is a secret (below). Empty until set up. The LiveSplit
     * adapter shares this URL's host; only its port is a setting.
     */
    greensplitUrl: '',
    greensplitLivesplitPort: 16834,
    /**
     * Whether GreenSplit is on: Connect sets it, Disconnect clears it, so a Disconnect survives a restart instead of
     * being undone by the launch auto-connect (which needs this AND autoConnectGreensplit).
     */
    greensplitEnabled: false,
    // Both only matter once a Connection URL is saved, so true from the start means "on as soon as it is set up".
    autoConnectGreensplit: true,
    forwardGreensplitEvents: true,
    /**
     * Per-dashboard window state, keyed by dashboardId:
     * `{ "<id>": { x, y, width, height, maximized, open } }`.
     *
     * `open` records whether the window was still up when the app QUIT, which is what gets reopened next
     * launch. Closing a dashboard by hand clears it — otherwise "close this one" would be undone on every
     * restart, which is indistinguishable from the close not working.
     */
    dashboardWindows: {},
    /**
     * The accounts this machine is signed in to (accounts.js): `[{ id, userId, username, platform, credential }]`,
     * each credential encrypted, and the id of the one in use. Never sent to a renderer as they are: `accounts()` answers
     * the rows without their credentials.
     */
    accounts: [],
    activeAccount: null,
};

/** Keys only this module writes: a renderer's settings patch never reaches them, and `settings()` never answers them. */
const PRIVATE = ['credential', 'obsPassword', 'greensplitToken', 'accounts', 'activeAccount'];
const without = (object, keys) => Object.fromEntries(Object.entries(object || {}).filter(([key]) => !keys.includes(key)));

let cache = null;

function read() {
    if (cache) {
        return cache;
    }
    try {
        const stripped = sites.stripEndpointSettings(JSON.parse(fs.readFileSync(FILE(), 'utf8')));
        // The single credential from before several accounts becomes the first account, still encrypted.
        const migrated = accounts.migrate(stripped.settings);
        cache = { ...DEFAULTS, ...migrated.settings };
        if (stripped.changed || migrated.changed) {
            write(); // drop the retired apiUrl/siteUrl keys; move the old credential into the list
        }
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
 * The secrets, decrypted once at startup (`load`) and kept in memory: safeStorage's synchronous methods are
 * deprecated in Electron 45 and gone in 46, while a dashboard window asks for a token over IPC that must not wait on the
 * keychain. A write updates the memory copy at once and persists the encrypted form when the keychain answers.
 * `credentials` holds each account's, by account id.
 */
const SECRETS = ['obsPassword', 'greensplitToken'];
const secrets = { obsPassword: null, greensplitToken: null };
const credentials = new Map();

/**
 * Encrypt a secret for storage. Falls back to plaintext with a loud warning when the OS has no usable keychain
 * (headless Linux, mainly) — failing closed there would make the app unusable for a reason the user cannot fix,
 * but it must never be silent.
 */
async function encrypt(value) {
    if (!value) {
        return null;
    }
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
        console.warn('[store] OS encryption unavailable — storing secret in PLAINTEXT');
        return { plaintext: value };
    }
    return { encrypted: (await safeStorage.encryptStringAsync(value)).toString('base64') };
}

/** The stored secret's text, and whether the keychain asks for it to be encrypted again. */
async function decrypt(stored) {
    if (!stored) {
        return { value: null };
    }
    if (stored.plaintext) {
        return { value: stored.plaintext };
    }
    if (!stored.encrypted) {
        return { value: null };
    }
    try {
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(stored.encrypted, 'base64'));
        return { value: result, shouldReEncrypt };
    } catch (error) {
        // A keychain that cannot decrypt its own blob means the user's keychain or OS account changed. Treat it as
        // "not connected" so the UI offers a reconnect, rather than retrying a secret that will never decrypt.
        console.warn('[store] could not decrypt a stored secret — treating as absent');
        return { value: null };
    }
}

/** Set a secret: in memory now, encrypted on disk once the keychain answers. Resolves when it is persisted. */
async function setSecret(name, value) {
    read();
    secrets[name] = value || null;
    const encrypted = await encrypt(secrets[name]);
    // A later set may have landed while this one was encrypting; only the newest value is written.
    if (secrets[name] === (value || null)) {
        cache[name] = encrypted;
        write();
    }
}

/** Set one account's credential (null: LBCBot refused it, the row stays signed out). Resolves when persisted. */
async function setAccountCredential(id, value) {
    if (!read().accounts.some((r) => r.id === id)) {
        return;
    }
    credentials.set(id, value || null);
    const encrypted = await encrypt(value || null);
    const row = cache.accounts.find((r) => r.id === id);
    // As above: only the newest value is written, and never onto a row removed meanwhile.
    if (row && credentials.get(id) === (value || null)) {
        row.credential = encrypted;
        write();
    }
}

const signedIn = (row) => Boolean(credentials.get(row.id));

module.exports = {
    /** Decrypt the stored secrets into memory. Await once, after app ready and before anything reads one. */
    async load() {
        const stored = read();
        for (const name of SECRETS) {
            const { value, shouldReEncrypt } = await decrypt(stored[name]);
            secrets[name] = value;
            if (shouldReEncrypt) {
                await setSecret(name, value);
            }
        }
        for (const row of stored.accounts) {
            const { value, shouldReEncrypt } = await decrypt(row.credential);
            credentials.set(row.id, value);
            if (shouldReEncrypt) {
                await setAccountCredential(row.id, value);
            }
        }
    },

    /** The site and API endpoints: fixed when packaged, env-overridable from source. Every reader goes through this. */
    endpoints() {
        return sites.resolveEndpoints(app.isPackaged, process.env);
    },

    settings() {
        return without(read(), PRIVATE);
    },

    update(patch) {
        read();
        // Secrets and the accounts change only through their own setters, which encrypt: a settings patch carrying one
        // is not obeyed.
        Object.assign(cache, sites.stripEndpointSettings(without(patch, PRIVATE)).settings);
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

    // ---------------------------------------------------------------- accounts (accounts.js)

    /** The accounts, without their credentials: `[{ id, userId, username, platform, active, signedOut }]`. */
    accounts() {
        const { accounts: list, activeAccount } = read();
        return list.map((row) => accounts.publicRow(row, activeAccount, signedIn(row)));
    },

    activeAccountId() {
        return read().activeAccount || null;
    },

    /** Whether there is room for one more account (one already listed can always be signed in again). */
    accountsFull() {
        return read().accounts.length >= accounts.MAX_ACCOUNTS;
    },

    /** An account's credential: the active one's when no id is given. */
    getCredential(id = read().activeAccount) {
        return (id && credentials.get(id)) || null;
    },

    /**
     * Forget the credential LBCBot just refused, leaving its row signed out. Only that credential: one the account was
     * signed in with again meanwhile stays.
     */
    signOutAccount(id, refused) {
        if (!id || credentials.get(id) !== refused) {
            return Promise.resolve();
        }
        return setAccountCredential(id, null);
    },

    /**
     * List a newly approved account and make it the active one (accounts.add): `{ id, replaced, full }`, where `replaced`
     * is the credential the same account had here before (to revoke) and `full` means nothing was added.
     */
    async addAccount(profile, credential) {
        // Encrypted first, so the row is written once, whole: a quit midway cannot leave it listed with no credential.
        const blob = await encrypt(credential);
        read();
        const result = accounts.add(cache.accounts, profile, blob);
        if (result.full) {
            return { id: null, replaced: null, full: true };
        }
        const replaced = result.replaced !== null ? credentials.get(result.id) || null : null;
        cache.accounts = result.list;
        cache.activeAccount = result.id;
        credentials.set(result.id, credential);
        write();
        return { id: result.id, replaced, full: false };
    },

    /** Bring an account's name, platform or user id up to date. True when something changed. */
    updateAccount(id, profile) {
        read();
        const next = accounts.update(cache.accounts, id, profile);
        if (next === cache.accounts) {
            return false;
        }
        cache.accounts = next;
        write();
        return true;
    },

    /** Make a listed account the active one. False for an id that names no row. */
    setActiveAccount(id) {
        read();
        if (!cache.accounts.some((r) => r.id === id)) {
            return false;
        }
        if (cache.activeAccount !== id) {
            cache.activeAccount = id;
            write();
        }
        return true;
    },

    /**
     * Forget an account here, credential and all. Answers `{ credential, active }`: the credential it held (to revoke)
     * and the account active now (another, when it was the one in use, or null).
     */
    removeAccount(id) {
        read();
        const credential = credentials.get(id) || null;
        const { list, active } = accounts.remove(cache.accounts, id, cache.activeAccount, signedIn);
        cache.accounts = list;
        cache.activeAccount = active;
        credentials.delete(id);
        write();
        return { credential, active };
    },

    getObsPassword() {
        return secrets.obsPassword;
    },

    setObsPassword(value) {
        return setSecret('obsPassword', value);
    },

    getGreensplitToken() {
        return secrets.greensplitToken;
    },

    setGreensplitToken(value) {
        return setSecret('greensplitToken', value);
    },

    /** Whether the active account has a usable credential. */
    hasCredential() {
        return Boolean(module.exports.getCredential());
    },
};
