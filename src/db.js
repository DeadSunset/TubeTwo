const DB_NAME = 'mytube-offline';
const DB_VERSION = 1;

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const sources = db.createObjectStore('sources', { keyPath: 'sourceId' });
      sources.createIndex('byType', 'type');
      const channels = db.createObjectStore('channels', { keyPath: 'channelId' });
      channels.createIndex('bySource', 'sourceId');
      const videos = db.createObjectStore('videos', { keyPath: 'videoKey' });
      videos.createIndex('byChannel', 'channelId');
      videos.createIndex('byType', 'type');
      videos.createIndex('byWatched', 'lastWatchedAt');
      db.createObjectStore('comments_user', { keyPath: 'id', autoIncrement: true }).createIndex('byVideo', 'videoKey');
      db.createObjectStore('comments_imported', { keyPath: 'videoKey' });
      db.createObjectStore('errors_logs', { keyPath: 'id', autoIncrement: true }).createIndex('byType', 'type');
      db.createObjectStore('thumbs', { keyPath: 'videoKey' });
      db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function tx(db, storeNames, mode = 'readonly') {
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  const trx = db.transaction(names, mode);
  return { trx, stores: Object.fromEntries(names.map((n) => [n, trx.objectStore(n)])) };
}

export function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll(db, storeName) {
  const { stores } = tx(db, storeName);
  return reqP(stores[storeName].getAll());
}

export async function putMany(db, storeName, items) {
  const { trx, stores } = tx(db, storeName, 'readwrite');
  items.forEach((i) => stores[storeName].put(i));
  return new Promise((resolve, reject) => {
    trx.oncomplete = resolve;
    trx.onerror = () => reject(trx.error);
  });
}

export async function deleteByKey(db, storeName, key) {
  const { trx, stores } = tx(db, storeName, 'readwrite');
  stores[storeName].delete(key);
  return new Promise((resolve, reject) => {
    trx.oncomplete = resolve;
    trx.onerror = () => reject(trx.error);
  });
}
