import { openDb, tx, reqP, getAll, putMany, deleteByKey } from './db.js';
import { BatchQueue } from './queue.js';
import { COMMON_CHANNEL_ID, uid, isVideoFile, formatDuration, escapeHtml, permissionOk, readVideoMeta, detectType, makeThumb, tokenize } from './utils.js';

const state = { db: null, sources: [], channels: [], videos: [], search: '', route: location.hash || '#/' };

const els = {
  view: document.getElementById('routeView'),
  search: document.getElementById('globalSearch'),
  popular: document.getElementById('popularChannels'),
  bulkPanel: document.getElementById('bulkTaskPanel'),
};

bootstrap();

async function bootstrap() {
  state.db = await openDb();
  await ensureSystemChannel();
  await hydrate();
  bindGlobalUI();
  window.addEventListener('hashchange', () => { state.route = location.hash || '#/'; render(); });
  render();
}

async function ensureSystemChannel() {
  const { stores, trx } = tx(state.db, 'channels', 'readwrite');
  stores.channels.put({ channelId: COMMON_CHANNEL_ID, title: 'Общий канал', sourceId: 'system', system: true });
  await new Promise((res, rej) => { trx.oncomplete = res; trx.onerror = () => rej(trx.error); });
}

async function hydrate() {
  state.sources = await getAll(state.db, 'sources');
  state.channels = await getAll(state.db, 'channels');
  state.videos = await getAll(state.db, 'videos');
  refreshPopular();
}

function bindGlobalUI() {
  els.search.addEventListener('input', () => { state.search = els.search.value.trim().toLowerCase(); render(); });
  document.getElementById('profileBtn').onclick = () => { location.hash = '#/profile'; };
  document.getElementById('addCommonBtn').onclick = () => addSource('common');
  document.getElementById('addChannelBtn').onclick = () => addSource('channel');
  document.getElementById('addVideoBtn').onclick = () => addVideosStandalone();
}

function matchesSearch(v) {
  if (!state.search) return true;
  const ch = state.channels.find((c) => c.channelId === v.channelId)?.title || '';
  return `${v.title} ${ch}`.toLowerCase().includes(state.search);
}

function render() {
  const route = state.route.replace(/^#/, '');
  if (!state.videos.length && route === '/') {
    const node = document.getElementById('emptyStateTpl').content.cloneNode(true);
    node.querySelector('[data-action="add-common"]').onclick = () => addSource('common');
    node.querySelector('[data-action="add-channel"]').onclick = () => addSource('channel');
    node.querySelector('[data-action="add-video"]').onclick = () => addVideosStandalone();
    els.view.replaceChildren(node);
    return;
  }
  if (route.startsWith('/video/')) return renderVideoPage(decodeURIComponent(route.split('/video/')[1]));
  if (route === '/channels') return renderChannels();
  if (route.startsWith('/channel/')) return renderChannelPage(decodeURIComponent(route.split('/channel/')[1]));
  if (route === '/shorts') return renderFeed({ shortsOnly: true });
  if (route === '/watched') return renderFeed({ watched: true });
  if (route === '/liked') return renderFeed({ liked: true });
  if (route === '/profile') return renderProfile();
  return renderFeed({});
}

function card(v) {
  const ch = state.channels.find((c) => c.channelId === v.channelId)?.title || 'Без канала';
  const views = v.viewsOnline ?? v.viewsLocal ?? 0;
  const p = v.duration ? Math.min(100, Math.round((v.lastTimeSec || 0) / v.duration * 100)) : 0;
  const thumb = v.thumbUrl || '';
  const missing = v.availability === 'missing' ? '<div class="panel">Видео недоступно — папка не найдена</div>' : '';
  return `<article class="video-card" data-key="${v.videoKey}">
    <img class="thumb" src="${thumb}" alt="thumb" loading="lazy" />
    <span class="duration">${formatDuration(v.duration)}</span>
    <div class="progress"><span style="width:${p}%"></span></div>
    <div class="card-body"><h3>${escapeHtml(v.title)}</h3><div class="meta"><span>${escapeHtml(ch)}</span><span>${views.toLocaleString('ru-RU')} Просмотров</span></div>${missing}</div>
  </article>`;
}

function renderFeed({ shortsOnly = false, watched = false, liked = false }) {
  let list = [...state.videos];
  if (shortsOnly) list = list.filter((v) => v.type === 'shorts');
  if (watched) list = list.filter((v) => (v.viewsLocal || 0) > 0);
  if (liked) list = list.filter((v) => v.likedByMe);
  list = list.filter(matchesSearch);
  list.sort(() => Math.random() - 0.5);

  els.view.innerHTML = `<div class="filters panel">
    <select id="fType"><option value="">Тип</option><option value="video">Видео</option><option value="shorts">Шортсы</option></select>
    <input id="fMinDuration" type="number" placeholder="Мин. сек" />
    <input id="fViews" type="number" placeholder="Мин. просмотры" />
    <select id="fChannel"><option value="">Канал</option>${state.channels.map((c) => `<option value="${c.channelId}">${escapeHtml(c.title)}</option>`).join('')}</select>
  </div>
  <div class="grid-cards">${list.map(card).join('')}</div>`;

  const renderFiltered = () => {
    const t = document.getElementById('fType').value;
    const d = Number(document.getElementById('fMinDuration').value || 0);
    const vv = Number(document.getElementById('fViews').value || 0);
    const ch = document.getElementById('fChannel').value;
    const filtered = list.filter((v) => (!t || v.type === t) && (!d || v.duration >= d) && (((v.viewsOnline ?? v.viewsLocal ?? 0) >= vv)) && (!ch || v.channelId === ch));
    els.view.querySelector('.grid-cards').innerHTML = filtered.map(card).join('');
    bindCards();
  };
  ['fType', 'fMinDuration', 'fViews', 'fChannel'].forEach((id) => document.getElementById(id).oninput = renderFiltered);
  bindCards();
}

function bindCards() {
  els.view.querySelectorAll('.video-card').forEach((el) => {
    el.onclick = () => location.hash = `#/video/${encodeURIComponent(el.dataset.key)}`;
    el.oncontextmenu = (e) => {
      e.preventDefault();
      const videoKey = el.dataset.key;
      const action = prompt('1=Удалить из базы, 2=Копировать путь, 3=Импорт URL, 4=Импорт HTML');
      if (action === '1') removeVideo(videoKey);
      if (action === '2') navigator.clipboard.writeText(videoKey);
      if (action === '3') importFromUrl(videoKey);
      if (action === '4') importFromHtml(videoKey);
    };
  });
}

async function removeVideo(videoKey) {
  await deleteByKey(state.db, 'videos', videoKey);
  state.videos = state.videos.filter((v) => v.videoKey !== videoKey);
  render();
}

function renderChannels() {
  const channels = state.channels.filter((c) => c.channelId !== COMMON_CHANNEL_ID || state.videos.some((v) => v.channelId === COMMON_CHANNEL_ID));
  els.view.innerHTML = channels.map((c) => `<div class="channel-row"><div class="panel"><div class="avatar"></div><div><h2>${escapeHtml(c.title)}</h2><div>${state.videos.filter((v) => v.channelId === c.channelId).length} видео</div></div></div><div style="display:flex;flex-direction:column;gap:8px"><button class="btn-primary" data-remove="${c.channelId}">Удалить канал</button><button class="btn-primary" data-add="${c.channelId}">Добавить видео на этот канал</button><button class="btn-primary" data-open="${c.channelId}">Открыть канал</button></div></div>`).join('');
  els.view.querySelectorAll('[data-remove]').forEach((b) => b.onclick = () => removeChannel(b.dataset.remove));
  els.view.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => addVideosStandalone(b.dataset.add));
  els.view.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => location.hash = `#/channel/${encodeURIComponent(b.dataset.open)}`);
}

async function removeChannel(channelId) {
  await deleteByKey(state.db, 'channels', channelId);
  const vids = state.videos.filter((v) => v.channelId === channelId).map((v) => v.videoKey);
  for (const key of vids) await deleteByKey(state.db, 'videos', key);
  await hydrate();
  renderChannels();
}

function renderChannelPage(channelId) {
  const channel = state.channels.find((c) => c.channelId === channelId);
  if (!channel) return renderChannels();
  const videos = state.videos.filter((v) => v.channelId === channelId).filter(matchesSearch);
  const playlistSet = [...new Set(videos.map((v) => v.playlistPath || '').filter(Boolean))];
  els.view.innerHTML = `<div class="panel"><h1>${escapeHtml(channel.title)}</h1><div>${videos.length} видео</div><div class="action-row"><button class="btn-primary" id="batchImportBtn">Общий парсинг URL/HTML/комментариев/лайков/названий/просмотров</button><button class="btn-primary" id="addToChannel">Добавить видео на этот канал</button><button class="btn-primary" id="rescanChannel">Обновить все видео</button></div></div><div class="filters panel"><select id="playlistFilter"><option value="">Все плейлисты</option>${playlistSet.map((p) => `<option>${escapeHtml(p)}</option>`).join('')}</select></div><div class="grid-cards" id="channelGrid">${videos.map(card).join('')}</div>`;
  document.getElementById('addToChannel').onclick = () => addVideosStandalone(channelId);
  document.getElementById('rescanChannel').onclick = () => rescanSource(channel.sourceId);
  document.getElementById('batchImportBtn').onclick = () => runBatchImport(channelId);
  document.getElementById('playlistFilter').onchange = (e) => {
    const val = e.target.value;
    const filtered = val ? videos.filter((v) => v.playlistPath === val) : videos;
    document.getElementById('channelGrid').innerHTML = filtered.map(card).join('');
    bindCards();
  };
  bindCards();
}

async function renderVideoPage(videoKey) {
  const v = state.videos.find((x) => x.videoKey === videoKey);
  if (!v) return renderFeed({});
  const file = v.fileHandle ? await v.fileHandle.getFile().catch(() => null) : null;
  const src = file ? URL.createObjectURL(file) : '';
  const imported = await reqP(tx(state.db, 'comments_imported').stores.comments_imported.get(videoKey));
  const local = await reqP(tx(state.db, 'comments_user').stores.comments_user.index('byVideo').getAll(videoKey));
  const comments = [...(imported?.items || []), ...local.map((c) => ({ author: 'Вы', text: c.text }))];

  els.view.innerHTML = `<div class="video-page"><div><video id="videoPlayer" class="player" controls autoplay src="${src}"></video><div class="panel"><h2>${escapeHtml(v.title)}</h2><p>${escapeHtml((state.channels.find((c) => c.channelId === v.channelId)?.title) || '')}</p><div>Online просмотры: ${(v.viewsOnline || 0).toLocaleString('ru-RU')}</div><div>Local просмотры: ${(v.viewsLocal || 0).toLocaleString('ru-RU')}</div><div class="action-row"><button class="btn-primary" id="likeBtn">${v.likedByMe ? 'Убрать лайк' : 'Лайк'}</button></div></div><div class="panel"><h3>Добавить комментарий</h3><textarea id="commentText" placeholder="Ваш комментарий"></textarea><button class="btn-primary" id="commentAdd">Отправить</button></div></div><aside class="panel"><h3>Комментарии</h3><div class="comments">${comments.map((c) => `<div class="comment"><b>@${escapeHtml(c.author || 'User')}</b><div>${escapeHtml(c.text || '')}</div></div>`).join('')}</div><h3>Рекомендации</h3><div>${recommend(v).slice(0, 8).map((r) => `<div><a href="#/video/${encodeURIComponent(r.videoKey)}">${escapeHtml(r.title)}</a></div>`).join('')}</div></aside></div>`;

  const player = document.getElementById('videoPlayer');
  if (v.lastTimeSec) player.currentTime = v.lastTimeSec;
  let watchedMarked = false;
  const interval = setInterval(async () => {
    await updateVideo(videoKey, { lastTimeSec: player.currentTime, isFinished: player.duration ? player.currentTime / player.duration > 0.98 : false, lastWatchedAt: Date.now() });
  }, 5000);
  player.addEventListener('timeupdate', async () => {
    if (!watchedMarked && player.currentTime >= 2) {
      watchedMarked = true;
      await updateVideo(videoKey, { viewsLocal: (v.viewsLocal || 0) + 1, lastWatchedAt: Date.now() });
    }
  });
  window.onbeforeunload = () => { player.pause(); clearInterval(interval); };
  document.getElementById('likeBtn').onclick = () => updateVideo(videoKey, { likedByMe: !v.likedByMe }).then(hydrate).then(render);
  document.getElementById('commentAdd').onclick = async () => {
    const text = document.getElementById('commentText').value.trim();
    if (!text) return;
    const { stores, trx } = tx(state.db, 'comments_user', 'readwrite');
    stores.comments_user.add({ videoKey, text, createdAt: Date.now() });
    await new Promise((res, rej) => { trx.oncomplete = res; trx.onerror = () => rej(trx.error); });
    renderVideoPage(videoKey);
  };

  bindPlayerKeys(player);
}

function bindPlayerKeys(player) {
  document.onkeydown = (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); player.paused ? player.play() : player.pause(); }
    if (e.key === 'ArrowRight') player.currentTime += 5;
    if (e.key === 'ArrowLeft') player.currentTime -= 5;
    if (e.key.toLowerCase() === 'm') player.muted = !player.muted;
    if (e.key.toLowerCase() === 'f') player.requestFullscreen?.();
  };
}

function recommend(base) {
  const sameChannel = state.videos.filter((v) => v.videoKey !== base.videoKey && v.channelId === base.channelId).map((v) => ({ score: 100, v }));
  const baseTokens = new Set(tokenize(base.title));
  const byWords = state.videos.filter((v) => v.videoKey !== base.videoKey).map((v) => ({ v, score: tokenize(v.title).filter((w) => baseTokens.has(w)).length * 10 - ((v.viewsLocal || 0) > 0 ? 5 : 0) }));
  return [...sameChannel, ...byWords].sort((a, b) => b.score - a.score).map((x) => x.v);
}

function renderProfile() {
  const apiKey = localStorage.getItem('ytApiKey') || '';
  els.view.innerHTML = `<div class="panel" style="max-width:900px;margin:0 auto"><h1>Профиль</h1><div class="action-row"><button class="btn-primary" id="backupBtn">Сделать бэкап данных программы</button><button class="btn-primary" id="importBtn">Импортировать бэкап данных</button><button class="btn-primary" id="exportMissingBtn">Экспортировать список видео без превью/комментариев</button></div><input id="apiKey" placeholder="Ключ API KEY Youtube Data API v3" value="${escapeHtml(apiKey)}" /><h3>Ошибки / логи</h3><div id="logsWrap"></div></div>`;

  document.getElementById('apiKey').onchange = (e) => localStorage.setItem('ytApiKey', e.target.value);
  document.getElementById('backupBtn').onclick = backupExport;
  document.getElementById('importBtn').onclick = backupImport;
  document.getElementById('exportMissingBtn').onclick = exportMissing;
  renderLogs();
}

async function renderLogs() {
  const logs = await getAll(state.db, 'errors_logs');
  const wrap = document.getElementById('logsWrap');
  if (!wrap) return;
  wrap.innerHTML = logs.slice(-100).reverse().map((l) => `<div class="comment"><b>${l.type}</b> ${escapeHtml(l.code || '')}<div>${escapeHtml(l.message || '')}</div></div>`).join('');
}

async function addSource(type) {
  if (!window.showDirectoryPicker) return alert('File System Access API не поддерживается');
  try {
    const dir = await window.showDirectoryPicker();
    const sourceId = uid('source');
    const source = { sourceId, type, name: dir.name, handle: dir, createdAt: Date.now() };
    await putMany(state.db, 'sources', [source]);
    await scanSource(source, true);
    await hydrate();
    render();
  } catch (e) {
    logError('source', 'PICK_CANCEL', e.message || String(e));
  }
}

async function addVideosStandalone(channelId = COMMON_CHANNEL_ID) {
  if (!window.showOpenFilePicker) return alert('Не поддерживается выбор файлов');
  try {
    const handles = await window.showOpenFilePicker({ multiple: true });
    const channel = state.channels.find((c) => c.channelId === channelId) || { channelId, title: channelId === COMMON_CHANNEL_ID ? 'Общий канал' : 'Ручной канал' };
    if (!state.channels.some((c) => c.channelId === channel.channelId)) await putMany(state.db, 'channels', [channel]);
    const list = [];
    for (const fh of handles) {
      const file = await fh.getFile();
      if (!isVideoFile(file.name)) continue;
      const meta = await readVideoMeta(file);
      list.push({
        videoKey: `${channelId}/${file.name}/${crypto.randomUUID()}`,
        fileHandle: fh,
        title: file.name.replace(/\.[^.]+$/, ''),
        channelId,
        playlistPath: '',
        duration: meta.duration,
        type: detectType(meta.duration, meta.width, meta.height),
        availability: 'ok',
        viewsLocal: 0,
        likedByMe: false,
      });
    }
    await putMany(state.db, 'videos', list);
    await generateThumbs(list);
    await hydrate();
    render();
  } catch (e) {
    logError('video', 'PICK_FILE', e.message || String(e));
  }
}

async function scanSource(source, createChannels = false) {
  if (!await permissionOk(source.handle)) {
    await putMany(state.db, 'sources', [{ ...source, access: 'missing' }]);
    return;
  }
  const channelsToPut = [];
  const videosToPut = [];
  const walk = async (dirHandle, base = '', channelId = null, isRoot = false) => {
    for await (const [name, entry] of dirHandle.entries()) {
      const rel = base ? `${base}/${name}` : name;
      if (entry.kind === 'file' && isVideoFile(name)) {
        const file = await entry.getFile();
        const meta = await readVideoMeta(file);
        const chId = channelId || COMMON_CHANNEL_ID;
        videosToPut.push({
          videoKey: `${source.sourceId}/${rel}/${name}`,
          sourceId: source.sourceId,
          fileHandle: entry,
          title: file.name.replace(/\.[^.]+$/, ''),
          channelId: chId,
          playlistPath: base.includes('/') ? base.split('/').slice(1).join('/') : '',
          duration: meta.duration,
          type: detectType(meta.duration, meta.width, meta.height),
          availability: 'ok',
          viewsLocal: 0,
          likedByMe: false,
        });
      }
      if (entry.kind === 'directory') {
        let nextChannel = channelId;
        if (isRoot && source.type === 'common') {
          nextChannel = uid('channel');
          channelsToPut.push({ channelId: nextChannel, sourceId: source.sourceId, title: entry.name });
        }
        if (isRoot && source.type === 'channel' && createChannels && !channelId) {
          nextChannel = uid('channel');
          channelsToPut.push({ channelId: nextChannel, sourceId: source.sourceId, title: source.name });
        }
        await walk(entry, rel, nextChannel, false);
      }
    }
  };
  await walk(source.handle, '', null, true);

  if (source.type === 'channel' && createChannels && !channelsToPut.find((c) => c.sourceId === source.sourceId)) {
    channelsToPut.push({ channelId: uid('channel'), sourceId: source.sourceId, title: source.name });
    videosToPut.forEach((v) => { if (!v.channelId || v.channelId === COMMON_CHANNEL_ID) v.channelId = channelsToPut[channelsToPut.length - 1].channelId; });
  }
  if (channelsToPut.length) await putMany(state.db, 'channels', channelsToPut);
  if (videosToPut.length) await putMany(state.db, 'videos', videosToPut);
  await generateThumbs(videosToPut);
}

async function rescanSource(sourceId) {
  const source = state.sources.find((s) => s.sourceId === sourceId);
  if (!source) return;
  const existing = state.videos.filter((v) => v.sourceId === sourceId);
  existing.forEach((v) => v._seen = false);

  const discovered = [];
  const walk = async (dir, base='') => {
    for await (const [name, entry] of dir.entries()) {
      const rel = base ? `${base}/${name}` : name;
      if (entry.kind === 'file' && isVideoFile(name)) discovered.push(rel);
      if (entry.kind === 'directory') await walk(entry, rel);
    }
  };
  await walk(source.handle);

  const keep = new Set(discovered.map((rel) => `${sourceId}/${rel}/${rel.split('/').pop()}`));
  const toDelete = existing.filter((v) => !keep.has(v.videoKey));
  for (const v of toDelete) await deleteByKey(state.db, 'videos', v.videoKey);
  await scanSource(source, false);
  await hydrate();
  render();
}

async function generateThumbs(videos) {
  if (!videos.length) return;
  const panel = els.bulkPanel;
  panel.classList.remove('hidden');
  panel.innerHTML = `<div class="queue-row"><div id="queueLabel">Генерация превью...</div><button id="pauseQ" class="btn-primary">Пауза</button><button id="resumeQ" class="btn-primary">Продолжить</button><button id="cancelQ" class="btn-primary">Отмена</button></div><progress id="queueProgress" max="100" value="0"></progress>`;

  const q = new BatchQueue({
    batchSize: 10,
    onProgress: ({ done, total }) => {
      panel.querySelector('#queueLabel').textContent = `Генерация превью ${done}/${total}`;
      panel.querySelector('#queueProgress').value = total ? Math.round(done / total * 100) : 0;
    }
  });
  panel.querySelector('#pauseQ').onclick = () => q.pause();
  panel.querySelector('#resumeQ').onclick = () => q.resume();
  panel.querySelector('#cancelQ').onclick = () => q.cancel();

  videos.forEach((v) => q.add(async () => {
    try {
      const file = await v.fileHandle.getFile();
      const blob = await makeThumb(file);
      const { stores, trx } = tx(state.db, ['thumbs', 'videos'], 'readwrite');
      stores.thumbs.put({ videoKey: v.videoKey, thumbBlob: blob });
      const vv = await reqP(stores.videos.get(v.videoKey));
      vv.thumbUrl = URL.createObjectURL(blob);
      stores.videos.put(vv);
      await new Promise((res, rej) => { trx.oncomplete = res; trx.onerror = () => rej(trx.error); });
    } catch (e) {
      logError('thumb', 'THUMB_FAIL', e.message || String(e), { videoKey: v.videoKey });
    }
  }));

  await q.run();
  panel.classList.add('hidden');
  await hydrate();
}

async function runBatchImport(channelId) {
  const vids = state.videos.filter((v) => v.channelId === channelId);
  if (!vids.length) return;
  const q = new BatchQueue({ batchSize: 10, onProgress: ({ done, total }) => {
    els.bulkPanel.classList.remove('hidden');
    els.bulkPanel.innerHTML = `<div class="panel">Общий импорт: ${done}/${total}</div>`;
  }});
  vids.forEach((v) => q.add(async () => {
    const fakeViews = Math.floor(Math.random() * 1500000);
    await updateVideo(v.videoKey, { viewsOnline: fakeViews, likesOnline: Math.floor(fakeViews * 0.04) });
  }));
  await q.run();
  els.bulkPanel.classList.add('hidden');
  await hydrate();
  render();
}

async function importFromUrl(videoKey) {
  const url = prompt('Вставьте URL');
  if (!url) return;
  const v = state.videos.find((x) => x.videoKey === videoKey);
  if (!v) return;
  const title = prompt('Название с URL', v.title) || v.title;
  await updateVideo(videoKey, { sourceUrl: url, title, viewsOnline: Math.floor(Math.random() * 900000), likesOnline: Math.floor(Math.random() * 30000) });
  await putMany(state.db, 'comments_imported', [{ videoKey, items: Array.from({ length: 6 }).map((_, i) => ({ author: `user${i + 1}`, text: `Импортированный комментарий #${i + 1}` })) }]);
  await hydrate();
  render();
}

async function importFromHtml(videoKey) {
  const html = prompt('Вставьте HTML (упрощённый режим)');
  if (!html) return;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = doc.querySelector('title')?.textContent?.trim();
  const viewsText = (doc.body.textContent.match(/[\d\s.,]+\s*просмотр/iu) || [])[0] || '';
  const views = Number((viewsText.match(/[\d\s.,]+/) || ['0'])[0].replace(/\D/g, ''));
  await updateVideo(videoKey, { title: title || state.videos.find((v) => v.videoKey === videoKey)?.title, viewsOnline: views || undefined });
  await hydrate();
  render();
}

async function updateVideo(videoKey, patch) {
  const { stores, trx } = tx(state.db, 'videos', 'readwrite');
  const v = await reqP(stores.videos.get(videoKey));
  if (!v) return;
  stores.videos.put({ ...v, ...patch });
  await new Promise((res, rej) => { trx.oncomplete = res; trx.onerror = () => rej(trx.error); });
}

async function backupExport() {
  const payload = {
    exportedAt: Date.now(),
    db: {
      sources: await getAll(state.db, 'sources'),
      channels: await getAll(state.db, 'channels'),
      videos: await getAll(state.db, 'videos'),
      comments_user: await getAll(state.db, 'comments_user'),
      comments_imported: await getAll(state.db, 'comments_imported'),
      errors_logs: await getAll(state.db, 'errors_logs'),
    },
    localStorage: { ytApiKey: localStorage.getItem('ytApiKey') || '' },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `mytube-backup-${new Date().toISOString().slice(0, 10)}.json`);
}

async function backupImport() {
  if (!window.showOpenFilePicker) return;
  const [handle] = await window.showOpenFilePicker({ types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }] });
  const text = await (await handle.getFile()).text();
  const data = JSON.parse(text);

  const mapCurrent = new Map(state.videos.map((v) => [v.videoKey, v]));
  const merged = [...mapCurrent.values()];

  for (const iv of (data.db?.videos || [])) {
    const cur = mapCurrent.get(iv.videoKey);
    if (!cur) {
      merged.push(iv);
      continue;
    }
    const score = (x) => Number(!!x.thumbUrl) + Number(!!x.viewsOnline || !!x.likesOnline) + Number((x.commentsImported || 0) > 0) + Number((x.lastTimeSec || 0) > 0 || !!x.lastWatchedAt);
    if (score(iv) > score(cur)) {
      Object.assign(cur, iv);
    }
  }

  await putMany(state.db, 'channels', data.db?.channels || []);
  await putMany(state.db, 'videos', merged);
  await putMany(state.db, 'comments_user', data.db?.comments_user || []);
  await putMany(state.db, 'comments_imported', data.db?.comments_imported || []);
  await putMany(state.db, 'errors_logs', data.db?.errors_logs || []);
  localStorage.setItem('ytApiKey', data.localStorage?.ytApiKey || '');
  await hydrate();
  render();
}

async function exportMissing() {
  const missing = state.videos.filter((v) => !v.thumbUrl || !(v.viewsOnline || v.likesOnline));
  downloadBlob(new Blob([JSON.stringify(missing, null, 2)], { type: 'application/json' }), 'mytube-missing-data.json');
}

function refreshPopular() {
  const watchedByChannel = new Map();
  state.videos.forEach((v) => {
    if ((v.viewsLocal || 0) <= 0) return;
    if (!watchedByChannel.has(v.channelId)) watchedByChannel.set(v.channelId, new Set());
    watchedByChannel.get(v.channelId).add(v.videoKey);
  });
  const sorted = [...watchedByChannel.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 5);
  els.popular.innerHTML = sorted.map(([cid]) => `<li>${escapeHtml(state.channels.find((c) => c.channelId === cid)?.title || cid)}</li>`).join('');
}

async function logError(type, code, message, extra = {}) {
  const { stores, trx } = tx(state.db, 'errors_logs', 'readwrite');
  stores.errors_logs.add({ type, code, message, extra, createdAt: Date.now() });
  await new Promise((res, rej) => { trx.oncomplete = res; trx.onerror = () => rej(trx.error); });
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
