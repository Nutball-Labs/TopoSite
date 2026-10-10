// exchange.js — Map export/import (MAPS.md "Import / export").
//
// One map per .toposite file: the map, its background image(s) as base64, a
// node manifest describing each placed device, and positions that refer to the
// manifest by `ref` (never by node ID), so an import can remap them onto a
// different install. Import always goes through a review screen; this file
// only proposes matches.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { httpError, sniffImage, MAX_IMAGE_BYTES } from './layout.js'

export const FORMAT = 'toposite-map'
export const FORMAT_VERSION = 1
export const MAX_FILE_BYTES = 40 * 1024 * 1024
const MAX_NODES = 2000
const MAX_DIMENSION = 20000

const VARIANT_FIELDS = { image: 'image', imageDark: 'imageDark' }
const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }

/**
 * Build the export object for one plan. `nodes` are TopoSite nodes (lib/mesh.js)
 * from this install; a placed device that's gone from the network is described
 * from its placement's identity snapshot. Placeholders aren't exported.
 */
export async function buildExport({ layout, planId, nodes, imagesDir, homeId, version }) {
    const plan = layout.plans.find((p) => p.id === planId)
    if (!plan) throw httpError(404, 'No such plan')
    const map = {
        name: plan.name,
        widthPx: plan.widthPx,
        heightPx: plan.heightPx,
        metersPerPixel: plan.metersPerPixel ?? null,
        elevationM: plan.elevationM ?? 0,
        imageRect: plan.imageRect ?? null,
        image: null,
        imageDark: null,
    }
    for (const field of Object.values(VARIANT_FIELDS)) {
        if (!plan[field]) continue
        const ext = plan[field].split('.').pop().toLowerCase()
        const bytes = await readFile(path.join(imagesDir, plan[field]))
        map[field] = { type: TYPES[ext] ?? 'application/octet-stream', data: bytes.toString('base64') }
    }
    const byKey = new Map(nodes.filter((n) => n.key).map((n) => [n.key, n]))
    const entries = []
    const placements = []
    for (const pl of layout.placements) {
        if (pl.planId !== planId || !pl.deviceKey) continue
        const ref = `n${entries.length + 1}`
        const [, home, id] = pl.deviceKey.split(':')
        const n = byKey.get(pl.deviceKey)
        entries.push({
            ref,
            homeId: home,
            nodeId: Number(id),
            name: n?.name ?? pl.seen?.name ?? null,
            loc: n?.location ?? null,
            deviceId: n?.deviceId ?? pl.seen?.deviceId ?? null,
            productLabel: n?.productLabel ?? null,
            manufacturer: n?.manufacturer ?? null,
            firmwareVersion: n?.firmwareVersion ?? null,
            role: n?.role ?? null,
            dsk: n?.dsk ?? pl.seen?.dsk ?? null,
        })
        placements.push({ ref, x: pl.x, y: pl.y })
    }
    return {
        format: FORMAT,
        version: FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        source: { homeId: homeId ?? null, toposite: version ?? null },
        map,
        nodes: entries,
        placements,
    }
}

/** Parse and validate an uploaded .toposite file. Throws 400/413/415 with a plain message. */
export function parseImport(bytes) {
    if (bytes.length > MAX_FILE_BYTES) throw httpError(413, 'File is larger than 40 MB')
    let file
    try {
        file = JSON.parse(bytes.toString('utf8'))
    } catch {
        throw httpError(400, "That isn't a TopoSite map file (not JSON)")
    }
    const bad = (why) => httpError(400, `Not a usable TopoSite map file: ${why}`)
    if (file?.format !== FORMAT) throw bad('wrong format')
    if (file.version !== FORMAT_VERSION) throw bad(`version ${file.version} isn't supported (this TopoSite reads version ${FORMAT_VERSION})`)
    const m = file.map
    if (!m || typeof m.name !== 'string') throw bad('map has no name')
    const dim = (n) => Number.isInteger(n) && n > 0 && n <= MAX_DIMENSION
    if (!dim(m.widthPx) || !dim(m.heightPx)) throw bad('map size is invalid')
    const images = {}
    for (const field of Object.values(VARIANT_FIELDS)) {
        if (m[field] == null) continue
        if (typeof m[field].data !== 'string') throw bad(`${field} has no data`)
        const buf = Buffer.from(m[field].data, 'base64')
        if (buf.length > MAX_IMAGE_BYTES) throw httpError(413, `${field} is larger than 25 MB`)
        const kind = sniffImage(buf)
        if (!kind) throw httpError(415, `${field} isn't a PNG, JPEG or WebP image`)
        images[field] = { bytes: buf, ext: kind.ext }
    }
    const r = m.imageRect
    if (r != null && ![r.x, r.y, r.w, r.h].every((v) => typeof v === 'number' && Number.isFinite(v))) throw bad('imageRect is invalid')
    if (!Array.isArray(file.nodes) || file.nodes.length > MAX_NODES) throw bad('node list is invalid')
    const refs = new Set()
    const str = (v) => (typeof v === 'string' && v ? v.slice(0, 200) : null)
    const nodes = file.nodes.map((n) => {
        if (typeof n?.ref !== 'string' || !n.ref || refs.has(n.ref)) throw bad('node refs must be unique strings')
        refs.add(n.ref)
        return {
            ref: n.ref.slice(0, 32),
            homeId: str(n.homeId),
            nodeId: Number.isInteger(n.nodeId) ? n.nodeId : null,
            name: str(n.name),
            loc: str(n.loc),
            deviceId: str(n.deviceId),
            productLabel: str(n.productLabel),
            manufacturer: str(n.manufacturer),
            firmwareVersion: str(n.firmwareVersion),
            role: str(n.role),
            dsk: str(n.dsk),
        }
    })
    if (!Array.isArray(file.placements)) throw bad('placements are invalid')
    const placements = file.placements.map((p) => {
        if (!refs.has(p?.ref)) throw bad('a placement refers to an unknown node')
        if (![p.x, p.y].every((v) => typeof v === 'number' && Number.isFinite(v))) throw bad('a placement has invalid coordinates')
        return { ref: p.ref, x: p.x, y: p.y }
    })
    return {
        map: {
            name: m.name.slice(0, 100) || 'Imported map',
            widthPx: m.widthPx,
            heightPx: m.heightPx,
            metersPerPixel: typeof m.metersPerPixel === 'number' && m.metersPerPixel > 0 ? m.metersPerPixel : null,
            elevationM: typeof m.elevationM === 'number' && Number.isFinite(m.elevationM) ? m.elevationM : 0,
            imageRect: r ?? null,
        },
        images,
        nodes,
        placements,
        source: { homeId: str(file.source?.homeId), toposite: str(file.source?.toposite), exportedAt: str(file.exportedAt) },
    }
}

const norm = (s) => (s ?? '').trim().toLowerCase()
const generic = (name) => !name || /^nodeid \d+$/.test(norm(name))
const LEVELS = { 3: 'certain', 2: 'likely', 1: 'possible' }

/**
 * How strongly a file entry matches a local node (MAPS.md table):
 *  3 certain  — same DSK; or same home ID and node ID with the same deviceId and name
 *  2 likely   — same name and same deviceId
 *  1 possible — same deviceId and same location; or same name only
 *  0          — no evidence
 * Generic names ("NodeID 12") don't count as a name match.
 */
export function matchScore(entry, node, localHome) {
    if (entry.dsk && node.dsk && entry.dsk === node.dsk) return 3
    const sameName = !generic(entry.name) && norm(entry.name) === norm(node.name)
    const sameDevice = !!entry.deviceId && entry.deviceId === node.deviceId
    const sameLoc = !!norm(entry.loc) && norm(entry.loc) === norm(node.location)
    if (entry.homeId && entry.homeId === localHome && entry.nodeId === node.id && sameDevice && sameName) return 3
    if (sameName && sameDevice) return 2
    if ((sameDevice && sameLoc) || sameName) return 1
    return 0
}

/**
 * Propose one local node per file entry, strongest evidence first. Each local
 * node is proposed at most once; when an entry's best evidence points at more
 * than one node, or a node is the best for more than one entry, those are left
 * unproposed for the user to decide. Returns {ref: {key, confidence}}.
 */
export function proposeMatches(entries, nodes, localHome) {
    const local = nodes.filter((n) => n.key && n.role !== 'controller')
    const result = Object.fromEntries(entries.map((e) => [e.ref, { key: null, confidence: 'none' }]))
    const takenNodes = new Set()
    const doneEntries = new Set()
    for (const level of [3, 2, 1]) {
        const best = new Map() // ref -> [node keys at this level]
        for (const e of entries) {
            if (doneEntries.has(e.ref)) continue
            const scored = local.filter((n) => !takenNodes.has(n.key)).map((n) => [n.key, matchScore(e, n, localHome)])
            const top = Math.max(0, ...scored.map(([, s]) => s))
            if (top !== level) continue
            best.set(e.ref, scored.filter(([, s]) => s === level).map(([k]) => k))
        }
        const claims = new Map() // node key -> refs naming it as their single best
        for (const [ref, keys] of best) {
            if (keys.length !== 1) continue
            claims.set(keys[0], [...(claims.get(keys[0]) ?? []), ref])
        }
        for (const [key, refs] of claims) {
            if (refs.length !== 1) continue
            result[refs[0]] = { key, confidence: LEVELS[level] }
            takenNodes.add(key)
            doneEntries.add(refs[0])
        }
        // entries with ties at this level stay unproposed (but keep their confidence hint)
        for (const [ref, keys] of best) {
            if (!doneEntries.has(ref)) doneEntries.add(ref)
            if (result[ref].key === null && keys.length) result[ref].tied = keys.length
        }
    }
    return result
}

// SN: 00001
