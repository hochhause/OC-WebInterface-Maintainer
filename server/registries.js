import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const dir = dirname(fileURLToPath(import.meta.url))

/**
 * Item registries, keyed by id.
 *
 * Only GTNH 2.9 exists today. To plug in another modpack version:
 *   1. drop <id>.json into client/public/registries/  (same shape: [{label, x, y}, ...])
 *   2. add an entry below
 *   3. point a network at it via the networks.registry column
 * Nothing else in the codebase needs to change.
 */
export const REGISTRIES = {
  'gtnh-2.9': { label: 'GTNH 2.9', file: 'gtnh-2.9.json', atlas: '/atlas.webp' }
}

export const DEFAULT_REGISTRY = 'gtnh-2.9'

// Built client output first (always present in a deployment), repo source second (vite dev).
const SEARCH_DIRS = [
  resolve(dir, 'public/registries'),
  resolve(dir, '../client/public/registries')
]

const cache = new Map()

export function isRegistry(id) {
  return Object.hasOwn(REGISTRIES, id)
}

export function getRegistry(id) {
  const key = isRegistry(id) ? id : DEFAULT_REGISTRY
  if (cache.has(key)) return cache.get(key)

  const meta = REGISTRIES[key]
  const path = SEARCH_DIRS.map(d => resolve(d, meta.file)).find(existsSync)
  if (!path) throw new Error(`registry file not found: ${meta.file} (searched ${SEARCH_DIRS.join(', ')})`)

  const items = JSON.parse(readFileSync(path, 'utf8'))
  const entry = {
    id: key,
    ...meta,
    icons: new Map(items.map(i => [i.label, { x: i.x, y: i.y }]))
  }
  cache.set(key, entry)
  return entry
}
