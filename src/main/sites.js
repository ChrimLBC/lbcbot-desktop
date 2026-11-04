'use strict';

/**
 * Where LBCBot lives, and the pure rules about it. No Electron import, so `npm test` runs it under plain node.
 *
 * The site moved from lbcbot.devsoperative.com to lbcbot.com (API: lbcbotapi.devsoperative.com to api.lbcbot.com).
 * The old site host 301-redirects to the new one, so for a while a page on one host navigates to the other, and the
 * app must treat both as "the site". The old API host keeps serving.
 */

const DEFAULT_SITE_URL = 'https://lbcbot.com';
const DEFAULT_API_URL = 'https://api.lbcbot.com';

/** Hosts that are always "the site": the old one redirects to the new one during the move. */
const SITE_HOSTS = [new URL(DEFAULT_SITE_URL).host, new URL('https://lbcbot.devsoperative.com').host];

const clean = (value) => (typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '');

/**
 * The ONE place the site and API endpoints are decided. A packaged build always uses the fixed production
 * endpoints and ignores the environment and anything saved. From source, LBCBOT_SITE_URL / LBCBOT_API_URL may
 * override them for local development.
 */
function resolveEndpoints(isPackaged, env = {}) {
    if (isPackaged) {
        return { siteUrl: DEFAULT_SITE_URL, apiUrl: DEFAULT_API_URL };
    }
    return {
        siteUrl: clean(env.LBCBOT_SITE_URL) || DEFAULT_SITE_URL,
        apiUrl: clean(env.LBCBOT_API_URL) || DEFAULT_API_URL,
    };
}

/** Drop the retired apiUrl/siteUrl keys from saved settings. Pure; `changed` says whether a rewrite is due. */
function stripEndpointSettings(saved) {
    if (!saved || typeof saved !== 'object' || !('apiUrl' in saved || 'siteUrl' in saved)) {
        return { settings: saved, changed: false };
    }
    const { apiUrl, siteUrl, ...rest } = saved;
    return { settings: rest, changed: true };
}

/**
 * Is `host` (as in URL.host) the site? Both production hosts always are, so the old host redirecting to the new one
 * stays in-app, and so is the host of the resolved site URL (a dev override such as localhost).
 */
function isSiteHost(host, siteUrl) {
    if (!host) {
        return false;
    }
    if (SITE_HOSTS.includes(host)) {
        return true;
    }
    try {
        return host === new URL(siteUrl).host;
    } catch {
        return false;
    }
}

/**
 * A link to our own site stays in the app unless it carries this marker, which asks for the system browser. It exists
 * for "Confirm it's you": the API refuses an app's credential for those actions outright (Sessions.Recent), so the only
 * way to finish one is a real browser session. Must match OPEN_IN_BROWSER in the web app's ReauthPrompt.
 */
const BROWSER_MARKER = '#open-in-browser';

/**
 * The address to hand the system browser if this link asks for it, without the marker; otherwise null.
 *
 * http(s) only, and this is the point of the check: the policy calling this also governs pages inside the Twitch
 * webviews, and `shell.openExternal` launches whatever handles a scheme, so `foo://lbcbot.com/#open-in-browser` must not
 * get through just because its host matches.
 */
function browserTarget(target) {
    try {
        const url = new URL(target);
        if (url.hash !== BROWSER_MARKER || !/^https?:$/.test(url.protocol)) {
            return null;
        }
        url.hash = '';
        return url.href;
    } catch {
        return null;
    }
}

/** Twitch's login page: where a dashboard card's sign-in button points, and where a sign-in ends up typing. */
function isTwitchLoginPage(target) {
    return /^https:\/\/www\.twitch\.tv\/login\/?(\?|$)/i.test(target || '');
}

module.exports = {
    DEFAULT_SITE_URL, DEFAULT_API_URL, SITE_HOSTS, resolveEndpoints, stripEndpointSettings, isSiteHost, browserTarget,
    isTwitchLoginPage,
};
