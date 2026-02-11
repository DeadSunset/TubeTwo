# Offline myTube (scaffold)

Локальный оффлайн-каркас приложения в стиле YouTube.

## Быстрый старт (Windows)
1. Установите Node.js LTS: https://nodejs.org/
2. Откройте эту папку.
3. Запустите `start.bat` двойным кликом.

Скрипт сам:
- установит зависимости при первом запуске,
- поднимет локальный сервер,
- откроет браузер на `http://localhost:3210`.

## Что уже есть
- Node.js + Express API
- SQLite (`data/mytube.db`) автосоздание
- Папки `data/thumbnails` и `data/logs`
- Базовая схема таблиц для каналов/видео/комментов/логов
- UI shell с разделами Main/Shorts/Channels/Profile

## Команды для разработки
```bash
npm install --prefix app
npm run --prefix app start
npm run --prefix app check
```

## Документация
Подробное ТЗ: `docs/TZ-offline-mytube.md`
