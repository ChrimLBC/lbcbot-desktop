'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyTwitchPasskeyPolicy, withPasskeysOff } = require('../src/main/twitchPasskeys');

const POLICY = 'publickey-credentials-get=()';

/** A session that hands back the listener applyTwitchPasskeyPolicy registers. */
function register(isSignInWindow = () => false) {
    const seen = {};
    applyTwitchPasskeyPolicy({
        webRequest: {
            onHeadersReceived: (filter, listener) => {
                seen.filter = filter;
                seen.listener = listener;
            },
        },
    }, isSignInWindow);
    return seen;
}

test('a response with no policy gets one', () => {
    assert.deepEqual(withPasskeysOff({ 'Content-Type': ['text/html'] }), {
        'Content-Type': ['text/html'],
        'Permissions-Policy': [POLICY],
    });
});

test('a policy the site sent is kept, whatever its case, with ours last so ours wins', () => {
    assert.deepEqual(withPasskeysOff({ 'permissions-policy': ['camera=()'] }), {
        'permissions-policy': ['camera=()', POLICY],
    });
    assert.deepEqual(withPasskeysOff({ 'PERMISSIONS-POLICY': 'camera=()' }), {
        'PERMISSIONS-POLICY': ['camera=()', POLICY],
    });
});

test('the response passed in is left as it was', () => {
    const original = { 'Permissions-Policy': ['camera=()'] };
    withPasskeysOff(original);
    assert.deepEqual(original, { 'Permissions-Policy': ['camera=()'] });
});

test('covers every twitch.tv host and nothing else', () => {
    assert.deepEqual(register().filter, { urls: ['https://*.twitch.tv/*'] });
});

test('page and iframe documents get the policy', () => {
    const { listener } = register();
    for (const resourceType of ['mainFrame', 'subFrame']) {
        let answer;
        listener({ resourceType, responseHeaders: {} }, (value) => { answer = value; });
        assert.deepEqual(answer, { responseHeaders: { 'Permissions-Policy': [POLICY] } });
    }
});

const SIGN_IN_WINDOW = 7;
const answerFor = (details) => {
    let answer;
    register((id) => id === SIGN_IN_WINDOW).listener({ responseHeaders: {}, ...details }, (value) => { answer = value; });
    return answer;
};
const REFUSED = { responseHeaders: { 'Permissions-Policy': [POLICY] } };

test('the sign-in window\'s page may ask', () => {
    assert.deepEqual(answerFor({ resourceType: 'mainFrame', webContentsId: SIGN_IN_WINDOW }), {});
});

test('any other window or card may not, even at the top of its own window', () => {
    assert.deepEqual(answerFor({ resourceType: 'mainFrame', webContentsId: 8 }), REFUSED);
});

test('a frame inside the sign-in window may not ask', () => {
    assert.deepEqual(answerFor({ resourceType: 'subFrame', webContentsId: SIGN_IN_WINDOW }), REFUSED);
});

test('a request that cannot say whose it is may not ask', () => {
    assert.deepEqual(answerFor({ resourceType: 'mainFrame' }), REFUSED);
});

test('anything else passes through untouched', () => {
    const { listener } = register();
    for (const resourceType of ['xhr', 'script', 'image', 'webSocket']) {
        let answer;
        listener({ resourceType, responseHeaders: {} }, (value) => { answer = value; });
        assert.deepEqual(answer, {});
    }
});
