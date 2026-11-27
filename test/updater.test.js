'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// updater.js reads `app` from electron at load; give it a stand-in so the pure helpers load under plain Node.
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
    if (request === 'electron') return { app: { getVersion: () => '0.0.0', isPackaged: false } };
    return realLoad.call(this, request, ...rest);
};
const { friendlyUpdateError, FEED_URL } = require('../src/main/updater');
Module._load = realLoad;

const GITHUB = "Couldn't reach GitHub to check for updates. Try again in a few minutes.";
const OTHER = "Couldn't check for updates. Try again later.";

test('GitHub being slow or down reads as one short line, not the raw error', () => {
    // The real 2026-11-27 message, cut down: a 504 from the releases page with headers and a whole Atom feed after it.
    const raw = 'Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/ChrimLBC/'
        + 'lbcbot-desktop/releases/latest), please ensure a production release exists: HttpError: 504 "method: GET url: '
        + '..." Headers: { "content-type": "text/html" } XML: <?xml version="1.0"?><feed>…</feed>';
    assert.equal(friendlyUpdateError(new Error(raw)), GITHUB);
    assert.equal(friendlyUpdateError(Object.assign(new Error('connect'), { code: 'ETIMEDOUT' })), GITHUB);
    assert.equal(friendlyUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED')), GITHUB);
    assert.equal(friendlyUpdateError(new Error('getaddrinfo ENOTFOUND github.com')), GITHUB);
});

test('anything else still gets a short line', () => {
    assert.equal(friendlyUpdateError(new Error('sha512 checksum mismatch')), OTHER);
    assert.equal(friendlyUpdateError('weird'), OTHER);
    assert.equal(friendlyUpdateError(undefined), OTHER);
    // A number that merely contains 5xx digits is not an HTTP status.
    assert.equal(friendlyUpdateError(new Error('expected size 15042')), OTHER);
});

test('the feed is the latest-release download folder, not the releases page', () => {
    assert.equal(FEED_URL, 'https://github.com/ChrimLBC/lbcbot-desktop/releases/latest/download');
});
