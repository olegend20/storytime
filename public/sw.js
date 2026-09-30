/* StoryTime service worker: saved stories read without a signal (DECISIONS #145).
 *
 * What is cached, and how:
 *  - the app's own static files (/_next/static/...): cache-first, they are content-hashed;
 *  - GET requests for stories (/api/stories, /api/stories/:id, and the mock backend's):
 *    network-first, falling back to the last copy;
 *  - page navigations to the library and a story: network-first, falling back to the last
 *    copy of that page.
 * Nothing else is cached. Generation is a POST and never touches this file, and quota,
 * children and family data are always fetched live.
 */
const VERSION = 'storytime-v1'
const STATIC = `${VERSION}-static`
const STORIES = `${VERSION}-stories`
const PAGES = `${VERSION}-pages`

const STORY_API = /^\/api\/(?:mock\/)?stories(?:\/[^/]+)?$/

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

async function networkFirst(cacheName, request) {
  const cache = await caches.open(cacheName)
  try {
    const fresh = await fetch(request)
    if (fresh.ok) cache.put(request, fresh.clone())
    return fresh
  } catch (err) {
    const cached = await cache.match(request)
    if (cached) return cached
    throw err
  }
}

async function cacheFirst(cacheName, request) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  if (cached) return cached
  const fresh = await fetch(request)
  if (fresh.ok) cache.put(request, fresh.clone())
  return fresh
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(STATIC, request))
    return
  }
  if (STORY_API.test(url.pathname)) {
    event.respondWith(networkFirst(STORIES, request))
    return
  }
  if (
    request.mode === 'navigate' &&
    (url.pathname === '/library' || url.pathname.startsWith('/stories/'))
  ) {
    event.respondWith(networkFirst(PAGES, request))
  }
})
