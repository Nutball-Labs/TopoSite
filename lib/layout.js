// layout.js — Maps, backgrounds and node positions (MAPS.md "Data model"),
// stored as <store>/toposite/layout.json with images in <store>/toposite/images/.
//
// Version 2: one tree per map. A map's positions are nested inside it.
//   settings     { defaultMapId }
//   backgrounds  library of images: { id, name, image, imageDark?, widthPx, heightPx }
//   maps         { id, name, layout: 'graph' | 'placed', builtin?, widthPx, heightPx,
//                  metersPerPixel, background: null | { id, imageRect }, nodes, view,
//                  placements: [{ deviceKey, x, y, seen? } | { id, deviceKey: null, x, y, placeholder }] }
// Positions are canvas pixels: x right, y down, origin at the canvas's top-left.
// Only version 2 is read (the v1 → v2 migration ran once on the one install that
// had v1 data and was removed). Image files are never shared between two
// backgrounds, so deleting one background can't break another.

import { randomBytes } from 'node:crypto'
import { copyFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { readJSON, writeAtomic } from './store.js'

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024
export const VERSION = 2
export const GRAPH_ID = 'graph'
const MAX_DIMENSION = 20000
const MAX_EXCEPTIONS = 5000

// Background image variants → background field
export const VARIANTS = { light: 'image', dark: 'imageDark' }
const DEFAULT_LAYERS = { routes: true, backupRoutes: false, neighbors: true, nodes: true, health: true, battery: false }

const graphMap = () => ({
    id: GRAPH_ID,
    name: 'Network Graph',
    builtin: true,
    layout: 'graph',
    nodes: { start: 'include', exceptions: [] },
    view: { center: null, zoom: null, layers: { ...DEFAULT_LAYERS } },
})
const empty = () => ({ version: VERSION, settings: { defaultMapId: GRAPH_ID }, backgrounds: [], maps: [graphMap()] })

/**
 * Identify an image by its first bytes. Only raster formats: SVG is refused
 * because it can carry script, and these images are served from Z-Wave JS UI's
 * origin. Returns { ext, type } or null.
 */
export function sniffImage(buf) {
    if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return { ext: 'png', type: 'image/png' }
    }
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        return { ext: 'jpg', type: 'image/jpeg' }
    }
    if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        return { ext: 'webp', type: 'image/webp' }
    }
    return null
}

/** Pixel size read from the image header (PNG, JPEG, WebP), or null if it can't be read. */
export function imageSize(buf) {
    try {
        const kind = sniffImage(buf)?.ext
        if (kind === 'png' && buf.length >= 24) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
        if (kind === 'jpg') {
            for (let i = 2; i + 9 < buf.length;) {
                if (buf[i] !== 0xff) return null
                const m = buf[i + 1]
                if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
                    return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) }
                }
                i += 2 + buf.readUInt16BE(i + 2)
            }
        }
        if (kind === 'webp' && buf.length >= 30) {
            const chunk = buf.toString('ascii', 12, 16)
            if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff }
            if (chunk === 'VP8L') {
                const b = buf.readUInt32LE(21)
                return { w: (b & 0x3fff) + 1, h: ((b >>> 14) & 0x3fff) + 1 }
            }
            if (chunk === 'VP8X') return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 }
        }
    } catch {
        // truncated or odd header
    }
    return null
}

const isDim = (n) => Number.isInteger(n) && n > 0 && n <= MAX_DIMENSION
const isCoord = (n) => typeof n === 'number' && Number.isFinite(n)
export const DEVICE_KEY = /^zwave:[0-9a-f]+:\d+$/
const newId = (n = 4) => randomBytes(n).toString('hex')

/** Keep only the identity fields a placement snapshot carries. */
export function cleanSeen(seen) {
    const out = {}
    for (const k of ['name', 'deviceId', 'dsk']) {
        if (typeof seen?.[k] === 'string' && seen[k]) out[k] = seen[k].slice(0, 200)
    }
    return out
}

function checkNodes(nodes) {
    if (!nodes || !['include', 'exclude'].includes(nodes.start)) throw httpError(400, "nodes.start must be 'include' or 'exclude'")
    const ex = nodes.exceptions ?? []
    if (!Array.isArray(ex) || ex.length > MAX_EXCEPTIONS || !ex.every((k) => typeof k === 'string' && DEVICE_KEY.test(k))) {
        throw httpError(400, 'nodes.exceptions must be a list of device keys')
    }
    return { start: nodes.start, exceptions: [...new Set(ex)] }
}

export function checkView(view) {
    const out = { center: null, zoom: null, layers: { ...DEFAULT_LAYERS } }
    if (Array.isArray(view?.center) && view.center.length === 2 && view.center.every(isCoord)) out.center = [...view.center]
    if (isCoord(view?.zoom)) out.zoom = view.zoom
    for (const k of Object.keys(DEFAULT_LAYERS)) if (typeof view?.layers?.[k] === 'boolean') out.layers[k] = view.layers[k]
    return out
}

export class Layout {
    constructor(storeDir) {
        this.dir = path.join(storeDir, 'toposite')
        this.file = path.join(this.dir, 'layout.json')
        this.imagesDir = path.join(this.dir, 'images')
        this._queue = Promise.resolve()
    }

    /** Read the layout; an empty store starts with just the Network Graph map. */
    async load() {
        const raw = await readJSON(this.file, null)
        if (!raw) return empty()
        if (raw.version === VERSION) return raw
        throw httpError(500, `layout.json is version ${raw.version ?? 1}; this TopoSite reads version ${VERSION} only`)
    }

    /** Run read-modify-write steps one at a time so concurrent requests can't lose updates. */
    _update(fn) {
        const run = this._queue.then(async () => {
            const layout = await this.load()
            const result = await fn(layout)
            await writeAtomic(this.file, JSON.stringify(layout, null, 2))
            return result
        })
        this._queue = run.catch(() => {})
        return run
    }

    imagePath(bg, variant = 'light') {
        return path.join(this.imagesDir, bg[VARIANTS[variant]])
    }

    _map(layout, id, { placed = false } = {}) {
        const map = layout.maps.find((m) => m.id === id)
        if (!map) throw httpError(404, 'No such map')
        if (placed && map.layout !== 'placed') throw httpError(409, 'The Network Graph map has no canvas — nodes there are laid out automatically')
        return map
    }

    /** Delete backgrounds no map uses, with their image files. */
    async _collect(layout) {
        const used = new Set(layout.maps.map((m) => m.background?.id).filter(Boolean))
        for (const bg of layout.backgrounds.filter((b) => !used.has(b.id))) {
            for (const field of Object.values(VARIANTS)) {
                if (bg[field]) await rm(path.join(this.imagesDir, bg[field]), { force: true })
            }
        }
        layout.backgrounds = layout.backgrounds.filter((b) => used.has(b.id))
    }

    async _writeImage(prefix, bytes) {
        const kind = sniffImage(bytes)
        if (!kind) throw httpError(415, 'Only PNG, JPEG or WebP images are accepted')
        if (bytes.length > MAX_IMAGE_BYTES) throw httpError(413, 'Image is larger than 25 MB')
        const name = `${prefix}-${newId(3)}.${kind.ext}`   // new name busts browser caches
        await writeAtomic(path.join(this.imagesDir, name), bytes)
        return name
    }

    /**
     * Give `map` its own copy of a background other maps also use, so a change to
     * it doesn't reach them. Image files are copied (never shared), except
     * `skipField`, which the caller is about to replace or drop.
     */
    async _fork(layout, map, bg, skipField) {
        const fork = { ...bg, id: `bg-${newId()}` }
        for (const field of Object.values(VARIANTS)) {
            if (!bg[field]) continue
            if (field === skipField) { delete fork[field]; continue }
            const name = `${fork.id}${field === 'imageDark' ? '-dark' : ''}-${newId(3)}${path.extname(bg[field])}`
            await copyFile(path.join(this.imagesDir, bg[field]), path.join(this.imagesDir, name))
            fork[field] = name
        }
        if (!('image' in fork)) fork.image = null
        layout.backgrounds.push(fork)
        map.background = { ...map.background, id: fork.id }
        return fork
    }

    // ---------------------------------------------------------------- maps

    /** New placed map: a blank grid canvas; its first background image sets its size. */
    /**
     * New placed map. Optional:
     *  - backgroundId: start on a library background. The canvas and framing come
     *    from a map already using it (so positions line up), else its natural size.
     *  - copyPositionsFrom: a placed map using the same background (or none, like
     *    this one); its canvas, framing and node positions are copied once.
     */
    async addMap({ name, widthPx = 3000, heightPx = 2000, nodes = { start: 'include', exceptions: [] }, backgroundId = null, copyPositionsFrom = null } = {}) {
        if (!isDim(widthPx) || !isDim(heightPx)) throw httpError(400, 'widthPx/heightPx must be whole numbers 1–20000')
        const checked = checkNodes(nodes)
        return this._update((layout) => {
            const map = {
                id: newId(),
                name: String(name || 'Map').slice(0, 100),
                layout: 'placed',
                widthPx,
                heightPx,
                metersPerPixel: null,
                background: null,
                nodes: checked,
                view: checkView(null),
                placements: [],
            }
            const bg = backgroundId == null ? null : layout.backgrounds.find((b) => b.id === backgroundId)
            if (backgroundId != null && !bg) throw httpError(404, 'No such background')
            let from = null
            if (copyPositionsFrom != null) {
                from = this._map(layout, copyPositionsFrom, { placed: true })
                if ((from.background?.id ?? null) !== (bg?.id ?? null)) {
                    throw httpError(409, `${from.name} uses a different background — positions can only be copied between maps on the same background`)
                }
            }
            // Framing: the map we copy from, else another map on this background, else the picture's own size
            const frame = from ?? (bg && layout.maps.find((m) => m.background?.id === bg.id))
            if (frame) {
                Object.assign(map, { widthPx: frame.widthPx, heightPx: frame.heightPx, metersPerPixel: frame.metersPerPixel ?? null })
                if (bg) map.background = { id: bg.id, imageRect: { ...frame.background.imageRect } }
            } else if (bg) {
                Object.assign(map, { widthPx: bg.widthPx, heightPx: bg.heightPx })
                map.background = { id: bg.id, imageRect: { x: 0, y: 0, w: bg.widthPx, h: bg.heightPx } }
            }
            if (from) map.placements = from.placements.filter((p) => p.deviceKey).map((p) => structuredClone(p))
            layout.maps.push(map)
            return map
        })
    }

    /**
     * Change a map. Any of:
     *  - name (not the built-in map), nodes {start, exceptions}, view {center, zoom, layers}
     *  - placed maps: metersPerPixel, widthPx / heightPx (growing keeps positions —
     *    coordinates are from the top-left — and the background's imageRect),
     *    padTop / padLeft (add room above / left, moving placements and imageRect
     *    with it; applied after widthPx/heightPx), expectWidthPx / expectHeightPx
     *    (refuse with 409 unless the canvas has that size — makes a pad safe to retry)
     */
    async updateMap(id, changes) {
        const c = changes ?? {}
        const { padTop = 0, padLeft = 0 } = c
        if (c.widthPx !== undefined && !isDim(c.widthPx)) throw httpError(400, 'widthPx must be a whole number 1–20000')
        if (c.heightPx !== undefined && !isDim(c.heightPx)) throw httpError(400, 'heightPx must be a whole number 1–20000')
        for (const [k, v] of [['padTop', padTop], ['padLeft', padLeft]]) {
            if (!(Number.isInteger(v) && v >= 0 && v <= MAX_DIMENSION)) throw httpError(400, `${k} must be a whole number 0–20000`)
        }
        if (c.metersPerPixel !== undefined && c.metersPerPixel !== null &&
            !(typeof c.metersPerPixel === 'number' && c.metersPerPixel > 0 && c.metersPerPixel < 100)) {
            throw httpError(400, 'metersPerPixel must be a positive number or null')
        }
        const nodes = c.nodes !== undefined ? checkNodes(c.nodes) : undefined
        const view = c.view !== undefined ? checkView(c.view) : undefined
        const geometry = ['widthPx', 'heightPx', 'metersPerPixel', 'expectWidthPx', 'expectHeightPx'].some((k) => c[k] !== undefined) || padTop || padLeft
        return this._update((layout) => {
            const map = this._map(layout, id, { placed: geometry })
            if (c.name !== undefined) {
                if (map.builtin) throw httpError(409, "The Network Graph map can't be renamed")
                map.name = String(c.name || map.name).slice(0, 100)
            }
            if (nodes) map.nodes = nodes
            if (view) map.view = view
            if (!geometry) return map
            if (c.expectWidthPx !== undefined && map.widthPx !== c.expectWidthPx) {
                throw httpError(409, `Map is ${map.widthPx} px wide, not ${c.expectWidthPx} — nothing changed`)
            }
            if (c.expectHeightPx !== undefined && map.heightPx !== c.expectHeightPx) {
                throw httpError(409, `Map is ${map.heightPx} px tall, not ${c.expectHeightPx} — nothing changed`)
            }
            const newW = (c.widthPx ?? map.widthPx) + padLeft
            const newH = (c.heightPx ?? map.heightPx) + padTop
            if (!isDim(newW) || !isDim(newH)) throw httpError(400, 'Resulting size must be 1–20000 px')
            map.widthPx = newW
            map.heightPx = newH
            if (c.metersPerPixel !== undefined) map.metersPerPixel = c.metersPerPixel
            if (padTop || padLeft) {
                if (map.background) {
                    const r = map.background.imageRect
                    map.background.imageRect = { ...r, x: r.x + padLeft, y: r.y + padTop }
                }
                for (const p of map.placements) { p.x += padLeft; p.y += padTop }
            }
            return map
        })
    }

    async deleteMap(id) {
        return this._update(async (layout) => {
            const map = this._map(layout, id)
            if (map.builtin) throw httpError(409, "The Network Graph map can't be deleted")
            layout.maps = layout.maps.filter((m) => m.id !== id)
            if (layout.settings.defaultMapId === id) layout.settings.defaultMapId = GRAPH_ID
            await this._collect(layout)
            return map
        })
    }

    async updateSettings({ defaultMapId } = {}) {
        return this._update((layout) => {
            if (defaultMapId !== undefined) {
                this._map(layout, defaultMapId)
                layout.settings.defaultMapId = defaultMapId
            }
            return layout.settings
        })
    }

    // ---------------------------------------------------------------- backgrounds

    /**
     * Set or replace a map's background image (`variant` 'light' or 'dark'),
     * keeping its placements and scale. A map with no background gets a new
     * library background covering its canvas — and if nothing is placed yet, the
     * canvas takes the image's size so it isn't stretched. A background other maps
     * also use is forked first, so they keep theirs. `imgWidthPx` / `imgHeightPx`
     * (decoded by the browser) are used only when the header can't be read. The
     * result carries `stretched` when the image's aspect differs from where it's
     * drawn by more than 2%.
     */
    async setMapImage(id, { bytes, imgWidthPx, imgHeightPx, variant = 'light' }) {
        if (!VARIANTS[variant]) throw httpError(400, "variant must be 'light' or 'dark'")
        if (!sniffImage(bytes)) throw httpError(415, 'Only PNG, JPEG or WebP images are accepted')
        const size = imageSize(bytes) ?? (isDim(imgWidthPx) && isDim(imgHeightPx) ? { w: imgWidthPx, h: imgHeightPx } : null)
        if (!size || !isDim(size.w) || !isDim(size.h)) throw httpError(400, "Couldn't tell the image's size")
        const field = VARIANTS[variant]
        return this._update(async (layout) => {
            const map = this._map(layout, id, { placed: true })
            let bg = map.background && layout.backgrounds.find((b) => b.id === map.background.id)
            if (!bg) {
                if (!map.placements.length) { map.widthPx = size.w; map.heightPx = size.h }
                bg = { id: `bg-${newId()}`, name: map.name, image: null, widthPx: size.w, heightPx: size.h }
                layout.backgrounds.push(bg)
                map.background = { id: bg.id, imageRect: { x: 0, y: 0, w: map.widthPx, h: map.heightPx } }
            } else if (layout.maps.some((m) => m !== map && m.background?.id === bg.id)) {
                bg = await this._fork(layout, map, bg, field)
            }
            const old = bg[field]
            bg[field] = await this._writeImage(`${bg.id}${variant === 'dark' ? '-dark' : ''}`, bytes)
            if (variant === 'light') { bg.widthPx = size.w; bg.heightPx = size.h }
            if (old) await rm(path.join(this.imagesDir, old), { force: true })
            const r = map.background.imageRect
            const stretched = Math.abs((size.w / size.h) / (r.w / r.h) - 1) > 0.02
            return { map, background: bg, stretched }
        })
    }

    /**
     * Unset a map's background: just the dark version (`variant` 'dark'), or the
     * whole background ('all'). Placements stay. Library backgrounds no map uses
     * any more are deleted with their files.
     */
    async removeMapImage(id, variant = 'all') {
        if (!['all', 'dark'].includes(variant)) throw httpError(400, "variant must be 'dark' or 'all'")
        return this._update(async (layout) => {
            const map = this._map(layout, id, { placed: true })
            if (!map.background) return map
            if (variant === 'all') {
                map.background = null
            } else {
                const bg = layout.backgrounds.find((b) => b.id === map.background.id)
                if (bg?.imageDark) {
                    if (layout.maps.some((m) => m !== map && m.background?.id === bg.id)) {
                        await this._fork(layout, map, bg, 'imageDark')
                    } else {
                        await rm(path.join(this.imagesDir, bg.imageDark), { force: true })
                        delete bg.imageDark
                    }
                }
            }
            await this._collect(layout)
            return map
        })
    }

    // ---------------------------------------------------------------- placements

    /**
     * Place (or move) a device on a map — one placement per device per map.
     * `seen` is a small identity snapshot ({name, deviceId, dsk?}) taken when the
     * node is placed, so the link can be repaired after a re-inclusion.
     */
    async setPlacement(mapId, { deviceKey, x, y, seen }) {
        if (typeof deviceKey !== 'string' || !DEVICE_KEY.test(deviceKey)) throw httpError(400, 'deviceKey must look like zwave:<homeId>:<nodeId>')
        if (!isCoord(x) || !isCoord(y)) throw httpError(400, 'x and y must be numbers')
        return this._update(async (layout) => {
            const map = this._map(layout, mapId, { placed: true })
            const placement = {
                deviceKey,
                x: Math.min(Math.max(x, 0), map.widthPx),
                y: Math.min(Math.max(y, 0), map.heightPx),
            }
            const s = cleanSeen(seen)
            if (Object.keys(s).length) placement.seen = s
            const existing = map.placements.find((p) => p.deviceKey === deviceKey)
            if (existing) return Object.assign(existing, placement)
            map.placements.push(placement)
            return placement
        })
    }

    /** Remove a device's placement on one map; its spots on other maps stay. */
    removePlacement(mapId, deviceKey) {
        return this._update(async (layout) => {
            const map = this._map(layout, mapId, { placed: true })
            map.placements = map.placements.filter((p) => p.deviceKey !== deviceKey)
        })
    }

    /**
     * Link a placeholder (an imported position whose node wasn't matched) to a
     * device: the device takes the placeholder's spot, replacing any position it
     * already had on that map.
     */
    async linkPlaceholder(mapId, placeholderId, deviceKey, seen) {
        if (typeof deviceKey !== 'string' || !DEVICE_KEY.test(deviceKey)) throw httpError(400, 'deviceKey must look like zwave:<homeId>:<nodeId>')
        return this._update(async (layout) => {
            const map = this._map(layout, mapId, { placed: true })
            const ph = map.placements.find((p) => p.id === placeholderId && p.placeholder)
            if (!ph) throw httpError(404, 'No such placeholder')
            map.placements = map.placements.filter((p) => p.deviceKey !== deviceKey)
            const linked = { deviceKey, x: ph.x, y: ph.y }
            const s = cleanSeen(seen)
            if (Object.keys(s).length) linked.seen = s
            Object.keys(ph).forEach((k) => delete ph[k])
            Object.assign(ph, linked)
            return linked
        })
    }

    removePlaceholder(mapId, placeholderId) {
        return this._update(async (layout) => {
            const map = this._map(layout, mapId, { placed: true })
            const before = map.placements.length
            map.placements = map.placements.filter((p) => !(p.id === placeholderId && p.placeholder))
            if (map.placements.length === before) throw httpError(404, 'No such placeholder')
        })
    }

    // ---------------------------------------------------------------- import

    /**
     * Create a new map from a parsed .toposite file (lib/exchange.js parseImport)
     * and the user's confirmed matches {ref: deviceKey | null}. Matched entries
     * become placements, null ones placeholders. Never overwrites: a taken name
     * gets " (imported)" (then " (imported 2)", …). `nodes` (this install's
     * TopoSite nodes) supply identity snapshots.
     */
    async importMap(file, matches, { nodes = [], name } = {}) {
        if (!matches || typeof matches !== 'object') throw httpError(400, 'matches must be an object of ref → deviceKey or null')
        const used = new Set()
        for (const e of file.nodes) {
            if (!(e.ref in matches)) throw httpError(400, `No decision for "${e.name ?? e.ref}"`)
            const key = matches[e.ref]
            if (key === null) continue
            if (typeof key !== 'string' || !DEVICE_KEY.test(key)) throw httpError(400, `Bad device for "${e.name ?? e.ref}"`)
            if (used.has(key)) throw httpError(400, 'The same device is chosen for two entries')
            used.add(key)
        }
        const byKey = new Map(nodes.filter((n) => n.key).map((n) => [n.key, n]))
        const byRef = new Map(file.nodes.map((e) => [e.ref, e]))
        return this._update(async (layout) => {
            const taken = new Set(layout.maps.map((m) => m.name))
            let finalName = String(name || file.map.name).slice(0, 100)
            if (taken.has(finalName)) {
                const base = `${finalName} (imported`
                finalName = `${base})`
                for (let i = 2; taken.has(finalName); i++) finalName = `${base} ${i})`
            }
            const m = file.map
            const map = {
                id: newId(),
                name: finalName,
                layout: 'placed',
                widthPx: m.widthPx,
                heightPx: m.heightPx,
                metersPerPixel: m.metersPerPixel,
                background: null,
                nodes: { start: m.nodes.start, exceptions: m.nodes.exceptionRefs.map((ref) => matches[ref]).filter(Boolean) },
                view: checkView(m.view),
                placements: [],
            }
            if (file.images.image || file.images.imageDark) {
                const bg = { id: `bg-${newId()}`, name: finalName, image: null }
                for (const [field, img] of Object.entries(file.images)) {
                    bg[field] = await this._writeImage(`${bg.id}${field === 'imageDark' ? '-dark' : ''}`, img.bytes)
                }
                const size = imageSize((file.images.image ?? file.images.imageDark).bytes)
                bg.widthPx = size?.w ?? m.widthPx
                bg.heightPx = size?.h ?? m.heightPx
                layout.backgrounds.push(bg)
                map.background = { id: bg.id, imageRect: m.imageRect ?? { x: 0, y: 0, w: m.widthPx, h: m.heightPx } }
            }
            const clampX = (x) => Math.min(Math.max(x, 0), map.widthPx)
            const clampY = (y) => Math.min(Math.max(y, 0), map.heightPx)
            let linked = 0
            let placeholders = 0
            for (const pl of file.placements) {
                const key = matches[pl.ref]
                const e = byRef.get(pl.ref)
                if (key) {
                    const n = byKey.get(key)
                    const seen = cleanSeen({ name: n?.name, deviceId: n?.deviceId, dsk: n?.dsk })
                    map.placements.push({ deviceKey: key, x: clampX(pl.x), y: clampY(pl.y), ...(Object.keys(seen).length ? { seen } : {}) })
                    linked++
                } else {
                    map.placements.push({
                        id: `ph-${newId()}`,
                        deviceKey: null,
                        x: clampX(pl.x),
                        y: clampY(pl.y),
                        placeholder: { name: e.name, loc: e.loc, deviceId: e.deviceId, productLabel: e.productLabel },
                    })
                    placeholders++
                }
            }
            layout.maps.push(map)
            return { map, linked, placeholders }
        })
    }
}

export function httpError(status, message) {
    return Object.assign(new Error(message), { status })
}

// SN: 00002
