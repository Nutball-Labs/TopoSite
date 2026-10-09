// layout.js — Plans and placements (ROADMAP.md "Data Model"), stored as
// <store>/toposite/layout.json with plan images in <store>/toposite/images/.
//
// Positions are plan pixels: x right, y down, origin at the image's top-left.

import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { readJSON, writeAtomic } from './store.js'

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_DIMENSION = 20000

const EMPTY = { version: 1, plans: [], placements: [] }

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

const isDim = (n) => Number.isInteger(n) && n > 0 && n <= MAX_DIMENSION
const isCoord = (n) => typeof n === 'number' && Number.isFinite(n)

export class Layout {
    constructor(storeDir) {
        this.dir = path.join(storeDir, 'toposite')
        this.file = path.join(this.dir, 'layout.json')
        this.imagesDir = path.join(this.dir, 'images')
        this._queue = Promise.resolve()
    }

    load() {
        return readJSON(this.file, structuredClone(EMPTY))
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

    imagePath(plan) {
        return path.join(this.imagesDir, plan.image)
    }

    /** Add a plan from uploaded image bytes. Width/height come from the browser, which decoded the image. */
    async addPlan({ name, widthPx, heightPx, bytes }) {
        const kind = sniffImage(bytes)
        if (!kind) throw httpError(415, 'Only PNG, JPEG or WebP images are accepted')
        if (bytes.length > MAX_IMAGE_BYTES) throw httpError(413, 'Image is larger than 25 MB')
        if (!isDim(widthPx) || !isDim(heightPx)) throw httpError(400, 'widthPx/heightPx must be whole numbers 1–20000')
        const id = randomBytes(4).toString('hex')
        const plan = {
            id,
            name: String(name || 'Plan').slice(0, 100),
            image: `${id}.${kind.ext}`,
            widthPx,
            heightPx,
            metersPerPixel: null,
            elevationM: 0,
        }
        return this._update(async (layout) => {
            await writeAtomic(path.join(this.imagesDir, plan.image), bytes)
            layout.plans.push(plan)
            return plan
        })
    }

    deletePlan(id) {
        return this._update(async (layout) => {
            const plan = layout.plans.find((p) => p.id === id)
            if (!plan) throw httpError(404, 'No such plan')
            layout.plans = layout.plans.filter((p) => p.id !== id)
            layout.placements = layout.placements.filter((p) => p.planId !== id)
            await rm(this.imagePath(plan), { force: true })
            return plan
        })
    }

    /** Place (or move) a device on a plan. One placement per device. */
    async setPlacement({ deviceKey, planId, x, y }) {
        if (typeof deviceKey !== 'string' || !/^zwave:[0-9a-f]+:\d+$/.test(deviceKey)) {
            throw httpError(400, 'deviceKey must look like zwave:<homeId>:<nodeId>')
        }
        if (!isCoord(x) || !isCoord(y)) throw httpError(400, 'x and y must be numbers')
        return this._update(async (layout) => {
            const plan = layout.plans.find((p) => p.id === planId)
            if (!plan) throw httpError(404, 'No such plan')
            const placement = {
                deviceKey,
                planId,
                x: Math.min(Math.max(x, 0), plan.widthPx),
                y: Math.min(Math.max(y, 0), plan.heightPx),
            }
            const existing = layout.placements.find((p) => p.deviceKey === deviceKey)
            if (existing) Object.assign(existing, placement)
            else layout.placements.push(placement)
            return placement
        })
    }

    removePlacement(deviceKey) {
        return this._update(async (layout) => {
            layout.placements = layout.placements.filter((p) => p.deviceKey !== deviceKey)
        })
    }
}

export function httpError(status, message) {
    return Object.assign(new Error(message), { status })
}

// SN: 00001
