'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../src/main/sites');

test('old default site and api urls are rewritten', () => {
    const { settings, changed } = s.migrateSettings({ siteUrl: s.LEGACY_SITE_URL, apiUrl: s.LEGACY_API_URL, obsUrl: 'ws://x' });
    assert.equal(changed, true);
    assert.deepEqual(settings, { siteUrl: 'https://lbcbot.com', apiUrl: 'https://api.lbcbot.com', obsUrl: 'ws://x' });
});

test('each field migrates independently', () => {
    const a = s.migrateSettings({ siteUrl: s.LEGACY_SITE_URL, apiUrl: 'http://localhost:8081' });
    assert.equal(a.settings.siteUrl, s.DEFAULT_SITE_URL);
    assert.equal(a.settings.apiUrl, 'http://localhost:8081');
    const b = s.migrateSettings({ siteUrl: 'http://localhost:3000', apiUrl: s.LEGACY_API_URL });
    assert.equal(b.settings.siteUrl, 'http://localhost:3000');
    assert.equal(b.settings.apiUrl, s.DEFAULT_API_URL);
});

test('customised values are left alone, including near-misses', () => {
    for (const v of ['http://localhost:3000', 'https://lbcbot.devsoperative.com/', 'https://LBCBOT.devsoperative.com', 'https://lbcbot.com']) {
        const input = { siteUrl: v, apiUrl: v };
        const { settings, changed } = s.migrateSettings(input);
        assert.equal(changed, false);
        assert.equal(settings, input);
    }
});

test('absent keys are not invented, and the input is not mutated', () => {
    const input = { obsUrl: 'ws://x' };
    assert.deepEqual(s.migrateSettings(input), { settings: input, changed: false });
    const old = { siteUrl: s.LEGACY_SITE_URL };
    s.migrateSettings(old);
    assert.equal(old.siteUrl, s.LEGACY_SITE_URL);
});

test('idempotent', () => {
    const once = s.migrateSettings({ siteUrl: s.LEGACY_SITE_URL, apiUrl: s.LEGACY_API_URL }).settings;
    const twice = s.migrateSettings(once);
    assert.equal(twice.changed, false);
    assert.deepEqual(twice.settings, once);
});

test('non-objects pass through', () => {
    assert.deepEqual(s.migrateSettings(null), { settings: null, changed: false });
});

test('both production hosts are the site, whichever is configured', () => {
    for (const cfg of [s.DEFAULT_SITE_URL, s.LEGACY_SITE_URL]) {
        assert.equal(s.isSiteHost('lbcbot.com', cfg), true);
        assert.equal(s.isSiteHost('lbcbot.devsoperative.com', cfg), true);
    }
});

test('other hosts are not the site', () => {
    assert.equal(s.isSiteHost('lbcbotapi.devsoperative.com', s.DEFAULT_SITE_URL), false);
    assert.equal(s.isSiteHost('api.lbcbot.com', s.DEFAULT_SITE_URL), false);
    assert.equal(s.isSiteHost('evil-lbcbot.com', s.DEFAULT_SITE_URL), false);
    assert.equal(s.isSiteHost(null, s.DEFAULT_SITE_URL), false);
    assert.equal(s.isSiteHost('lbcbot.com', ''), false);
});

test('a custom site matches only itself', () => {
    assert.equal(s.isSiteHost('localhost:3000', 'http://localhost:3000'), true);
    assert.equal(s.isSiteHost('lbcbot.com', 'http://localhost:3000'), false);
    assert.equal(s.isSiteHost('localhost:3001', 'http://localhost:3000'), false);
});
