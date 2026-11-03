'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyTwitchPasskeyPolicy, withPasskeysOff } = require('../src/main/twitchPasskeys');

const POLICY = 'publickey-credentials-get=()';

/** A session that hands back the listener applyTwitchPasskeyPolicy registers. */
function register() {
    const seen = {};
    applyTwitchPasskeyPolicy({
        webRequest: {
            onHeadersReceived: (filter, listener) => {
                seen.filter = filter;
                seen.listener = listener;
            },
        },
    });
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

test('anything else passes through untouched', () => {
    const { listener } = register();
    for (const resourceType of ['xhr', 'script', 'image', 'webSocket']) {
        let answer;
        listener({ resourceType, responseHeaders: {} }, (value) => { answer = value; });
        assert.deepEqual(answer, {});
    }
});
