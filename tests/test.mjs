import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import * as plugin from '../index.js';

const storage = new Map();
let handler;
let calls;
let prompts;
beforeEach(() => {
  storage.clear(); calls = []; prompts = [];
  globalThis.host = {
    signInPrompt: value => prompts.push(value),
    storage: { get: key => storage.get(key), set: (key, value) => storage.set(key, value), remove: key => storage.delete(key) },
    crypto: { md5: value => createHash('md5').update(value).digest('hex') },
  };
  globalThis.fetch = async (address, options) => {
    const url = new URL(address); calls.push({ url, options });
    const result = await handler(url, options);
    return result instanceof Response ? result : Response.json(result);
  };
});
const ok = data => ({ ret: 200, data });
const album = { albumId: 123, albumTitle: '测试专辑', albumPic: 'cover.jpg', anchorName: '主播' };
const track = n => ({ trackId: n, title: `第${n}集`, albumId: 123, albumTitle: '测试专辑', duration: 90 });

// Search offsets may land in the middle of a service page after a short preceding result page.
test('search maps response fields, preserves milliseconds, and computes continuation from the service total', async () => {
  handler = url => {
    assert.equal(url.pathname, '/revision/search');
    assert.equal(url.searchParams.get('kw'), '三国 & 空格');
    assert.equal(url.searchParams.get('page'), '2');
    return ok({ result: { response: { docs: [track(1), track(2), track(3)], numFound: 23 } } });
  };
  const result = await plugin.search({ query: '三国 & 空格', kind: 'tracks', offset: 21 });
  assert.deepEqual(result.tracks.map(x => x.id), ['2', '3']);
  assert.equal(result.tracks[0].duration, 90000);
  assert.equal(result.tracks[0].showId, '123');
  assert.equal(result.more, false);
});

// Podcast detail must load the requested episode page rather than repeating page one.
test('show pagination returns all remaining episodes on the last page', async () => {
  handler = url => url.pathname.endsWith('/simple')
    ? ok({ albumPageMainInfo: { ...album, cover: 'cover.jpg' } })
    : (assert.equal(url.searchParams.get('num'), '2'), ok({ hasMore: false, tracksAudioPlay: [track(31), track(32)] }));
  const result = await plugin.show({ id: '123', offset: 30 });
  assert.equal(result.show.id, '123');
  assert.deepEqual(result.episodes.map(x => x.id), ['31', '32']);
  assert.equal(result.more, false);
});

// A successful HTTP response containing a service error must not become an empty results page.
test('service risk errors and malformed result shapes remain visible', async () => {
  handler = () => ok({ reason: 'risk invalid' });
  await assert.rejects(plugin.search({ query: '三国', kind: 'shows' }), /risk invalid/);
  handler = () => ok({});
  await assert.rejects(plugin.search({ query: '三国', kind: 'shows' }), /接口格式已变化/);
});

// Expired login is distinct from a transient network error, and sign-out clears only session state.
test('account lifecycle preserves network errors and clears expired sessions', async () => {
  assert.equal(await plugin.account(), null);
  storage.set('sessionCookie', '1&_token=test-session');
  handler = () => { throw new Error('network unavailable'); };
  await assert.rejects(plugin.account(), /network unavailable/);
  assert.ok(storage.has('sessionCookie'));
  handler = () => ({ ret: 50, msg: '请登录' });
  assert.equal(await plugin.account(), null);
  assert.equal(storage.has('sessionCookie'), false);
  await assert.rejects(plugin.browse({ page: 'subscriptions' }), error => error.code === 'signIn');
});

const qrId = 'ABCDEF0123456789ABCDEF0123456789';
const withSession = () => Response.json({ ret: 0 }, { headers: [
  ['Set-Cookie', '1&remember_me=test; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Path=/'],
  ['Set-Cookie', '1&_token=test-session==; Path=/; Secure; HttpOnly'],
  ['Set-Cookie', '1_l_flag=1; Path=/'],
] });
function immediatePolling(t) {
  t.mock.method(globalThis, 'setTimeout', callback => { queueMicrotask(callback); return 0; });
}
function encrypted(value) {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from('aaad3e4fd540b0f79dca95606e72bf93', 'hex'), null);
  return Buffer.concat([cipher.update(value), cipher.final()]).toString('base64url');
}
const playInfo = (url = 'https://a.xmcdn.com/audio.mp3') => ({ ret: 0,
  trackInfo: { isAuthorized: true, playUrlList: [{ type: 'MP3_64', url: encrypted(url), fileSize: 1234 }] } });

// The Mac client QR payload must be shown directly; a web-page URL is not its login QR.
test('Mac QR login waits for confirmation, preserves separate cookies, and verifies the account', async t => {
  immediatePolling(t);
  let checks = 0;
  handler = (url, options) => {
    if (url.pathname === '/web/qrCode/gen') {
      assert.equal(url.searchParams.get('source'), '喜马拉雅电脑版');
      return { ret: 0, qrId };
    }
    if (url.pathname.startsWith('/web/qrCode/check/')) {
      assert.equal(storage.has('sessionCookie'), false);
      return ++checks === 1 ? { ret: 32000 } : withSession();
    }
    assert.equal(url.pathname, '/pc-application-server/user/current/info');
    assert.match(options.headers.Cookie, /1&_token=test-session==/);
    assert.match(options.headers.Cookie, /1&remember_me=test/);
    assert.equal(options.headers.Cookie.includes('Expires='), false);
    return ok({ uid: 123, nickname: '测试用户' });
  };
  const me = await plugin.signIn();
  assert.equal(me.id, '123');
  assert.equal(checks, 2);
  const payload = new URL(prompts.find(x => x.qr).qr);
  assert.equal(payload.hostname, 'mobile.ximalaya.com');
  assert.equal(payload.pathname, `/passport-sign-mobile/qrcode/login/${qrId}/qrcode-7172636f6465`);
  assert.equal(payload.searchParams.get('to'), '喜马拉雅电脑版');
  assert.ok(storage.get('sessionCookie').includes('1&_token=test-session=='));
});

// A scan confirmation without Set-Cookie must not be treated as a successful login.
test('Mac QR login rejects a confirmation with no session token', async t => {
  immediatePolling(t);
  handler = url => url.pathname.endsWith('/gen') ? { ret: 0, qrId } : { ret: 0 };
  await assert.rejects(plugin.signIn(), /未返回登录凭据/);
  assert.equal(storage.size, 0);
});

// The token must be verified by the account endpoint before login succeeds.
test('failed QR account verification discards the new session', async t => {
  immediatePolling(t);
  handler = url => url.pathname.endsWith('/gen') ? { ret: 0, qrId }
    : url.pathname.includes('/check/') ? withSession() : { ret: 50 };
  await assert.rejects(plugin.signIn(), error => error.code === 'signIn');
  assert.equal(storage.size, 0);
});

// A QR can expire before scanning; only that documented response triggers a new QR.
test('Mac QR login refreshes an expired QR and displays the replacement', async t => {
  immediatePolling(t);
  let generations = 0;
  handler = url => url.pathname.endsWith('/gen') ? { ret: 0, qrId: (++generations === 1 ? qrId : 'B'.repeat(32)) }
    : url.pathname.includes('/check/') ? (generations === 1 ? { ret: 32001 } : withSession())
    : ok({ uid: 123, nickname: '测试用户' });
  await plugin.signIn();
  assert.equal(generations, 2);
  assert.equal(prompts.filter(x => x.qr).length, 2);
});

// Signing out while the poll is in flight cannot let its eventual response restore the session.
test('sign-out cancels an outstanding QR confirmation', async t => {
  immediatePolling(t);
  handler = url => {
    if (url.pathname.endsWith('/gen')) return { ret: 0, qrId };
    plugin.signOut();
    return withSession();
  };
  await assert.rejects(plugin.signIn(), /已取消/);
  assert.equal(storage.size, 0);
});

// Free episodes of paid albums are playable when the service authorizes them without a session.
test('free playback uses real MP3 candidates rather than misleading play_path fields', async () => {
  handler = (url, options) => {
    assert.ok(url.pathname.startsWith('/mobile-playpage/track/v3/baseInfo/'));
    assert.ok(options.headers['User-Agent'].startsWith('ting_'));
    assert.equal(options.headers.Cookie, undefined);
    return { ret: 0, trackInfo: { isPaid: true, isFree: true, isAuthorized: true, playUrlList: [
      { type: 'M4A_64', url: encrypted('https://a.xmcdn.com/he-aac.m4a') },
      { type: 'MP3_32', url: encrypted('https://a.xmcdn.com/low.mp3') },
      { type: 'MP3_64', url: encrypted('https://a.xmcdn.com/high.mp3') },
    ] } };
  };
  const stream = await plugin.stream({ id: '1', quality: 'standard' });
  assert.equal(stream.url, 'https://a.xmcdn.com/low.mp3');
  assert.equal(stream.type, 'mp3');
  assert.equal(stream.headers.Cookie, undefined);
});

// Metadata is not sufficient: an MP3 label cannot make an M4A file into a supported MP3.
test('playback refuses mismatched audio formats and untrusted hosts', async () => {
  handler = () => playInfo('https://a.xmcdn.com/he-aac.m4a');
  await assert.rejects(plugin.stream({ id: '1', quality: 'high' }), /实际格式不符/);
  handler = () => playInfo('https://a.xmcdn.com.evil.test/audio.mp3');
  await assert.rejects(plugin.stream({ id: '1', quality: 'high' }), /非预期/);
});

// Paid content still needs current entitlement, and account cookies must not accompany CDN requests.
test('authorized playback decodes a fresh URL and refuses unauthorized content', async () => {
  storage.set('sessionCookie', '1&_token=test-session');
  handler = (url, options) => {
    assert.equal(options.headers.Cookie, '1&_token=test-session');
    return playInfo('https://audiopay.cos.tx.xmcdn.com/test.mp3?token=fake');
  };
  const stream = await plugin.stream({ id: '2', quality: 'high' });
  assert.equal(stream.url, 'https://audiopay.cos.tx.xmcdn.com/test.mp3?token=fake');
  assert.equal(stream.headers.Cookie, undefined);
  assert.equal(stream.size, 1234);
  handler = url => url.hostname === 'pc.ximalaya.com' ? ok({ uid: 123, nickname: '测试用户' }) : { ret: 0, trackInfo: { isAuthorized: false } };
  await assert.rejects(plugin.stream({ id: '2' }), error => error.code === 'unavailable');
  plugin.signOut();
  await assert.rejects(plugin.stream({ id: '2' }), error => error.code === 'signIn');
});

// MyGo can skip a failed track without a toast; retain the cause without recording request tokens.
test('playback records a redacted failure and rethrows the original error', async () => {
  const original = new Error('network error https://a.xmcdn.com/file?token=private-token');
  handler = () => { throw original; };
  await assert.rejects(plugin.stream({ id: '123', quality: 'high' }), error => error === original);
  const record = storage.get('lastPlaybackError');
  assert.equal(record.trackId, '123');
  assert.equal(record.message.includes('private-token'), false);
  assert.match(record.message, /请求地址已省略/);
});

// Updated feeds contain individual tracks, not album groups with nested tracks.
test('updates maps flat feed items and keeps an empty feed a valid page', async () => {
  storage.set('sessionCookie', '1&_token=test-session');
  handler = () => ok({ feeds: [{ ...track(1), anchorNickName: '主播', coverPath: 'cover.jpg' }] });
  let page = await plugin.browse({ page: 'updates' });
  assert.equal(page.sections[0].tracks[0].artists[0].name, '主播');
  handler = () => ok({ feeds: [] });
  page = await plugin.browse({ page: 'updates' });
  assert.deepEqual(page.sections[0].tracks, []);
});

// Personal history excludes radio entries whose IDs are not ordinary episode IDs.
test('history separates audio episodes from radio records', async () => {
  storage.set('sessionCookie', '1&_token=test-session');
  handler = () => ok({ today: [{ type: 1, childId: 1, childTitle: '一', itemId: 123, itemTitle: '专辑', length: 12 }, { type: 2, childId: 9 }], yesterday: [], earlier: [], totalCount: 31 });
  const page = await plugin.browse({ page: 'history' });
  assert.equal(page.sections[0].links.length, 1);
  assert.equal(page.sections[0].links[0].page, 'history-episode:1');
  assert.equal((await plugin.recent())[0].duration, 12000);
  assert.equal(page.sections.at(-1).links[0].page, 'history:2');
});

test('history opens the current episode and following episodes in order', async () => {
  handler = url => {
    assert.equal(url.pathname, '/simple-revision-for-pc/play/v1/show');
    if (url.searchParams.get('ptype') === '1') {
      assert.equal(url.searchParams.get('id'), '2');
      return ok({ albumId: 123, pageNum: 5, hasMore: true, tracksAudioPlay: [track(1), track(2), track(3)] });
    }
    assert.equal(url.searchParams.get('id'), '123');
    assert.equal(url.searchParams.get('num'), '6');
    return ok({ hasMore: false, tracksAudioPlay: [track(4)] });
  };
  const page = await plugin.browse({ page: 'history-episode:2' });
  assert.deepEqual(page.sections[0].tracks.map(x => x.id), ['2', '3']);
  assert.equal(page.sections[1].links[0].page, 'history-next:123:6');
  const next = await plugin.browse({ page: page.sections[1].links[0].page });
  assert.deepEqual(next.sections[0].tracks.map(x => x.id), ['4']);
  handler = () => ok({ albumId: 123, pageNum: 1, tracksAudioPlay: [track(1)] });
  await assert.rejects(plugin.browse({ page: 'history-episode:2' }), /未返回历史记录对应的分集/);
});

// Route input cannot supply arbitrary request paths or nonnumeric identifiers.
test('invalid page and content IDs fail before a request is made', async () => {
  await assert.rejects(plugin.browse({ page: 'category:../etc/passwd' }), /无效/);
  await assert.rejects(plugin.browse({ page: 'vip:-1' }), /无效/);
  await assert.rejects(plugin.stream({ id: '1&trackId=2' }), /无效/);
  assert.equal(calls.length, 0);
});

// Discovery has a real public section even when personalized recommendations need login.
test('anonymous discovery shows the hot chart without requesting private recommendations', async () => {
  handler = url => {
    if (url.pathname.endsWith('/rankTabs')) return ok({ tabLists: [{ tabWraps: [{ name: '热播', rankingId: 99 }] }] });
    assert.ok(url.pathname.endsWith('/element'));
    return ok({ rankList: [{ albums: [album] }] });
  };
  const page = await plugin.home();
  assert.equal(page.sections[0].shows[0].id, '123');
  assert.equal(calls.length, 2);
});

// An unauthenticated membership page should prompt login, not look like an empty catalog.
test('membership requires login and uses the service continuation offset', async () => {
  await assert.rejects(plugin.browse({ page: 'vip' }), error => error.code === 'signIn');
  storage.set('sessionCookie', '1&_token=test-session');
  handler = () => ok({ items: Array.from({ length: 30 }, () => album), offset: 71 });
  const page = await plugin.browse({ page: 'vip' });
  assert.equal(page.sections[1].links[0].page, 'vip:71');
});

// A missing permission flag is a schema error, not an indication that content became free.
test('stream exposes changed permission metadata and unsupported lossless quality', async () => {
  handler = () => ({ ret: 0, trackInfo: {} });
  await assert.rejects(plugin.stream({ id: '1', quality: 'high' }), /缺少播放权限信息/);
  handler = () => ({ ret: 0, trackInfo: { isAuthorized: true, playUrlList: [] } });
  await assert.rejects(plugin.stream({ id: '1', quality: 'lossless' }), error => error.code === 'unavailable');
});

// A denied stream from an expired session needs a new login, not a claim that the account lacks a purchase.
test('denied playback distinguishes an expired session from missing entitlement', async () => {
  storage.set('sessionCookie', '1&_token=expired');
  handler = url => url.hostname === 'pc.ximalaya.com' ? { ret: 50 }
    : { ret: 0, trackInfo: { isAuthorized: false } };
  await assert.rejects(plugin.stream({ id: '123', quality: 'high' }), error => error.code === 'signIn');
  assert.equal(storage.has('sessionCookie'), false);
});

// A user who never confirms the QR must receive a timeout without committing a session.
test('unconfirmed QR login terminates at its deadline', async t => {
  immediatePolling(t);
  let now = 0;
  t.mock.method(Date, 'now', () => (now += 60000));
  handler = url => url.pathname.endsWith('/gen') ? { ret: 0, qrId } : { ret: 32000 };
  await assert.rejects(plugin.signIn(), /已超时/);
  assert.equal(storage.size, 0);
});

// A cancelled QR generation must not reopen a stale sign-in prompt when its request finishes.
test('sign-out during QR generation prevents a stale prompt', async () => {
  handler = () => { plugin.signOut(); return { ret: 0, qrId }; };
  await assert.rejects(plugin.signIn(), /已取消/);
  assert.equal(prompts.some(x => x.qr), false);
  assert.equal(storage.size, 0);
});

test('timed transcript decodes into synchronized lines and words', async () => {
  const k = Buffer.from('xmly&asr');
  const cipher = createCipheriv('des-ede3-ecb', Buffer.concat([k, k, k]), null);
  const plain = JSON.stringify([{ start: 100, end: 500, text: '你好', wordPieces: [{ start: 100, end: 300, word: '你' }, { start: 300, end: 500, word: '好' }] }]);
  const encoded = Buffer.concat([cipher.update(plain), cipher.final()]).toString('hex');
  handler = url => url.hostname === 'pc.ximalaya.com' ? ok({ aiDocumentUrl: 'http://a.xmcdn.com/subtitle.txt' }) : new Response(encoded);
  const result = await plugin.lyrics({ id: '123' });
  assert.equal(result.lines[0].text, '你好');
  assert.deepEqual(result.lines[0].words.map(x => x.start), [100, 300]);
  handler = () => ok({ aiDocumentUrl: '' });
  assert.deepEqual(await plugin.lyrics({ id: '123' }), { lines: [] });
  handler = () => ok({ aiDocumentUrl: 'https://a.xmcdn.com.evil.test/subtitle.txt' });
  await assert.rejects(plugin.lyrics({ id: '123' }), /非预期/);
});

// Subscription changes are sent to the same account endpoints as the desktop client.
test('subscribe and unsubscribe send a validated album ID and expose service failures', async () => {
  await assert.rejects(plugin.subscribeShow({ id: '123', on: true }), error => error.code === 'signIn');
  storage.set('sessionCookie', '1&_token=test-session');
  handler = (url, options) => {
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.headers.Cookie, '1&_token=test-session');
    assert.deepEqual(JSON.parse(options.body), { actionId: 123 });
    return { ret: 200, data: {} };
  };
  await plugin.subscribeShow({ id: '123', on: true });
  await plugin.subscribeShow({ id: '123', on: false });
  assert.match(calls.at(-2).url.pathname, /setSubscriptionAlbum$/);
  assert.match(calls.at(-1).url.pathname, /cancelSubscriptionAlbum$/);
  const count = calls.length;
  await assert.rejects(plugin.subscribeShow({ id: '123&x=1', on: true }), /无效/);
  await assert.rejects(plugin.subscribeShow({ id: '123', on: 'true' }), /无效/);
  assert.equal(calls.length, count);
  handler = () => ({ ret: 500, msg: '订阅失败' });
  await assert.rejects(plugin.subscribeShow({ id: '123', on: true }), /订阅失败/);
});

// Links and IDs must resolve to their actual episode or album instead of being searched as keywords.
test('search resolves Ximalaya album and episode links', async () => {
  handler = url => {
    if (url.pathname.endsWith('/album/v1/simple')) return ok({ albumPageMainInfo: { ...album, cover: 'cover.jpg' } });
    if (url.pathname.endsWith('/play/v1/show')) return ok({ hasMore: false, tracksAudioPlay: [track(1)] });
    if (url.pathname.endsWith('/track/simple')) return ok({ trackInfo: { trackId: 1, title: '单集', duration: 12 }, albumInfo: { albumId: 123, title: '专辑' } });
    throw new Error('unexpected request');
  };
  const result = await plugin.search({ query: 'https://www.ximalaya.com/album/123?x=1', kind: 'tracks' });
  assert.equal(result.tracks[0].id, '1');
  const episode = await plugin.search({ query: 'sound:1', kind: 'tracks' });
  assert.equal(episode.tracks[0].name, '单集');
  assert.equal((await plugin.search({ query: 'sound:1', kind: 'shows' })).shows.length, 0);
});

test('purchased albums are paginated separately from subscriptions', async () => {
  storage.set('sessionCookie', '1&_token=test');
  handler = url => {
    assert.equal(url.pathname, '/simple-revision-for-pc/my/getHasBroughtAlbums');
    assert.equal(url.searchParams.get('pageNum'), '1');
    return ok({ albumList: [album], pageNum: 1, totalCount: 31 });
  };
  const page = await plugin.browse({ page: 'purchases' });
  assert.equal(page.sections[0].shows[0].id, '123');
  assert.equal(page.sections[1].links[0].page, 'purchases:2');
});

test('local listening history deduplicates and is separate from cloud history', async () => {
  handler = () => ok({ trackInfo: { trackId: 1, title: '单集', duration: 12 }, albumInfo: { albumId: 123, title: '专辑' } });
  await plugin.played({ id: '1' });
  await plugin.played({ id: '1' });
  const page = await plugin.browse({ page: 'local-history' });
  assert.equal(page.sections[0].tracks.length, 1);
  assert.equal(page.sections[0].tracks[0].id, '1');
  assert.equal(storage.has('sessionCookie'), false);
});

test('preview URLs are rejected even when authorization says true', async () => {
  handler = () => playInfo('https://a.xmcdn.com/audio_preview_test.mp3');
  await assert.rejects(plugin.stream({ id: '1', quality: 'high' }), /试听权限/);
});

test('lossless selects an authorized FLAC and does not downgrade to MP3', async () => {
  handler = () => ({ ret: 0, trackInfo: { isAuthorized: true, playUrlList: [{ type: 'FLAC', url: encrypted('https://a.xmcdn.com/audio.flac') }] } });
  const stream = await plugin.stream({ id: '1', quality: 'lossless' });
  assert.equal(stream.type, 'flac');
  assert.equal(stream.quality, 'lossless');
  handler = () => playInfo();
  await assert.rejects(plugin.stream({ id: '1', quality: 'lossless' }), /无损/);
});
