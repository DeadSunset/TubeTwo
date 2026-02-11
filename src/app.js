import { openDb, tx, reqP, getAll, putMany, deleteByKey } from './db.js';
import { BatchQueue } from './queue.js';
import { COMMON_CHANNEL_ID, uid, isVideoFile, formatDuration, escapeHtml, permissionOk, readVideoMeta, detectType, makeThumb, tokenize } from './utils.js';

const state = {
  db: null,
  route: location.hash || '#/',
  search: '',
  sources: [],
  channels: [],
  videos: [],
};

const els = {
  view: document.getElementById('routeView'),
  search: document.getElementById('globalSearch'),
  task: document.getElementById('taskPanel'),
  popular: document.getElementById('popularChannels'),
};

await init();

async function init() {
  state.db = await openDb();
  await ensureSystemChannel();
  await hydrate();
  bindTopBar();
  window.addEventListener('hashchange', () => { state.route = location.hash || '#/'; render(); });
  await revalidateSources();
  render();
}

function bindTopBar() {
  els.search.oninput = () => { state.search = els.search.value.trim().toLowerCase(); render(); };
  document.getElementById('addCommonBtn').onclick = () => addSource('common');
  document.getElementById('addChannelBtn').onclick = () => addSource('channel');
  document.getElementById('addVideoBtn').onclick = () => addVideoFiles();
  document.getElementById('profileBtn').onclick = () => location.hash = '#/profile';
}

async function ensureSystemChannel() {
  const { stores, trx } = tx(state.db, 'channels', 'readwrite');
  stores.channels.put({ channelId: COMMON_CHANNEL_ID, title: 'Общий канал', sourceId: 'system', system: true });
  await done(trx);
}

async function hydrate() {
  state.sources = await getAll(state.db, 'sources');
  state.channels = await getAll(state.db, 'channels');
  state.videos = await getAll(state.db, 'videos');
  refreshPopularChannels();
}

async function revalidateSources() {
  for (const s of state.sources) {
    const ok = await safePermission(s.handle);
    await markSourceAvailability(s.sourceId, ok);
  }
  await hydrate();
}

async function safePermission(handle) {
  try {
    return await permissionOk(handle);
  } catch {
    return false;
  }
}

function render() {
  const route = state.route.replace(/^#/, '');
  if (!state.videos.length && route === '/') return renderEmpty();
  if (route.startsWith('/video/')) return renderVideoPage(decodeURIComponent(route.slice('/video/'.length)));
  if (route.startsWith('/channel/')) return renderSingleChannel(decodeURIComponent(route.slice('/channel/'.length)));
  if (route === '/channels') return renderChannels();
  if (route === '/shorts') return renderFeed({ shortsOnly: true });
  if (route === '/watched') return renderFeed({ watchedOnly: true });
  if (route === '/liked') return renderFeed({ likedOnly: true });
  if (route === '/profile') return renderProfile();
  return renderFeed({});
}

function renderEmpty() {
  const node = document.getElementById('emptyState').content.cloneNode(true);
  node.querySelectorAll('[data-add]').forEach((b) => {
    b.onclick = () => {
      const t = b.dataset.add;
      if (t === 'common') addSource('common');
      if (t === 'channel') addSource('channel');
      if (t === 'video') addVideoFiles();
    };
  });
  els.view.replaceChildren(node);
}

function renderFeed({ shortsOnly = false, watchedOnly = false, likedOnly = false }) {
  let list = state.videos.filter(matchesSearch);
  if (shortsOnly) list = list.filter((v) => v.type === 'shorts');
  if (watchedOnly) list = list.filter((v) => (v.viewsLocal || 0) > 0);
  if (likedOnly) list = list.filter((v) => !!v.likedByMe);
  list = list.sort(() => Math.random() - 0.5);

  els.view.innerHTML = `<div class="panel filters">
    <select id="fltType"><option value="">Тип</option><option value="video">Видео</option><option value="shorts">Шортсы</option></select>
    <input id="fltDur" type="number" placeholder="Мин. длит., сек" />
    <input id="fltViews" type="number" placeholder="Мин. просмотры" />
    <select id="fltChannel"><option value="">Канал</option>${state.channels.map((c) => `<option value="${c.channelId}">${escapeHtml(c.title)}</option>`).join('')}</select>
  </div>
  <div class="grid" id="feedGrid">${list.map(renderCard).join('')}</div>`;

  const apply = () => {
    const type = q('fltType').value;
    const minDur = Number(q('fltDur').value || 0);
    const minViews = Number(q('fltViews').value || 0);
    const channelId = q('fltChannel').value;
    const filtered = list.filter((v) => {
      const views = v.viewsOnline ?? v.viewsLocal ?? 0;
      return (!type || v.type === type) && (!channelId || v.channelId === channelId) && (!minDur || v.duration >= minDur) && views >= minViews;
    });
    q('feedGrid').innerHTML = filtered.map(renderCard).join('');
    bindCards();
  };

  ['fltType', 'fltDur', 'fltViews', 'fltChannel'].forEach((id) => q(id).oninput = apply);
  bindCards();
}

function renderChannels() {
  const channels = state.channels.filter((c) => c.channelId === COMMON_CHANNEL_ID || !c.system);
  els.view.innerHTML = channels.map((c) => {
    const count = state.videos.filter((v) => v.channelId === c.channelId).length;
    return `<article class="channel-row">
      <div class="panel channel-box"><div class="avatar"></div><div><h2>${escapeHtml(c.title)}</h2><div>${count} видео</div></div></div>
      <div class="channel-actions">
        <button class="btn" data-open="${c.channelId}">Открыть канал</button>
        <button class="btn" data-add="${c.channelId}">Добавить видео</button>
        ${c.channelId !== COMMON_CHANNEL_ID ? `<button class="btn secondary" data-remove="${c.channelId}">Удалить канал</button>` : ''}
      </div>
    </article>`;
  }).join('');

  els.view.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => location.hash = `#/channel/${encodeURIComponent(b.dataset.open)}`);
  els.view.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => addVideoFiles(b.dataset.add));
  els.view.querySelectorAll('[data-remove]').forEach((b) => b.onclick = () => removeChannel(b.dataset.remove));
}

function renderSingleChannel(channelId) {
  const channel = state.channels.find((c) => c.channelId === channelId);
  if (!channel) return renderChannels();
  const channelVideos = state.videos.filter((v) => v.channelId === channelId).filter(matchesSearch);
  const playlists = [...new Set(channelVideos.map((v) => v.playlistPath || '').filter(Boolean))];

  els.view.innerHTML = `<article class="panel"><h1>${escapeHtml(channel.title)}</h1><div>${channelVideos.length} видео</div>
    <div class="actions-inline">
      <button class="btn" id="batchImportBtn">Общий парсинг URL/HTML/комментариев/лайков/названий/просмотров</button>
      <button class="btn" id="addToChannelBtn">Добавить видео на этот канал</button>
      <button class="btn" id="refreshChannelBtn">Обновить все видео</button>
    </div>
  </article>
  <div class="panel filters"><select id="playlistFilter"><option value="">Все плейлисты</option>${playlists.map((p) => `<option>${escapeHtml(p)}</option>`).join('')}</select></div>
  <div class="grid" id="channelGrid">${channelVideos.map(renderCard).join('')}</div>`;

  q('addToChannelBtn').onclick = () => addVideoFiles(channelId);
  q('refreshChannelBtn').onclick = () => rescanChannel(channelId);
  q('batchImportBtn').onclick = () => batchImportChannel(channelId);
  q('playlistFilter').onchange = () => {
    const filter = q('playlistFilter').value;
    const filtered = filter ? channelVideos.filter((v) => v.playlistPath === filter) : channelVideos;
    q('channelGrid').innerHTML = filtered.map(renderCard).join('');
    bindCards();
  };

  bindCards();
}

async function renderVideoPage(videoKey) {
  const video = state.videos.find((v) => v.videoKey === videoKey);
  if (!video) return renderFeed({});

  let src = '';
  if (video.fileHandle && video.availability !== 'missing') {
    const file = await video.fileHandle.getFile().catch(() => null);
    if (file) src = URL.createObjectURL(file);
  }

  const imported = await reqP(tx(state.db, 'comments_imported').stores.comments_imported.get(videoKey));
  const userComments = await reqP(tx(state.db, 'comments_user').stores.comments_user.index('byVideo').getAll(videoKey));
  const comments = [...(imported?.items || []), ...userComments.map((x) => ({ author: 'Вы', text: x.text }))];

  els.view.innerHTML = `<div class="video-layout">
    <div>
      <video id="videoPlayer" class="player" controls autoplay ${src ? `src="${src}"` : ''}></video>
      <article class="panel">
        <h2>${escapeHtml(video.title)}</h2>
        <div>${escapeHtml(channelName(video.channelId))}</div>
        <div>Online просмотры: ${(video.viewsOnline || 0).toLocaleString('ru-RU')}</div>
        <div>Local просмотры: ${(video.viewsLocal || 0).toLocaleString('ru-RU')}</div>
        <div class="actions-inline"><button id="likeBtn" class="btn">${video.likedByMe ? 'Убрать лайк' : 'Лайк'}</button></div>
      </article>
      <article class="panel">
        <h3>Добавить комментарий</h3>
        <textarea id="newComment" placeholder="Текст комментария"></textarea>
        <button class="btn" id="sendCommentBtn">Отправить</button>
      </article>
    </div>
    <aside class="panel">
      <h3>Комментарии</h3>
      <div class="comments">${comments.map((c) => `<div class="comment"><b>@${escapeHtml(c.author || 'user')}</b><div>${escapeHtml(c.text || '')}</div></div>`).join('')}</div>
      <h3>Рекомендации</h3>
      ${recommend(video).slice(0, 10).map((v) => `<div><a href="#/video/${encodeURIComponent(v.videoKey)}">${escapeHtml(v.title)}</a></div>`).join('')}
    </aside>
  </div>`;

  const player = q('videoPlayer');
  if (video.lastTimeSec && src) player.currentTime = video.lastTimeSec;

  let viewed = false;
  const timer = setInterval(() => {
    if (!src) return;
    updateVideo(videoKey, {
      lastTimeSec: player.currentTime,
      isFinished: player.duration ? player.currentTime / player.duration >= 0.98 : false,
      lastWatchedAt: Date.now(),
    });
  }, 5000);

  player.onended = () => updateVideo(videoKey, { isFinished: true, lastTimeSec: player.duration || video.lastTimeSec || 0 });
  player.ontimeupdate = () => {
    if (!viewed && player.currentTime >= 2) {
      viewed = true;
      updateVideo(videoKey, { viewsLocal: (video.viewsLocal || 0) + 1, lastWatchedAt: Date.now() });
    }
  };

  q('likeBtn').onclick = async () => {
    await updateVideo(videoKey, { likedByMe: !video.likedByMe });
    await hydrate();
    renderVideoPage(videoKey);
  };

  q('sendCommentBtn').onclick = async () => {
    const text = q('newComment').value.trim();
    if (!text) return;
    const { stores, trx } = tx(state.db, 'comments_user', 'readwrite');
    stores.comments_user.add({ videoKey, text, createdAt: Date.now() });
    await done(trx);
    renderVideoPage(videoKey);
  };

  window.onbeforeunload = () => { player.pause(); clearInterval(timer); };
  bindPlayerKeys(player);
}

async function addSource(type) {
  if (!window.showDirectoryPicker) return alert('File System Access API не поддерживается');
  try {
    const handle = await window.showDirectoryPicker();
    const source = { sourceId: uid('src'), type, name: handle.name, handle, createdAt: Date.now(), access: 'ok' };
    await putMany(state.db, 'sources', [source]);
    await scanSource(source, { fullRescan: true, withProgress: true });
    await hydrate();
    render();
  } catch (e) {
    await logError('source', 'ADD_SOURCE', String(e?.message || e));
  }
}

async function addVideoFiles(channelId = COMMON_CHANNEL_ID) {
  if (!window.showOpenFilePicker) return alert('Выбор файлов не поддерживается');
  try {
    const handles = await window.showOpenFilePicker({ multiple: true });
    const videos = [];
    for (const fh of handles) {
      const file = await fh.getFile();
      if (!isVideoFile(file.name)) continue;
      const meta = await readVideoMeta(file);
      videos.push({
        videoKey: `${channelId}/${file.name}/${crypto.randomUUID()}`,
        sourceId: 'manual',
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
    if (videos.length) {
      await putMany(state.db, 'videos', videos);
      await runThumbQueue(videos, 'Генерация превью для добавленных видео');
      await hydrate();
      render();
    }
  } catch (e) {
    await logError('video', 'ADD_VIDEO', String(e?.message || e));
  }
}

async function scanSource(source, { fullRescan = false, withProgress = true } = {}) {
  const allowed = await safePermission(source.handle);
  if (!allowed) {
    await markSourceAvailability(source.sourceId, false);
    return;
  }

  if (fullRescan) {
    const old = state.videos.filter((v) => v.sourceId === source.sourceId);
    for (const v of old) await deleteByKey(state.db, 'videos', v.videoKey);
  }

  const discovered = [];

  const scanChannelRoot = async (dirHandle, channelId, prefix = '', playlistRoot = '') => {
    for await (const [name, entry] of dirHandle.entries()) {
      const relPath = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === 'file' && isVideoFile(name)) {
        const file = await entry.getFile();
        const meta = await readVideoMeta(file);
        discovered.push({
          videoKey: `${source.sourceId}/${relPath}/${name}`,
          sourceId: source.sourceId,
          fileHandle: entry,
          title: file.name.replace(/\.[^.]+$/, ''),
          channelId,
          playlistPath: playlistRoot,
          duration: meta.duration,
          type: detectType(meta.duration, meta.width, meta.height),
          availability: 'ok',
          viewsLocal: 0,
          likedByMe: false,
        });
      }
      if (entry.kind === 'directory') {
        const nextPlaylist = playlistRoot ? `${playlistRoot}/${name}` : name;
        await scanChannelRoot(entry, channelId, relPath, nextPlaylist);
      }
    }
  };

  const walkCommon = async () => {
    // 1) root files -> Общий канал
    for await (const [name, entry] of source.handle.entries()) {
      if (entry.kind === 'file' && isVideoFile(name)) {
        const file = await entry.getFile();
        const meta = await readVideoMeta(file);
        discovered.push({
          videoKey: `${source.sourceId}/${name}/${name}`,
          sourceId: source.sourceId,
          fileHandle: entry,
          title: file.name.replace(/\.[^.]+$/, ''),
          channelId: COMMON_CHANNEL_ID,
          playlistPath: '',
          duration: meta.duration,
          type: detectType(meta.duration, meta.width, meta.height),
          availability: 'ok',
          viewsLocal: 0,
          likedByMe: false,
        });
      }
    }

    // 2) first-level folders -> отдельные каналы
    for await (const [name, entry] of source.handle.entries()) {
      if (entry.kind !== 'directory') continue;
      const channelId = `ch-${source.sourceId}-${name}`;
      await putMany(state.db, 'channels', [{ channelId, sourceId: source.sourceId, title: name }]);
      await scanChannelRoot(entry, channelId, name, '');
    }
  };

  const walkSingleChannel = async () => {
    const channelId = `ch-${source.sourceId}`;
    await putMany(state.db, 'channels', [{ channelId, sourceId: source.sourceId, title: source.name }]);
    await scanChannelRoot(source.handle, channelId, '', '');
  };

  if (withProgress) setTaskPanel('Сканирование папки...', 0);
  if (source.type === 'common') await walkCommon();
  if (source.type === 'channel') await walkSingleChannel();

  if (discovered.length) {
    await putMany(state.db, 'videos', discovered);
    if (withProgress) setTaskPanel('Сканирование завершено. Генерация превью...', 15);
    await runThumbQueue(discovered, 'Генерация превью');
  }

  hideTaskPanel();
}

async function rescanChannel(channelId) {
  const channel = state.channels.find((c) => c.channelId === channelId);
  if (!channel || channel.sourceId === 'system') return;
  const source = state.sources.find((s) => s.sourceId === channel.sourceId);
  if (!source) return;
  await scanSource(source, { fullRescan: true, withProgress: true });
  await hydrate();
  renderSingleChannel(channelId);
}

async function runThumbQueue(videos, title = 'Генерация превью') {
  if (!videos.length) return;

  const queue = new BatchQueue({
    batchSize: 10,
    onProgress: ({ done, total }) => {
      const p = total ? Math.round((done / total) * 100) : 0;
      setTaskPanel(`${title}: ${done}/${total}`, p, queue);
    },
  });

  videos.forEach((video) => queue.add(async () => {
    try {
      const file = await video.fileHandle.getFile();
      const thumbBlob = await makeThumb(file);
      const { stores, trx } = tx(state.db, ['thumbs', 'videos'], 'readwrite');
      stores.thumbs.put({ videoKey: video.videoKey, thumbBlob });
      const cur = await reqP(stores.videos.get(video.videoKey));
      if (cur) stores.videos.put({ ...cur, thumbUrl: URL.createObjectURL(thumbBlob) });
      await done(trx);
    } catch (e) {
      await logError('thumb', 'THUMB_GENERATION', String(e?.message || e), { videoKey: video.videoKey });
    }
  }));

  setTaskPanel(`${title}: 0/${videos.length}`, 0, queue);
  await queue.run();
  hideTaskPanel();
}

async function batchImportChannel(channelId) {
  const videos = state.videos.filter((v) => v.channelId === channelId);
  if (!videos.length) return;
  const queue = new BatchQueue({
    batchSize: 10,
    onProgress: ({ done, total }) => setTaskPanel(`Импорт данных канала: ${done}/${total}`, Math.round((done / total) * 100), queue),
  });

  videos.forEach((v) => queue.add(async () => {
    const viewsOnline = Math.floor(Math.random() * 1_500_000);
    await updateVideo(v.videoKey, { viewsOnline, likesOnline: Math.floor(viewsOnline * 0.03) });
  }));

  setTaskPanel(`Импорт данных канала: 0/${videos.length}`, 0, queue);
  await queue.run();
  hideTaskPanel();
  await hydrate();
  renderSingleChannel(channelId);
}

async function removeChannel(channelId) {
  await deleteByKey(state.db, 'channels', channelId);
  const ownVideos = state.videos.filter((v) => v.channelId === channelId);
  for (const v of ownVideos) await deleteByKey(state.db, 'videos', v.videoKey);
  await hydrate();
  renderChannels();
}

function renderProfile() {
  const apiKey = localStorage.getItem('ytApiKey') || '';
  els.view.innerHTML = `<article class="panel">
    <h1>Профиль</h1>
    <div class="actions-inline">
      <button class="btn" id="backupBtn">Сделать бэкап данных программы</button>
      <button class="btn" id="importBackupBtn">Импортировать бэкап данных</button>
      <button class="btn" id="exportMissingBtn">Экспортировать список видео без превью/комментариев</button>
    </div>
    <input id="apiKeyInput" placeholder="Ключ API KEY Youtube Data API v3" value="${escapeHtml(apiKey)}" />
    <h3>Источники</h3>
    <div>${state.sources.map((s) => `<div class="comment">${escapeHtml(s.name)} — ${s.access === 'missing' ? 'Нет доступа' : 'ОК'} ${s.access === 'missing' ? `<button class="btn" data-restore="${s.sourceId}">Восстановить доступ</button>` : ''}</div>`).join('') || '<div class="comment">Нет источников</div>'}</div>
    <h3>Ошибки / логи</h3>
    <div id="logsWrap"></div>
  </article>`;

  q('apiKeyInput').onchange = (e) => localStorage.setItem('ytApiKey', e.target.value.trim());
  q('backupBtn').onclick = backupExport;
  q('importBackupBtn').onclick = backupImport;
  q('exportMissingBtn').onclick = exportMissing;
  els.view.querySelectorAll('[data-restore]').forEach((b) => b.onclick = () => restoreSource(b.dataset.restore));
  renderLogs();
}

async function restoreSource(sourceId) {
  const source = state.sources.find((s) => s.sourceId === sourceId);
  if (!source) return;
  const ok = await safePermission(source.handle);
  await markSourceAvailability(source.sourceId, ok);
  await hydrate();
  renderProfile();
}

async function renderLogs() {
  const logs = await getAll(state.db, 'errors_logs');
  const wrap = document.getElementById('logsWrap');
  if (!wrap) return;
  wrap.innerHTML = logs.slice(-100).reverse().map((l) => `<div class="comment"><b>${escapeHtml(l.type)}</b> [${escapeHtml(l.code || '')}]<div>${escapeHtml(l.message || '')}</div></div>`).join('') || '<div class="comment">Логов нет</div>';
}

async function markSourceAvailability(sourceId, isAvailable) {
  const { stores, trx } = tx(state.db, ['sources', 'videos'], 'readwrite');
  const src = await reqP(stores.sources.get(sourceId));
  if (src) stores.sources.put({ ...src, access: isAvailable ? 'ok' : 'missing' });

  const all = await reqP(stores.videos.getAll());
  all.filter((v) => v.sourceId === sourceId).forEach((v) => {
    stores.videos.put({
      ...v,
      availability: isAvailable ? 'ok' : 'missing',
      missingReason: isAvailable ? '' : 'Видео недоступно — папка не найдена',
    });
  });
  await done(trx);
}

async function updateVideo(videoKey, patch) {
  const { stores, trx } = tx(state.db, 'videos', 'readwrite');
  const cur = await reqP(stores.videos.get(videoKey));
  if (cur) stores.videos.put({ ...cur, ...patch });
  await done(trx);
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
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `mytube-backup-${new Date().toISOString().slice(0, 10)}.json`);
}

async function backupImport() {
  if (!window.showOpenFilePicker) return;
  const [handle] = await window.showOpenFilePicker({ types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }] });
  const data = JSON.parse(await (await handle.getFile()).text());

  await putMany(state.db, 'channels', data.db?.channels || []);

  const currentVideos = new Map((await getAll(state.db, 'videos')).map((v) => [v.videoKey, v]));
  const incomingVideos = data.db?.videos || [];
  const merged = [...currentVideos.values()];

  const weight = (v) => Number(!!v.thumbUrl) + Number(!!v.viewsOnline || !!v.likesOnline) + Number((v.commentsImported || 0) > 0) + Number(!!v.lastTimeSec || !!v.lastWatchedAt);

  for (const incoming of incomingVideos) {
    const cur = currentVideos.get(incoming.videoKey);
    if (!cur) {
      merged.push(incoming);
      continue;
    }
    if (weight(incoming) > weight(cur)) Object.assign(cur, incoming);
  }

  await putMany(state.db, 'videos', merged);
  await putMany(state.db, 'comments_imported', data.db?.comments_imported || []);
  await putMany(state.db, 'errors_logs', data.db?.errors_logs || []);
  localStorage.setItem('ytApiKey', data.localStorage?.ytApiKey || '');

  await hydrate();
  render();
}

function exportMissing() {
  const data = state.videos.filter((v) => !v.thumbUrl || !(v.viewsOnline || v.likesOnline));
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'videos-missing-data.json');
}

function renderCard(v) {
  const progress = v.duration ? Math.min(100, Math.round(((v.lastTimeSec || 0) / v.duration) * 100)) : 0;
  const views = v.viewsOnline ?? v.viewsLocal ?? 0;
  return `<article class="card" data-video="${v.videoKey}">
    <img class="thumb" loading="lazy" alt="thumbnail" src="${v.thumbUrl || ''}" />
    <span class="dur">${formatDuration(v.duration)}</span>
    <div class="progress"><span style="width:${progress}%"></span></div>
    <div class="card-body">
      <h3 class="title">${escapeHtml(v.title)}</h3>
      <div class="meta"><span>${escapeHtml(channelName(v.channelId))}</span><span>${views.toLocaleString('ru-RU')} просмотров</span></div>
      ${v.availability === 'missing' ? `<div class="warn">Видео недоступно — папка не найдена</div>` : ''}
    </div>
  </article>`;
}

function bindCards() {
  els.view.querySelectorAll('[data-video]').forEach((el) => {
    el.onclick = () => location.hash = `#/video/${encodeURIComponent(el.dataset.video)}`;
  });
}

function recommend(base) {
  const baseWords = new Set(tokenize(base.title));
  return [...state.videos]
    .filter((v) => v.videoKey !== base.videoKey)
    .map((v) => ({
      v,
      score: (v.channelId === base.channelId ? 100 : 0) + tokenize(v.title).filter((w) => baseWords.has(w)).length * 8 - ((v.viewsLocal || 0) > 0 ? 4 : 0),
    }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.v);
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

function refreshPopularChannels() {
  const map = new Map();
  for (const v of state.videos) {
    if ((v.viewsLocal || 0) <= 0) continue;
    if (!map.has(v.channelId)) map.set(v.channelId, new Set());
    map.get(v.channelId).add(v.videoKey);
  }
  const top = [...map.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 5);
  els.popular.innerHTML = top.map(([cid]) => `<li>${escapeHtml(channelName(cid))}</li>`).join('') || '<li>Нет данных</li>';
}

function matchesSearch(video) {
  if (!state.search) return true;
  return `${video.title} ${channelName(video.channelId)}`.toLowerCase().includes(state.search);
}

function channelName(id) {
  return state.channels.find((c) => c.channelId === id)?.title || 'Без канала';
}

async function logError(type, code, message, extra = {}) {
  const { stores, trx } = tx(state.db, 'errors_logs', 'readwrite');
  stores.errors_logs.add({ type, code, message, extra, createdAt: Date.now() });
  await done(trx);
}

function setTaskPanel(label, progressValue = 0, queue = null) {
  els.task.classList.remove('hidden');
  els.task.innerHTML = `<div class="task-row"><div>${escapeHtml(label)}</div>
    <button class="btn secondary" id="taskPause">Пауза</button>
    <button class="btn secondary" id="taskResume">Продолжить</button>
    <button class="btn secondary" id="taskCancel">Отмена</button></div>
    <progress max="100" value="${progressValue}"></progress>`;

  q('taskPause').onclick = () => queue?.pause();
  q('taskResume').onclick = () => queue?.resume();
  q('taskCancel').onclick = () => queue?.cancel();
}

function hideTaskPanel() {
  els.task.classList.add('hidden');
  els.task.innerHTML = '';
}

function q(id) { return document.getElementById(id); }

function done(trx) {
  return new Promise((resolve, reject) => {
    trx.oncomplete = resolve;
    trx.onerror = () => reject(trx.error);
  });
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
