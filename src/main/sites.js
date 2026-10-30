'use strict';

/**
 * Where LBCBot lives, and the pure rules about it. No Electron import, so `npm test` runs it under plain node.
 *
 * The site moved from lbcbot.devsoperative.com to lbcbot.com (API: lbcbotapi.devsoperative.com to api.lbcbot.com).
 * The old site host 301-redirects to the new one, so for a while a page on one host navigates to the other, and the
 * app must treat both as "the site". The old API host keeps serving, which is why a customised apiUrl is never touched.
 */

const DEFAULT_SITE_URL = 'https://lbcbot.com';
const DEFAULT_API_URL = 'https://api.lbcbot.com';

/** The previous defaults. A saved value EXACTLY equal to one of these was never customised and is rewritten. */
const LEGACY_SITE_URL = 'https://lbcbot.devsoperative.com';
const LEGACY_API_URL = 'https://lbcbotapi.devsoperative.com';

/** Hosts that are "the site" while the old one redirects to the new one. */
const SITE_HOSTS = [new URL(DEFAULT_SITE_URL).host, new URL(LEGACY_SITE_URL).host];

/**
 * One-time settings migration: swap the old default site/API URL for the new one. Pure and idempotent.
 * Returns `{ settings, changed }`; `settings` is the same object when nothing changed.
 */
function migrateSettings(saved) {
    if (!saved || typeof saved !== 'object') {
        return { settings: saved, changed: false };
    }
    const next = { ...saved };
    let changed = false;
    if (next.siteUrl === LEGACY_SITE_URL) {
        next.siteUrl = DEFAULT_SITE_URL;
        changed = true;
    }
    if (next.apiUrl === LEGACY_API_URL) {
        next.apiUrl = DEFAULT_API_URL;
        changed = true;
    }
    return { settings: changed ? next : saved, changed };
}

/**
 * Is `host` (as in URL.host) the site? The configured site's host always is; when that is one of the two production
 * hosts, so is the other. A custom site (localhost, a staging box) matches only itself.
 */
function isSiteHost(host, configuredSiteUrl) {
    if (!host) {
        return false;
    }
    let configured = null;
    try {
        configured = new URL(configuredSiteUrl).host;
    } catch {
        return false;
    }
    if (host === configured) {
        return true;
    }
    return SITE_HOSTS.includes(configured) && SITE_HOSTS.includes(host);
}

module.exports = { DEFAULT_SITE_URL, DEFAULT_API_URL, LEGACY_SITE_URL, LEGACY_API_URL, SITE_HOSTS, migrateSettings, isSiteHost };
