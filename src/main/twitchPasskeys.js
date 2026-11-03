'use strict';

/**
 * Twitch's pages may not open the Windows passkey dialog.
 *
 * <h3>What happens without this</h3>
 *
 * Signed out, every Twitch page renders a login form and, about a second after loading, calls
 * `navigator.credentials.get({ mediation: 'conditional' })` with nobody having clicked anything. In Chrome that is
 * silent: saved passkeys are only offered in the username box's autofill list. Here it opens Windows Security's "Choose
 * a passkey" over the dashboard and disables the window behind it. The page asking is usually a Twitch card nobody can
 * see yet, because signed-out cards stay loaded under their veil to notice the sign-in, so a streamer who only opened a
 * dashboard finds it locked. Reported on 1.0.15: Cancel did not free the window. While a request is outstanding the app
 * cannot quit either. Reproduced on Windows with Electron 45, three signed-out pages in webviews.
 *
 * <h3>Why a response header</h3>
 *
 * This Electron carries no Chromium flag for conditional requests. Patching `navigator.credentials` from a preload would
 * work, but rewritten native functions are what browser-integrity checks look for, and Twitch's has refused this app
 * before (see watchForIntegrityRejection). `Permissions-Policy` leaves the page's JavaScript alone: the browser refuses
 * the request with a NotAllowedError, the same error type Twitch already handles, and the login form loads as normal.
 *
 * <h3>The cost</h3>
 *
 * Signing in to Twitch with a passkey does not work in this app. A header cannot tell an unprompted request from one a
 * person asked for, and leaving the sign-in window out would leave its login page free to raise the same dialog. The
 * password form is unaffected. Only twitch.tv is covered: it is the one site seen doing this, and a Google consent popup
 * may legitimately want a passkey.
 */
const POLICY = 'publickey-credentials-get=()';
const DOCUMENTS = new Set(['mainFrame', 'subFrame']);

/** The response's headers with passkeys off. Added last, because the last entry for a feature is the one that counts. */
function withPasskeysOff(responseHeaders) {
    const headers = { ...responseHeaders };
    const name = Object.keys(headers).find((key) => key.toLowerCase() === 'permissions-policy') || 'Permissions-Policy';
    headers[name] = [...[].concat(headers[name] || []), POLICY];
    return headers;
}

/** Call before any window on this session exists. Electron keeps one onHeadersReceived listener per session. */
function applyTwitchPasskeyPolicy(session) {
    session.webRequest.onHeadersReceived({ urls: ['https://*.twitch.tv/*'] }, (details, callback) => {
        if (!DOCUMENTS.has(details.resourceType)) {
            callback({});
            return;
        }
        callback({ responseHeaders: withPasskeysOff(details.responseHeaders) });
    });
}

module.exports = { applyTwitchPasskeyPolicy, withPasskeysOff };
