const views = [...document.querySelectorAll('.view')];
const navButtons = [...document.querySelectorAll('[data-view]')];
const channelsList = document.querySelector('#channelsList');
const popularChannels = document.querySelector('#popularChannels');
const feed = document.querySelector('#feed');
const cardTemplate = document.querySelector('#video-card-template');

for (const button of navButtons) {
  button.addEventListener('click', () => {
    const target = button.dataset.view;
    for (const view of views) {
      view.classList.toggle('active', view.id === `view-${target}`);
    }
  });
}

function seedFeed() {
  const fakeCards = Array.from({ length: 9 }).map((_, i) => ({
    title: `Демо видео #${i + 1}`,
    meta: `Общий канал · ${1000 + i * 37} просмотров`,
  }));

  for (const item of fakeCards) {
    const node = cardTemplate.content.cloneNode(true);
    node.querySelector('.title').textContent = item.title;
    node.querySelector('.meta').textContent = item.meta;
    feed.append(node);
  }
}

async function loadChannels() {
  const res = await fetch('/api/channels');
  const channels = await res.json();

  channelsList.innerHTML = '';
  popularChannels.innerHTML = '';

  for (const channel of channels) {
    const li = document.createElement('li');
    li.textContent = `${channel.title} — ${channel.video_count} видео`;
    channelsList.append(li);

    const p = document.createElement('li');
    p.textContent = channel.title;
    popularChannels.append(p);
  }
}

seedFeed();
loadChannels().catch((error) => {
  console.error('Cannot load channels', error);
});
