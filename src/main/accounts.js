'use strict';

/**
 * The accounts this machine is signed in to, as plain data: one row per LBCBot account, each with its own device
 * credential (`lbc_dk_…`, kept encrypted by store.js), and one of them active. Plain Node, no Electron import, so the
 * rules are tested directly (test/accounts.test.js).
 *
 * A row on disk: `{ id, userId, username, platform, credential }`, where `credential` is the encrypted blob (or null
 * once LBCBot refused it: the row stays, signed out, until it is signed in again or removed). `id` is this app's own
 * handle for the row, random, never the credential or anything derived from it: it is what the pane and the dashboard
 * windows name an account by.
 *
 * Added 2026-11-20 (account switching, HANDOFF-account-switching decision 7). Until then the app kept ONE credential at
 * the top of settings.json; `migrate` moves it into the list as it is, still encrypted, so nobody connects again.
 */

const crypto = require('node:crypto');

/** As many as the website's account menu holds (LBCBot-frontend util/accounts MAX_ACCOUNTS). */
const MAX_ACCOUNTS = 5;

const newId = () => crypto.randomBytes(6).toString('hex');

const PROFILE_KEYS = ['userId', 'username', 'platform'];

/** A row as it may leave the main process: no credential, and whether it is signed in at all. */
function publicRow(row, active, signedIn) {
    return {
        id: row.id,
        userId: row.userId == null ? null : String(row.userId),
        username: row.username || null,
        platform: row.platform || null,
        active: row.id === active,
        signedOut: !signedIn,
    };
}

/**
 * Settings from before the list: the single `credential` becomes the first, active row (its encrypted blob moved as it
 * is). Answers `{ settings, changed }`; a file already migrated, or with nothing to migrate, comes back unchanged.
 */
function migrate(saved) {
    const settings = { ...(saved || {}) };
    let changed = false;
    if (!Array.isArray(settings.accounts)) {
        settings.accounts = [];
        changed = 'accounts' in (saved || {});
    }
    if ('credential' in settings) {
        const blob = settings.credential;
        // A list already here and a single credential too: an older build ran on this file since and connected. It
        // joins the list (whose it is is learned at its first exchange); past the cap it stays where it is, untouched,
        // rather than be dropped while still live at LBCBot.
        if (!blob || settings.accounts.length < MAX_ACCOUNTS) {
            delete settings.credential;
            changed = true;
        }
        if (blob && settings.accounts.length < MAX_ACCOUNTS && !settings.accounts.some((r) => JSON.stringify(r.credential) === JSON.stringify(blob))) {
            const id = newId();
            settings.accounts = [...settings.accounts, { id, userId: null, username: null, platform: null, credential: blob }];
            if (!settings.activeAccount) settings.activeAccount = id;
        }
    }
    // An active id that names no row (a hand-edited file): the first row, or none.
    if (settings.activeAccount && !settings.accounts.some((r) => r.id === settings.activeAccount)) {
        settings.activeAccount = settings.accounts.length ? settings.accounts[0].id : null;
        changed = true;
    }
    return { settings, changed };
}

/**
 * Put a newly approved account in the list. An account already listed (same user) keeps its row, place and id, and
 * takes the new credential: `replaced` is the credential it had, to revoke. A new one is added at the end, unless the
 * list is full (`full`: nothing changed). Either way it becomes the active one.
 *
 * `profile` is `{ userId, username, platform }`; `credential` is whatever the caller stores (the encrypted blob on disk).
 */
function add(list, profile, credential) {
    const userId = String(profile.userId);
    let at = list.findIndex((r) => r.userId != null && String(r.userId) === userId);
    if (at < 0) {
        // A row carried over from before the list that was refused before its first exchange told whose it was: signed
        // out, nobody's. Signing in again is almost always that account, so it takes the row rather than leave a dead one.
        at = list.findIndex((r) => r.userId == null && !r.credential);
    }
    if (at >= 0) {
        const old = list[at];
        const row = { ...old, ...pick(profile), userId, credential };
        const next = list.slice();
        next[at] = row;
        return { list: next, id: row.id, replaced: old.credential || null, full: false };
    }
    if (list.length >= MAX_ACCOUNTS) {
        return { list, id: null, replaced: null, full: true };
    }
    const row = { id: newId(), userId, username: null, platform: null, ...pick(profile), credential };
    return { list: [...list, row], id: row.id, replaced: null, full: false };
}

function pick(profile) {
    const out = {};
    PROFILE_KEYS.forEach((key) => {
        if (profile && profile[key] != null && profile[key] !== '') out[key] = key === 'userId' ? String(profile[key]) : profile[key];
    });
    return out;
}

/** A row's profile brought up to date from what LBCBot answered (only the keys it gave). Same list when nothing moved. */
function update(list, id, profile) {
    const patch = pick(profile);
    const at = list.findIndex((r) => r.id === id);
    if (at < 0 || PROFILE_KEYS.every((key) => !(key in patch) || list[at][key] === patch[key])) {
        return list;
    }
    const next = list.slice();
    next[at] = { ...list[at], ...patch };
    return next;
}

/**
 * The list without `id`, and which account is active after: the same one, or (when the active one left) the next
 * signed-in row after it, else the one before, else none. `signedIn(row)` says whether a row still has a credential.
 */
function remove(list, id, active, signedIn) {
    const at = list.findIndex((r) => r.id === id);
    if (at < 0) {
        return { list, active };
    }
    const next = list.filter((r) => r.id !== id);
    if (active !== id) {
        return { list: next, active };
    }
    const after = [...list.slice(at + 1), ...list.slice(0, at).reverse()].find((r) => signedIn(r));
    return { list: next, active: after ? after.id : null };
}

module.exports = { MAX_ACCOUNTS, migrate, add, update, remove, publicRow, newId };
