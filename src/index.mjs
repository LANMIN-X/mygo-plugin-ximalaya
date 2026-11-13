import { ecb } from '@noble/ciphers/aes.js';
import CryptoJS from 'crypto-js/core.js';
import 'crypto-js/tripledes.js';
import 'crypto-js/mode-ecb.js';

const PC = 'https://pc.ximalaya.com';
const WEB = 'https://www.ximalaya.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Ximalaya/4.0.15 Chrome/102.0.5005.167 Electron/19.1.1 Safari/537.36 4.0.15';
const PAGE_SIZE = 30;
const SEARCH_SIZE = 20;
const COOKIE_KEY = 'sessionCookie';
const PASSPORT = 'https://passport.ximalaya.com';
const PLAYBACK_UA = 'ting_6.7.9(GM1900,Android29)';
let loginAttempt = 0;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function id(value) {
  const result = String(value ?? '');
  if (!/^[1-9]\d*$/.test(result)) throw new Error('喜马拉雅返回了无效的内容 ID');
  return result;
}
function list(value, field) {
  if (!Array.isArray(value)) throw new Error(`喜马拉雅接口格式已变化：缺少 ${field}`);
  return value;
}
function cookie() {
  return host.storage.get(COOKIE_KEY) || '';
}
function requireLogin() {
  if (!cookie()) throw fail('signIn', '请先登录喜马拉雅');
}
function image(path) {
  if (!path) return '';
  if (path.startsWith('//')) return 'https:' + path;
  if (/^https?:\/\//.test(path)) return path.replace(/^http:/, 'https:');
  return 'https://imagev2.xmcdn.com/' + path.replace(/^\//, '');
}
function text(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
}
function toShow(x) {
  return {
    id: id(x.albumId ?? x.album_id ?? x.id),
    name: text(x.albumTitle ?? x.album_title ?? x.title),
    imageUrl: image(x.albumPic ?? x.cover ?? x.coverPath ?? x.cover_path ?? x.albumCoverPath),
    description: text(x.albumIntro ?? x.intro ?? x.description ?? x.customTitle),
    publisher: x.anchorName ?? x.anchorNickName ?? x.nickname ?? '',
    episodeCount: x.trackCount ?? x.tracksCount ?? x.tracks ?? 0,
    subscribed: x.isSubscribe === true,
  };
}
function toTrack(x, show) {
  const albumId = id(x.albumId ?? x.album_id ?? show?.id);
  return {
    id: id(x.trackId ?? x.id),
    name: text(x.title ?? x.trackName),
    artists: [{ id: String(x.anchorId ?? x.uid ?? ''), name: x.anchorName ?? x.nickname ?? show?.publisher ?? '' }],
    album: {
      id: albumId,
      name: text(x.albumTitle ?? x.albumName ?? x.album_title ?? show?.name),
      imageUrl: image(x.albumCoverPath ?? x.trackCoverPath ?? x.album_cover_path ?? x.coverPath ?? x.cover_path ?? show?.imageUrl),
    },
    showId: albumId,
    duration: Math.round(Number(x.duration ?? x.length ?? 0) * 1000),
    description: text(x.intro),
    published: x.createDateFormat || '',
    url: `${WEB}/sound/${id(x.trackId ?? x.id)}`,
    unavailable: x.isNoCopyright === true || x.isDeleted === true,
  };
}
function historyTrack(x) {
  const track = toTrack({ trackId: x.childId, title: x.childTitle, albumId: x.itemId,
    albumTitle: x.itemTitle, albumCoverPath: x.itemCoverUrl, uid: x.uid,
    nickname: x.userName, duration: x.length, isDeleted: x.isDeleted });
  if (x.breakSecond !== null && x.breakSecond !== undefined && Number.isFinite(Number(x.breakSecond))) {
    const seconds = Math.max(0, Math.floor(Number(x.breakSecond)));
    const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
    track.description = `上次听到 ${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${String(seconds % 60).padStart(2, '0')}`;
  }
  return track;
}

// These are the client's public protocol rules, not a captured session or a user's credential.
function requestSign(url, now) {
  if (url.origin === PC) return `${now}&${host.crypto.md5(url.pathname + '&&' + now + 'ximalaya').slice(9, 25)}`;
  const random = () => Math.floor(Math.random() * 100);
  return `${host.crypto.md5('himalaya-' + now)}(${random()})${now}(${random()})${now}`;
}
async function request(origin, path, params = {}, signedIn = false, userAgent = UA, payload) {
  if (signedIn) requireLogin();
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const headers = { 'User-Agent': userAgent, Referer: origin + '/', Origin: origin, 'xm-sign': requestSign(url, Date.now()) };
  if (cookie()) headers.Cookie = cookie();
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url.href, { headers, method: payload === undefined ? 'GET' : 'POST', ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  if (response.status === 401) throw fail('signIn', '喜马拉雅登录已过期，请重新登录');
  if (!response.ok) throw new Error(`喜马拉雅接口请求失败（HTTP ${response.status}）`);
  const body = await response.json();
  if (body.ret === 50 || body.ret === 401) throw fail('signIn', '喜马拉雅登录已过期，请重新登录');
  if (body.ret !== undefined && body.ret !== 0 && body.ret !== 200) {
    throw new Error(`喜马拉雅：${text(body.msg ?? body.message) || '接口请求失败'}（${body.ret}）`);
  }
  if (body.data?.reason) throw new Error(`喜马拉雅拒绝了请求：${text(body.data.reason)}`);
  return body.data ?? body;
}
const pc = (path, params, signedIn) => request(PC, path, params, signedIn);

export async function signIn() {
  const attempt = ++loginAttempt;
  const deadline = Date.now() + 180000;
  const cookies = new Map();
  async function passport(path, params = {}) {
    const url = new URL(path, PASSPORT);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const headers = { 'User-Agent': UA, Origin: PC, Referer: PC + '/' };
    if (cookies.size) headers.Cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    const response = await fetch(url.href, { headers });
    if (!response.ok) throw new Error(`喜马拉雅扫码接口请求失败（HTTP ${response.status}）`);
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';', 1)[0];
      const at = pair.indexOf('=');
      if (at < 1) throw new Error('喜马拉雅返回了无效的会话 Cookie');
      const key = pair.slice(0, at), value = pair.slice(at + 1);
      if (value) cookies.set(key, value);
      else cookies.delete(key);
    }
    return response.json();
  }
  try {
    while (attempt === loginAttempt && Date.now() < deadline) {
      const qr = await passport('/web/qrCode/gen', { level: 'L', source: '喜马拉雅电脑版' });
      if (attempt !== loginAttempt) break;
      if (qr.ret !== 0 || !/^[a-f0-9]{32}$/i.test(qr.qrId)) throw new Error('喜马拉雅未返回有效的登录二维码');
      // This payload matches the QR image returned by the Mac client's API.
      host.signInPrompt({
        qr: `https://mobile.ximalaya.com/passport-sign-mobile/qrcode/login/${qr.qrId}/qrcode-7172636f6465?to=${encodeURIComponent('喜马拉雅电脑版')}`,
        text: '请用手机喜马拉雅 App 扫码，并确认登录喜马拉雅电脑版',
      });
      while (attempt === loginAttempt && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (attempt !== loginAttempt) break;
        const result = await passport(`/web/qrCode/check/${qr.qrId}/${Date.now()}`);
        if (attempt !== loginAttempt) break;
        if (result.ret === 32001) break;
        if (result.ret === 32000) continue;
        if (result.ret !== 0) throw new Error(`喜马拉雅扫码失败（${result.ret}）：${text(result.msg)}`);
        if (!cookies.has('1&_token')) throw new Error('扫码已确认，但喜马拉雅未返回登录凭据');
        host.storage.set(COOKIE_KEY, [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
        try {
          const me = await account();
          if (attempt !== loginAttempt) throw new Error('本次扫码登录已取消');
          if (!me) throw fail('signIn', '喜马拉雅登录未完成');
          return me;
        } catch (error) {
          if (attempt === loginAttempt) host.storage.remove(COOKIE_KEY);
          throw error;
        }
      }
    }
    throw new Error(attempt === loginAttempt ? '扫码登录已超时，请重试' : '本次扫码登录已取消');
  } finally {
    if (attempt === loginAttempt) host.signInPrompt({ text: '' });
  }
}
export function signOut() {
  loginAttempt++;
  host.storage.remove(COOKIE_KEY);
}
export async function account() {
  if (!cookie()) return null;
  try {
    const me = await pc('/pc-application-server/user/current/info', {}, true);
    return { id: id(me.uid), name: me.nickname, imageUrl: image(me.logoPic), page: 'subscriptions' };
  } catch (error) {
    if (error.code !== 'signIn') throw error;
    host.storage.remove(COOKIE_KEY);
    return null;
  }
}
export async function search({ query, kind, offset = 0 }) {
  if (!['tracks', 'shows'].includes(kind)) throw fail('unsupported', '支持搜索声音和专辑（播客）');
  if (!query.trim()) return { [kind]: [], more: false };
  const value = query.trim();
  let match = /^(album|sound):([1-9]\d*)$/i.exec(value);
  if (!match && /^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.hostname === 'ximalaya.com' || url.hostname.endsWith('.ximalaya.com')) match = /^\/(album|sound)\/([1-9]\d*)\/?$/.exec(url.pathname);
  }
  if (match) {
    const type = match[1].toLowerCase(), target = id(match[2]);
    if (type === 'album' && kind === 'tracks') {
      const result = await show({ id: target, offset });
      return { tracks: result.episodes, more: result.more };
    }
    if (offset || (type === 'sound' && kind !== 'tracks')) return { [kind]: [], more: false };
    if (type === 'album') return { shows: [(await show({ id: target, offset: 0 })).show], more: false };
    return { tracks: [await trackById(target)], more: false };
  }
  const data = await request(WEB, '/revision/search', {
    core: kind === 'tracks' ? 'track' : 'album', kw: query, page: Math.floor(offset / SEARCH_SIZE) + 1,
    rows: SEARCH_SIZE, device: 'iPhone', spellchecker: true, condition: 'relation', paidFilter: false,
  });
  const result = data.result?.response;
  const docs = list(result?.docs, 'result.response.docs');
  const skip = offset % SEARCH_SIZE;
  return { [kind]: docs.slice(skip).map(kind === 'tracks' ? x => toTrack(x) : toShow),
    more: offset - skip + docs.length < Number(result.numFound ?? result.total) };
}
export async function suggest({ query }) {
  if (!query.trim()) return [];
  const data = await pc('/simple-revision-for-pc/suggest', { kw: query });
  return list(data.result?.queryResultList, 'result.queryResultList').map(x => x.keyword);
}
export async function show({ id: showId, offset = 0 }) {
  id(showId);
  const [detail, page] = await Promise.all([
    pc('/simple-revision-for-pc/album/v1/simple', { albumId: showId }),
    pc('/simple-revision-for-pc/play/v1/show', {
      id: showId, num: Math.floor(offset / PAGE_SIZE) + 1, size: PAGE_SIZE, sort: 0, ptype: 0,
    }),
  ]);
  const info = detail.albumPageMainInfo;
  if (!info) throw new Error('喜马拉雅未返回专辑详情');
  const show = toShow({ ...info, albumId: showId,
    intro: info.shortIntro || info.richIntro });
  const items = list(page.tracksAudioPlay, 'tracksAudioPlay');
  const skip = offset % PAGE_SIZE;
  if (offset === 0) {
    const previous = host.storage.get('viewedShows');
    host.storage.set('viewedShows', [show, ...(Array.isArray(previous) ? previous.filter(x => x.id !== show.id) : [])].slice(0, 20));
  }
  return { show, episodes: items.slice(skip).map(x => toTrack(x, show)),
    more: page.hasMore === true };
}

export async function subscribeShow({ id: showId, on }) {
  const actionId = Number(id(showId));
  if (!Number.isSafeInteger(actionId) || typeof on !== 'boolean') throw new Error('无效的订阅参数');
  const action = on ? 'setSubscriptionAlbum' : 'cancelSubscriptionAlbum';
  await request(PC, `/simple-revision-for-pc/album/v1/sub/${action}`, {}, true, UA, { actionId });
}

function nextLink(page) {
  return { title: '翻页', links: [{ title: '下一页', page }] };
}
function pagedSections(title, shows, next) {
  return [{ title, shows, empty: '暂无内容' }, ...(next ? [nextLink(next)] : [])];
}
export function home() {
  return browse({ page: 'discover' });
}
export async function browse({ page }) {
  const parts = page.split(':');
  const [route, value, pageNumber = '1'] = parts;
  const number = Number(pageNumber);
  if (!Number.isSafeInteger(number) || number < 1 || parts.length > 3) throw fail('unavailable', '无效的页面');
  if (route === 'discover' && parts.length === 1) {
    const ranking = await pc('/simple-revision-for-pc/rank/v4/rankTabs', { sceneId: 1 });
    const tab = list(ranking.tabLists, 'tabLists')[0];
    const hot = list(tab?.tabWraps, 'tabWraps').find(x => x.name === '热播');
    if (!hot) throw new Error('喜马拉雅热门榜配置已变化');
    const ranked = await pc('/simple-revision-for-pc/rank/v4/element', { rankingId: id(hot.rankingId) });
    const sections = list(ranked.rankList, 'rankList').map(x => ({
      title: '热门专辑', shows: list(x.albums, 'albums').slice(0, PAGE_SIZE).map(toShow), morePage: `rank:${hot.rankingId}`,
    }));
    const viewed = host.storage.get('viewedShows');
    if (Array.isArray(viewed) && viewed.length) sections.push({ title: '最近浏览', shows: viewed });
    if (cookie()) {
      const tabs = list(await pc('/pc-application-server/module/v2/explore', { version: '4.0.15' }), 'explore');
      const main = tabs.find(x => x.isDefault);
      const config = main?.moduleConfig?.find(x => x.moduleType === 'module_guess_like_new');
      if (!config) throw new Error('喜马拉雅发现页配置已变化');
      const data = await pc('/pc-application-server/module/data', {
        tabId: main.tabId, moduleId: config.moduleId, paramString: config.moduleContext,
      });
      const recommendations = data.module_guess_like_new?.recommendInfoList;
      const items = recommendations === null ? [] : list(recommendations, 'recommendInfoList');
      sections.unshift({ title: '猜你喜欢', shows: items.map(toShow), empty: '暂无个性化推荐' });
    } else {
      sections.push({ title: '猜你喜欢', empty: '登录喜马拉雅后查看个性化推荐' });
    }
    return { title: '发现', sections };
  }
  if (route === 'vip' && parts.length <= 2) {
    const offset = value === undefined ? 0 : Number(value);
    if (!Number.isSafeInteger(offset) || offset < 0) throw fail('unavailable', '无效的页码');
    const data = await pc('/pc-application-server/feed/vip/page', { offset, size: PAGE_SIZE }, true);
    const items = list(data.items, 'items');
    return { title: '会员专区', subtitle: '播放权限以当前登录账号为准',
      sections: pagedSections('会员精选', items.map(toShow),
        items.length === PAGE_SIZE && data.offset > offset ? `vip:${data.offset}` : '') };
  }
  if (route === 'ranks' && parts.length === 1) {
    const data = await pc('/simple-revision-for-pc/rank/v4/rankTabs', { sceneId: 1 });
    return { title: '排行榜', sections: list(data.tabLists, 'tabLists').map(tab => ({
      title: tab.name, links: list(tab.tabWraps, 'tabWraps').filter(x => x.name !== '主播').map(x => ({ title: x.name, page: `rank:${id(x.rankingId)}` })),
    })) };
  }
  if (route === 'rank' && parts.length === 2) {
    const data = await pc('/simple-revision-for-pc/rank/v4/element', { rankingId: id(value) });
    return { title: '排行榜', sections: list(data.rankList, 'rankList').map(x => {
      if (Array.isArray(x.albums)) return { title: x.title, shows: x.albums.map(toShow), empty: '暂无上榜专辑' };
      if (Array.isArray(x.tracks)) return { title: x.title, tracks: x.tracks.map(y => toTrack(y)), empty: '暂无上榜声音' };
      throw fail('unsupported', '这个榜单的内容类型暂不支持，请选择专辑或声音榜');
    }) };
  }
  if (route === 'categories' && parts.length === 1) {
    const data = await pc('/simple-revision-for-pc/metadata/v2/group/all', { includeChannels: true });
    return { title: '全部分类', sections: list(data.groups, 'groups').map(group => ({ title: group.name,
      links: list(group.channels, 'channels').flatMap(x => [x, ...(x.subChannels || [])]).map(x => ({
        title: x.channelName, imageUrl: image(x.coverPath), page: `category:${id(x.relationMetadataValueId)}`,
      })),
    })) };
  }
  if (route === 'category' && parts.length >= 2) {
    const [info, data] = await Promise.all([
      pc('/simple-revision-for-pc/metadata/v2/channel/info', { channelRelationMetadataId: id(value) }),
      pc('/simple-revision-for-pc/metadata/v2/channel/albums', {
        metadataValueId: id(value), pageNum: number, pageSize: PAGE_SIZE, sort: 1,
      }),
    ]);
    const items = list(data.albums, 'albums');
    return { title: info.topInfo?.channelName || '分类专辑', sections: pagedSections('专辑', items.map(toShow),
      number * PAGE_SIZE < data.total ? `category:${value}:${number + 1}` : '') };
  }
  if (route === 'history' && parts.length <= 2) {
    const num = value === undefined ? 1 : Number(value);
    if (!Number.isSafeInteger(num) || num < 1) throw fail('unavailable', '无效的页码');
    const data = await pc('/simple-revision-for-pc/track/history/listen', {
      pageNum: num, pageSize: PAGE_SIZE, includeChannel: true,
    }, true);
    const sections = [['today', '今天'], ['yesterday', '昨天'], ['earlier', '更早']].map(([key, title]) => ({
      title, links: list(data[key], key).filter(x => x.type === 1 && x.childId).map(x => {
        const track = historyTrack(x);
        return { title: track.name, subtitle: track.album.name, imageUrl: track.album.imageUrl, page: `history-episode:${track.id}` };
      }), empty: '暂无收听记录',
    }));
    if (num * PAGE_SIZE < data.totalCount) sections.push(nextLink(`history:${num + 1}`));
    return { title: '收听历史', sections };
  }
  if (route === 'history-episode' && parts.length === 2) {
    const trackId = id(value);
    const data = await pc('/simple-revision-for-pc/play/v1/show', { id: trackId, ptype: 1, sort: 0, size: PAGE_SIZE });
    const items = list(data.tracksAudioPlay, 'tracksAudioPlay');
    const start = items.findIndex(x => String(x.trackId) === trackId);
    if (start < 0) throw new Error('喜马拉雅未返回历史记录对应的分集');
    const albumId = id(data.albumId);
    const pageNum = Number(data.pageNum);
    if (!Number.isSafeInteger(pageNum) || pageNum < 1) throw new Error('喜马拉雅返回了无效的分集页码');
    const sections = [{ title: '从上次收听的分集开始', tracks: items.slice(start).map(x => toTrack({ ...x, albumId })) }];
    if (data.hasMore === true) sections.push(nextLink(`history-next:${albumId}:${pageNum + 1}`));
    return { title: '收听历史', subtitle: '选择第一集开始播放', sections };
  }
  if (route === 'history-next' && parts.length === 3) {
    const albumId = id(value);
    const data = await pc('/simple-revision-for-pc/play/v1/show', { id: albumId, ptype: 0, num: number, sort: 0, size: PAGE_SIZE });
    const sections = [{ title: '后续分集', tracks: list(data.tracksAudioPlay, 'tracksAudioPlay').map(x => toTrack({ ...x, albumId })) }];
    if (data.hasMore === true) sections.push(nextLink(`history-next:${albumId}:${number + 1}`));
    return { title: '后续分集', sections };
  }
  if (route === 'subscriptions' && parts.length <= 2) {
    const num = value === undefined ? 1 : Number(value);
    if (!Number.isSafeInteger(num) || num < 1) throw fail('unavailable', '无效的页码');
    const data = await pc('/pc-application-server/subscribe/album/synthesize', { pageNum: num, pageSize: PAGE_SIZE }, true);
    return { title: '我的订阅', sections: pagedSections('已订阅专辑', list(data.albums, 'albums').map(x => toShow({ ...x, isSubscribe: true })),
      num * PAGE_SIZE < data.totalCount ? `subscriptions:${num + 1}` : '') };
  }
  if (route === 'purchases' && parts.length <= 2) {
    const num = value === undefined ? 1 : Number(value);
    if (!Number.isSafeInteger(num) || num < 1) throw fail('unavailable', '无效的页码');
    const data = await pc('/simple-revision-for-pc/my/getHasBroughtAlbums', { pageNum: num, pageSize: PAGE_SIZE }, true);
    if (Number(data.pageNum) !== num || !Number.isFinite(Number(data.totalCount))) throw new Error('喜马拉雅返回了无效的已购列表');
    const albums = list(data.albumList, 'albumList');
    return { title: '已购专辑', subtitle: '单独购买的专辑；会员内容可通过搜索或订阅打开',
      sections: pagedSections('已购专辑', albums.map(toShow), num * PAGE_SIZE < data.totalCount ? `purchases:${num + 1}` : '') };
  }
  if (route === 'local-history' && parts.length === 1) {
    const items = host.storage.get('localRecent');
    return { title: '本机记录', sections: [{ title: '最近播放', tracks: Array.isArray(items) ? items : [], empty: '本机暂无播放记录' }] };
  }
  if (route === 'updates' && parts.length <= 2) {
    const num = value === undefined ? 1 : Number(value);
    if (!Number.isSafeInteger(num) || num < 1) throw fail('unavailable', '无效的页码');
    const data = await pc('/pc-application-server/subscribe/album/chase/track/feed', { pageNum: num, pageSize: PAGE_SIZE }, true);
    const feeds = list(data.feeds, 'feeds');
    const sections = [{ title: '最新更新', tracks: feeds.map(x => toTrack({
      ...x, anchorName: x.anchorNickName, albumCoverPath: x.coverPath, intro: x.trackIntro,
    })), empty: '追更专辑暂无更新' }];
    if (feeds.length >= PAGE_SIZE) sections.push(nextLink(`updates:${num + 1}`));
    return { title: '我的追更', sections };
  }
  throw fail('unavailable', '页面不存在');
}
export async function recent() {
  const data = await pc('/simple-revision-for-pc/track/history/listen', { pageNum: 1, pageSize: PAGE_SIZE, includeChannel: true }, true);
  return ['today', 'yesterday', 'earlier'].flatMap(key => list(data[key], key).filter(x => x.type === 1 && x.childId).map(historyTrack));
}

async function trackById(trackId) {
  const data = await pc('/simple-revision-for-pc/track/simple', { trackId: id(trackId) });
  if (!data.trackInfo || !data.albumInfo || String(data.trackInfo.trackId) !== String(trackId)) throw new Error('喜马拉雅未返回有效单集信息');
  return toTrack({ ...data.trackInfo, albumId: data.albumInfo.albumId, albumTitle: data.albumInfo.title,
    albumCoverPath: data.albumInfo.coverPath, anchorId: data.trackInfo.anchorUid });
}

export async function played({ id: trackId }) {
  const track = await trackById(trackId);
  const previous = host.storage.get('localRecent');
  host.storage.set('localRecent', [track, ...(Array.isArray(previous) ? previous.filter(x => x.id !== track.id) : [])].slice(0, 50));
}

export async function lyrics({ id: trackId }) {
  id(trackId);
  const data = await pc('/pc-application-server/track/documentInfo', { trackId, isSecretAIDoc: true });
  if (!data.aiDocumentUrl) return { lines: [] };
  const address = new URL(data.aiDocumentUrl);
  if (!['http:', 'https:'].includes(address.protocol) || !address.hostname.endsWith('.xmcdn.com') || address.username || address.password) {
    throw new Error('喜马拉雅返回了非预期的字幕地址');
  }
  address.protocol = 'https:';
  const response = await fetch(address.href);
  if (!response.ok) throw new Error(`喜马拉雅字幕请求失败（HTTP ${response.status}）`);
  const encrypted = (await response.text()).trim();
  if (!/^(?:[a-f\d]{16})+$/i.test(encrypted)) throw new Error('喜马拉雅字幕数据格式无效');
  // The Mac client uses this public format constant to decode its timed transcript.
  const decoded = CryptoJS.DES.decrypt({ ciphertext: CryptoJS.enc.Hex.parse(encrypted) },
    CryptoJS.enc.Utf8.parse('xmly&asr'), { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }).toString(CryptoJS.enc.Utf8);
  const entries = list(JSON.parse(decoded), '字幕');
  return { lines: entries.map(line => ({
    start: line.start, end: line.end, text: line.text,
    words: (line.wordPieces || []).map(word => ({ start: word.start, end: word.end, text: word.word })),
  })) };
}

function audioURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.endsWith('.xmcdn.com') || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('喜马拉雅返回了非预期的音频地址');
  }
  if (/(?:_preview_|\/preview\/|\/sample\/)/i.test(url.pathname)) throw fail('unavailable', '当前账号只有试听权限，无法播放完整单集');
  url.protocol = 'https:';
  return url.href;
}
function decodeURL(value) {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  // Public client format constant; it conveys no account entitlement.
  const key = Uint8Array.from('aaad3e4fd540b0f79dca95606e72bf93'.match(/../g), x => parseInt(x, 16));
  return audioURL(new TextDecoder().decode(ecb(key).decrypt(bytes)));
}
export async function stream({ id: trackId, quality }) {
  try {
    id(trackId);
    // The legacy playback API needs its app request profile; the PC profile returns 1001.
    const data = await request(WEB, `/mobile-playpage/track/v3/baseInfo/${Date.now()}`, {
      device: 'web', trackId, trackQualityLevel: quality === 'standard' ? 0 : quality === 'lossless' ? 3 : 1,
    }, false, PLAYBACK_UA);
    const info = data.trackInfo;
    if (typeof info?.isAuthorized !== 'boolean') throw new Error('喜马拉雅接口格式已变化：缺少播放权限信息');
    if (!info.isAuthorized) {
      if (!cookie()) throw fail('signIn', '这集需要登录后确认播放权限，请先扫码登录');
      if (!await account()) throw fail('signIn', '喜马拉雅登录已过期，请重新扫码登录');
      throw fail('unavailable', '当前账号无权播放这集，请在喜马拉雅确认会员或购买权限');
    }
    const urls = list(info.playUrlList, 'trackInfo.playUrlList');
    const selected = quality === 'lossless' ? urls.find(x => /^FLAC/i.test(x.type)) :
      urls.find(x => x.type === (quality === 'standard' ? 'MP3_32' : 'MP3_64')) || urls.find(x => /^MP3_/.test(x.type));
    if (!selected) throw fail('unavailable', quality === 'lossless' ? '这集未提供可用的无损音质' : '这集未提供兼容的 MP3 音频');
    // play_path_64 can contain HE-AAC in M4A, which MyGo cannot decode; request an actual MP3.
    const url = decodeURL(selected.url);
    const type = quality === 'lossless' ? 'flac' : 'mp3';
    if (!new URL(url).pathname.toLowerCase().endsWith(`.${type}`)) throw new Error('喜马拉雅返回的音频地址与实际格式不符');
    return { url, type, size: selected.fileSize, quality: type === 'flac' ? 'lossless' : selected.type === 'MP3_32' ? 'standard' : 'high',
      headers: { 'User-Agent': PLAYBACK_UA, Referer: WEB + '/' } };
  } catch (error) {
    host.storage.set('lastPlaybackError', {
      trackId: String(trackId).slice(0, 32), time: new Date().toISOString(), code: error.code || 'error',
      message: String(error.message).replace(/https?:\/\/\S+/g, '[请求地址已省略]').slice(0, 300),
    });
    throw error;
  }
}
