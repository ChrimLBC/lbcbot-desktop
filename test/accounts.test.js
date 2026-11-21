'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('../src/main/accounts');

const row = (id, userId, extra = {}) => ({ id, userId, username: `u${userId}`, platform: 'TWITCH', credential: `c${id}`, ...extra });

test('the single credential of an older version becomes the first, active account, blob unchanged', () => {
    const { settings, changed } = a.migrate({ obsUrl: 'ws://x', credential: { encrypted: 'abc' } });
    assert.equal(changed, true);
    assert.equal('credential' in settings, false);
    assert.equal(settings.accounts.length, 1);
    assert.deepEqual(settings.accounts[0].credential, { encrypted: 'abc' });
    assert.equal(settings.activeAccount, settings.accounts[0].id);
    assert.equal(settings.accounts[0].userId, null);
    assert.equal(settings.obsUrl, 'ws://x');
});

test('a migrated file comes back unchanged; an empty credential leaves no row', () => {
    const done = { accounts: [row('a', '1')], activeAccount: 'a' };
    assert.equal(a.migrate(done).changed, false);
    const { settings } = a.migrate({ credential: null });
    assert.deepEqual(settings.accounts, []);
    assert.equal(a.migrate({}).changed, false);
});

test('an active id naming no row falls back to the first', () => {
    const { settings, changed } = a.migrate({ accounts: [row('a', '1'), row('b', '2')], activeAccount: 'gone' });
    assert.equal(changed, true);
    assert.equal(settings.activeAccount, 'a');
});

test('adding a new user appends a row with a random id; the same user again keeps its row and returns the old credential', () => {
    const first = a.add([], { userId: 7, username: 'Ava', platform: 'TWITCH' }, 'blob1');
    assert.equal(first.list.length, 1);
    assert.match(first.id, /^[0-9a-f]{12}$/);
    assert.equal(first.list[0].userId, '7');
    const again = a.add([...first.list, row('z', '9')], { userId: '7', username: 'Ava2' }, 'blob2');
    assert.equal(again.list.length, 2);
    assert.equal(again.id, first.id);
    assert.equal(again.replaced, 'blob1');
    assert.equal(again.list[0].credential, 'blob2');
    assert.equal(again.list[0].username, 'Ava2');
    assert.equal(again.list[0].platform, 'TWITCH');
});

test('a full list refuses a new user but still takes one already listed', () => {
    const full = ['a', 'b', 'c', 'd', 'e'].map((id, i) => row(id, String(i + 1)));
    assert.equal(full.length, a.MAX_ACCOUNTS);
    const refused = a.add(full, { userId: '99' }, 'x');
    assert.equal(refused.full, true);
    assert.equal(refused.list, full);
    const resigned = a.add(full, { userId: '3' }, 'x');
    assert.equal(resigned.full, false);
    assert.equal(resigned.id, 'c');
});

test('a migrated row with no userId yet is never matched by a new add', () => {
    const list = [{ id: 'old', userId: null, credential: 'c' }];
    assert.equal(a.add(list, { userId: '5' }, 'n').list.length, 2);
});

test('a signed-out row from before the list, whose user was never learned, is taken by the next sign-in', () => {
    const list = [row('a', '1'), { id: 'old', userId: null, credential: null }];
    const added = a.add(list, { userId: '5', username: 'Five' }, 'n');
    assert.equal(added.list.length, 2);
    assert.equal(added.id, 'old');
    assert.equal(added.list[1].userId, '5');
    assert.equal(added.list[1].credential, 'n');
});

test('a single credential written by an older build after the move joins the list; past the cap it is left in place', () => {
    const { settings, changed } = a.migrate({ accounts: [row('a', '1')], activeAccount: 'a', credential: { encrypted: 'new' } });
    assert.equal(changed, true);
    assert.equal('credential' in settings, false);
    assert.equal(settings.accounts.length, 2);
    assert.deepEqual(settings.accounts[1].credential, { encrypted: 'new' });
    assert.equal(settings.activeAccount, 'a');
    const full = ['a', 'b', 'c', 'd', 'e'].map((id, i) => row(id, String(i + 1)));
    const kept = a.migrate({ accounts: full, activeAccount: 'a', credential: { encrypted: 'new' } });
    assert.deepEqual(kept.settings.credential, { encrypted: 'new' });
    assert.equal(kept.settings.accounts.length, 5);
});

test('update changes only the keys given and keeps the same list when nothing moved', () => {
    const list = [row('a', '1')];
    assert.equal(a.update(list, 'a', { username: 'u1' }), list);
    assert.equal(a.update(list, 'missing', { username: 'x' }), list);
    assert.equal(a.update(list, 'a', { username: '' }), list);
    const next = a.update(list, 'a', { username: 'New', userId: 1 });
    assert.notEqual(next, list);
    assert.equal(next[0].username, 'New');
    assert.equal(next[0].userId, '1');
    assert.equal(next[0].credential, 'ca');
});

test('removing the active account moves to the next signed-in one after it, else before, else none', () => {
    const list = [row('a', '1'), row('b', '2'), row('c', '3', { credential: null }), row('d', '4')];
    const signedIn = (r) => !!r.credential;
    assert.deepEqual(a.remove(list, 'b', 'b', signedIn).active, 'd'); // c is signed out
    assert.deepEqual(a.remove(list, 'd', 'd', signedIn).active, 'b'); // nothing after: the nearest before
    assert.equal(a.remove(list, 'b', 'a', signedIn).active, 'a'); // not the active one: unchanged
    assert.equal(a.remove(list, 'b', 'a', signedIn).list.length, 3);
    assert.equal(a.remove([row('a', '1')], 'a', 'a', signedIn).active, null);
    assert.equal(a.remove(list, 'zz', 'a', signedIn).list, list);
});

test('a public row never carries the credential', () => {
    const out = a.publicRow(row('a', 5), 'a', true);
    assert.deepEqual(out, { id: 'a', userId: '5', username: 'u5', platform: 'TWITCH', active: true, signedOut: false });
    assert.equal(JSON.stringify(out).includes('ca'), false);
    assert.equal(a.publicRow(row('b', 6), 'a', false).signedOut, true);
});
