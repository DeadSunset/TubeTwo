const videoExt = new Set(['mp4', 'mkv', 'webm', 'mov', 'm4v', 'avi']);

export const COMMON_CHANNEL_ID = 'system-common';

export const uid = (prefix = 'id') => `${prefix}-${crypto.randomUUID()}`;

export function isVideoFile(name) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return videoExt.has(ext);
}

export function formatDuration(sec = 0) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

export function escapeHtml(str = '') {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export async function permissionOk(handle, mode = 'read') {
  const q = await handle.queryPermission({ mode });
  if (q === 'granted') return true;
  const r = await handle.requestPermission({ mode });
  return r === 'granted';
}

export async function readVideoMeta(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.src = url;
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = reject;
  });
  const meta = {
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    width: video.videoWidth || 0,
    height: video.videoHeight || 0,
  };
  URL.revokeObjectURL(url);
  return meta;
}

export function detectType(duration, width, height) {
  const ratio = width && height ? width / height : 0;
  const nearVertical = Math.abs(ratio - (9 / 16)) < 0.2;
  return duration <= 60 && nearVertical ? 'shorts' : 'video';
}

export async function makeThumb(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'metadata';
  video.src = url;

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = reject;
  });

  const start = Math.min(5, Math.max(1, video.duration * 0.08));
  const end = Math.max(start + 1, video.duration - 1);
  video.currentTime = start + Math.random() * Math.max(1, end - start);
  await new Promise((resolve) => (video.onseeked = resolve));

  const canvas = document.createElement('canvas');
  const width = 320;
  const height = Math.round((video.videoHeight / video.videoWidth) * width) || 180;
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(video, 0, 0, width, height);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
  URL.revokeObjectURL(url);
  return blob;
}

export function tokenize(title='') {
  return title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
