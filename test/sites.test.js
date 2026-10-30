'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../src/main/sites');

test('packaged builds use the fixed endpoints and ignore the environment', () => {
    const env = { LBCBOT_SITE_URL: 'http://localhost:3000', LBCBOT_API_URL: 'http://localhost:8081' };
    assert.deepEqual(s.resolveEndpoints(true, env), { siteUrl: 'https://lbcbot.com', apiUrl: 'https://api.lbcbot.com' });
    assert.deepEqual(s.resolveEndpoints(true), { siteUrl: 'https://lbcbot.com', apiUrl: 'https://api.lbcbot.com' });
});

test('from source the environment overrides, trimmed and without trailing slashes, else the fixed endpoints', () => {
    assert.deepEqual(s.resolveEndpoints(false, {}), { siteUrl: 'https://lbcbot.com', apiUrl: 'https://api.lbcbot.com' });
    assert.deepEqual(
        s.resolveEndpoints(false, { LBCBOT_SITE_URL: ' http://localhost:3000/ ', LBCBOT_API_URL: '' }),
        { siteUrl: 'http://localhost:3000', apiUrl: 'https://api.lbcbot.com' },
    );
});

test('saved apiUrl/siteUrl keys are stripped, other settings kept', () => {
    const { settings, changed } = s.stripEndpointSettings({ siteUrl: 'x', apiUrl: 'y', obsUrl: 'ws://x' });
    assert.equal(changed, true);
    assert.deepEqual(settings, { obsUrl: 'ws://x' });
});

test('stripping is idempotent, a no-op without the keys, and does not mutate', () => {
    const input = { obsUrl: 'ws://x' };
    assert.deepEqual(s.stripEndpointSettings(input), { settings: input, changed: false });
    const old = { siteUrl: 'x' };
    s.stripEndpointSettings(old);
    assert.equal(old.siteUrl, 'x');
    assert.equal(s.stripEndpointSettings(s.stripEndpointSettings(old).settings).changed, false);
    assert.deepEqual(s.stripEndpointSettings(null), { settings: null, changed: false });
});

test('both production hosts are the site, whichever is configured', () => {
    for (const cfg of [s.DEFAULT_SITE_URL, 'https://lbcbot.devsoperative.com']) {
        assert.equal(s.isSiteHost('lbcbot.com', cfg), true);
        assert.equal(s.isSiteHost('lbcbot.devsoperative.com', cfg), true);
    }
});

test('other hosts are not the site', () => {
    assert.equal(s.isSiteHost('lbcbotapi.devsoperative.com', s.DEFAULT_SITE_URL), false);
    assert.equal(s.isSiteHost('api.lbcbot.com', s.DEFAULT_SITE_URL), false);
    assert.equal(s.isSiteHost('evil-lbcbot.com', s.DEFAULT_SITE_URL), false);
    assert.equal(s.isSiteHost(null, s.DEFAULT_SITE_URL), false);
    assert.equal(s.isSiteHost('localhost:3000', ''), false);
});

test('a dev override host is ours as well as the production hosts', () => {
    assert.equal(s.isSiteHost('localhost:3000', 'http://localhost:3000'), true);
    assert.equal(s.isSiteHost('lbcbot.com', 'http://localhost:3000'), true);
    assert.equal(s.isSiteHost('localhost:3001', 'http://localhost:3000'), false);
});
