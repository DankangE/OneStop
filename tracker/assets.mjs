import { fileURLToPath } from 'node:url';

export const publicFileUrls = [
  new URL('./public/index.html', import.meta.url),
  new URL('./public/styles.css', import.meta.url),
  new URL('./public/app.js', import.meta.url),
  new URL('./public/api.js', import.meta.url),
  new URL('./public/views.js', import.meta.url),
  new URL('./public/tree.js', import.meta.url),
  new URL('./public/calendar.js', import.meta.url),
  new URL('./public/home.js', import.meta.url),
  new URL('./public/theme.js', import.meta.url),
  new URL('./public/favicon.svg', import.meta.url)
];

export const modulePublicDir = fileURLToPath(new URL('./public/', import.meta.url));
