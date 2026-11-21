'use strict';

// A call made as one account never goes out as another: a switch that lands while the call waits for its token ends
// the call instead of sending it with the new account's token. lbcbot.js needs electron and the store, so both are
// stood in for here.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

let active = 'A';
const storeStub = {
    endpoints: () => ({ apiUrl: 'http://lbcbot.test' }),
    activeAccountId: () => active,
    getCredential: (id = active) => `cred-${id}`,
    setActiveAccount: (id) => { active = id; return true; },
    updateAccount: () => {},
    accounts: () => [],
};
const load = Module._load;
Module._load = function (request, parent, ...rest) {
    if (request === 'electron') return { shell: {} };
    if (request === './store' && parent && parent.filename === path.join(__dirname, '..', 'src', 'main', 'lbcbot.js')) return storeStub;
    return load.call(this, request, parent, ...rest);
};
let LbcBot;
try {
    ({ LbcBot } = require('../src/main/lbcbot'));
} finally {
    Module._load = load;
}

test('a switch while a call waits for its token ends the call: it is never sent as the new account', async () => {
    active = 'A';
    const sent = [];
    let releaseA;
    const realFetch = global.fetch;
    global.fetch = async (url, init) => {
        if (url.endsWith('/api/token')) {
            const { token } = JSON.parse(init.body);
            if (token === 'cred-A') await new Promise((resolve) => { releaseA = resolve; });
            const name = token.slice(5);
            return new Response(JSON.stringify({ accessToken: `jwt-${name}`, expiresIn: 900, userId: name }), { status: 200 });
        }
        sent.push(init.headers.Authorization);
        return new Response('{}', { status: 200 });
    };
    try {
        const bot = new LbcBot({});
        const call = bot.request('POST', '/users/overlay-keys', {});
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(typeof releaseA, 'function', "A's exchange is out");
        bot.useAccount('B');
        releaseA();
        const result = await call;
        assert.deepEqual(sent, [], 'nothing reached the API');
        assert.equal(result.ok, false);
        assert.equal(result.error, 'account_changed');
        // A call made after the switch goes out as B.
        const after = await bot.request('GET', '/users/dashboards');
        assert.equal(after.ok, true);
        assert.deepEqual(sent, ['Bearer jwt-B']);
    } finally {
        global.fetch = realFetch;
    }
});

test('a read answered after a switch is dropped; a write keeps its real outcome', async () => {
    active = 'A';
    const realFetch = global.fetch;
    const release = [];
    global.fetch = async (url, init) => {
        if (url.endsWith('/api/token')) {
            const name = JSON.parse(init.body).token.slice(5);
            return new Response(JSON.stringify({ accessToken: `jwt-${name}`, expiresIn: 900, userId: name }), { status: 200 });
        }
        await new Promise((resolve) => release.push(resolve));
        return new Response('[{"id":1}]', { status: 200 });
    };
    try {
        const bot = new LbcBot({});
        await bot.token(); // A's token in hand, so both calls go straight out
        const read = bot.request('GET', '/users/dashboard');
        const write = bot.request('PUT', '/users/stream-template', {});
        while (release.length < 2) await new Promise((resolve) => setImmediate(resolve));
        bot.useAccount('B');
        release.forEach((r) => r());
        const [r, w] = await Promise.all([read, write]);
        assert.equal(r.ok, false);
        assert.equal(r.error, 'account_changed', "A's list is never handed back as B's");
        assert.equal(w.ok, true, 'the write was done, as A');
    } finally {
        global.fetch = realFetch;
    }
});
