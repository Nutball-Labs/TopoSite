// layout.js — Plans and placements (ROADMAP.md "Data Model"), stored as
// <store>/toposite/layout.json with plan images in <store>/toposite/images/.
//
// Positions are plan pixels: x right, y down, origin at the image's top-left.
// A plan has a background image the user supplies (plus an optional dark-mode
// version), or none (shown as a grid). Layouts saved while TopoSite had drawing
// tools may still contain a `shapes` array; it's left as is and ignored.

import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { readJSON, writeAtomic } from './store.js'

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_DIMENSION = 20000

const EMPTY = { version: 1, plans: [], placements: [] }

// Background image variants → plan field
const VARIANTS = { light: 'image', dark: 'imageDark' }
const hasImage = (plan) => !!(plan.image || plan.imageDark)

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

    imagePath(plan, variant = 'light') {
        return path.join(this.imagesDir, plan[VARIANTS[variant]])
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
            imageRect: { x: 0, y: 0, w: widthPx, h: heightPx },
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

    /** Add a plan with no background image yet (shown as a grid). */
    async addBlankPlan({ name, widthPx, heightPx }) {
        if (!isDim(widthPx) || !isDim(heightPx)) throw httpError(400, 'widthPx/heightPx must be whole numbers 1–20000')
        const plan = {
            id: randomBytes(4).toString('hex'),
            name: String(name || 'Drawing').slice(0, 100),
            image: null,
            widthPx,
            heightPx,
            metersPerPixel: null,
            elevationM: 0,
        }
        return this._update((layout) => {
            layout.plans.push(plan)
            return plan
        })
    }

    /**
     * Change a plan's name, size or scale, or add room on the top/left.
     *  - widthPx / heightPx: set the size. Growing keeps positions: coordinates are
     *    from the top-left, and a background image keeps its imageRect.
     *  - padTop / padLeft: add that many px above / to the left and move every
     *    placement and the background image down / right by the same amount, so
     *    nothing moves relative to the background. Applied after widthPx/heightPx.
     *  - expectWidthPx / expectHeightPx: refuse (409) unless the plan currently
     *    has that size — makes a pad safe to retry.
     *  - metersPerPixel: the plan's scale, or null.
     */
    async updatePlan(id, changes) {
        const { name, widthPx, heightPx, metersPerPixel, padTop = 0, padLeft = 0, expectWidthPx, expectHeightPx } = changes ?? {}
        if (widthPx !== undefined && !isDim(widthPx)) throw httpError(400, 'widthPx must be a whole number 1–20000')
        if (heightPx !== undefined && !isDim(heightPx)) throw httpError(400, 'heightPx must be a whole number 1–20000')
        for (const [k, v] of [['padTop', padTop], ['padLeft', padLeft]]) {
            if (!(Number.isInteger(v) && v >= 0 && v <= MAX_DIMENSION)) throw httpError(400, `${k} must be a whole number 0–20000`)
        }
        if (metersPerPixel !== undefined && metersPerPixel !== null &&
            !(typeof metersPerPixel === 'number' && metersPerPixel > 0 && metersPerPixel < 100)) {
            throw httpError(400, 'metersPerPixel must be a positive number or null')
        }
        return this._update((layout) => {
            const plan = layout.plans.find((p) => p.id === id)
            if (!plan) throw httpError(404, 'No such plan')
            if (expectWidthPx !== undefined && plan.widthPx !== expectWidthPx) {
                throw httpError(409, `Plan is ${plan.widthPx} px wide, not ${expectWidthPx} — nothing changed`)
            }
            if (expectHeightPx !== undefined && plan.heightPx !== expectHeightPx) {
                throw httpError(409, `Plan is ${plan.heightPx} px tall, not ${expectHeightPx} — nothing changed`)
            }
            // Older image plans have no imageRect: pin it to the current bounds before
            // the size changes, so the picture doesn't stretch with the plan.
            if (hasImage(plan) && !plan.imageRect) plan.imageRect = imageRectOf(plan)
            const newW = (widthPx ?? plan.widthPx) + padLeft
            const newH = (heightPx ?? plan.heightPx) + padTop
            if (!isDim(newW) || !isDim(newH)) throw httpError(400, 'Resulting size must be 1–20000 px')
            if (name !== undefined) plan.name = String(name || plan.name).slice(0, 100)
            plan.widthPx = newW
            plan.heightPx = newH
            if (metersPerPixel !== undefined) plan.metersPerPixel = metersPerPixel
            if (padTop || padLeft) {
                if (hasImage(plan)) {
                    const r = imageRectOf(plan)
                    plan.imageRect = { ...r, x: r.x + padLeft, y: r.y + padTop }
                }
                for (const p of layout.placements) {
                    if (p.planId === id) { p.x += padLeft; p.y += padTop }
                }
            }
            return plan
        })
    }

    /**
     * Set or replace a plan's background image, keeping its placements and
     * scale. `variant` 'light' (the default image) or 'dark' (shown while the UI is in
     * dark mode); both share one imageRect so they line up. A plan's first image
     * covers the whole plan — and if nothing is placed on it yet, the plan takes
     * the image's size; later images take the existing imageRect.
     * imgWidthPx/imgHeightPx (decoded by the browser) only feed the `stretched` flag,
     * set when the image's aspect differs from its rect's by >2%.
     */
    async setImage(id, { bytes, imgWidthPx, imgHeightPx, variant = 'light' }) {
        if (!VARIANTS[variant]) throw httpError(400, "variant must be 'light' or 'dark'")
        const kind = sniffImage(bytes)
        if (!kind) throw httpError(415, 'Only PNG, JPEG or WebP images are accepted')
        if (bytes.length > MAX_IMAGE_BYTES) throw httpError(413, 'Image is larger than 25 MB')
        if (!isDim(imgWidthPx) || !isDim(imgHeightPx)) throw httpError(400, 'imgWidthPx/imgHeightPx must be whole numbers 1–20000')
        const field = VARIANTS[variant]
        return this._update(async (layout) => {
            const plan = layout.plans.find((p) => p.id === id)
            if (!plan) throw httpError(404, 'No such plan')
            const old = plan[field]
            // A map's first image, with nothing placed yet, sets the map's size, so a new
            // map + Set image shows the picture at its own proportions, not stretched.
            if (!hasImage(plan) && !layout.placements.some((pl) => pl.planId === id)) {
                plan.widthPx = imgWidthPx
                plan.heightPx = imgHeightPx
            }
            const rect = hasImage(plan) ? imageRectOf(plan) : { x: 0, y: 0, w: plan.widthPx, h: plan.heightPx }
            const name = `${id}-${variant === 'dark' ? 'dark-' : ''}${randomBytes(3).toString('hex')}.${kind.ext}`   // new name busts caches
            await writeAtomic(path.join(this.imagesDir, name), bytes)
            plan[field] = name
            plan.imageRect = rect
            if (old) await rm(path.join(this.imagesDir, old), { force: true })
            const stretched = Math.abs((imgWidthPx / imgHeightPx) / (rect.w / rect.h) - 1) > 0.02
            return { ...plan, stretched }
        })
    }

    /** Remove a plan's background: just the dark variant, or ('all') both. Everything else stays. */
    async removeImage(id, variant = 'all') {
        if (variant !== 'all' && !VARIANTS[variant]) throw httpError(400, "variant must be 'light', 'dark' or 'all'")
        return this._update(async (layout) => {
            const plan = layout.plans.find((p) => p.id === id)
            if (!plan) throw httpError(404, 'No such plan')
            for (const v of variant === 'all' ? Object.keys(VARIANTS) : [variant]) {
                const field = VARIANTS[v]
                if (plan[field]) await rm(path.join(this.imagesDir, plan[field]), { force: true })
                if (field === 'image') plan.image = null
                else delete plan[field]
            }
            if (!hasImage(plan)) delete plan.imageRect
            return plan
        })
    }

    deletePlan(id) {
        return this._update(async (layout) => {
            const plan = layout.plans.find((p) => p.id === id)
            if (!plan) throw httpError(404, 'No such plan')
            layout.plans = layout.plans.filter((p) => p.id !== id)
            layout.placements = layout.placements.filter((p) => p.planId !== id)
            for (const field of Object.values(VARIANTS)) {
                if (plan[field]) await rm(path.join(this.imagesDir, plan[field]), { force: true })
            }
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

/** Where a plan's background image sits, in plan px. Plans from before imageRect: the whole plan. */
export function imageRectOf(plan) {
    return plan.imageRect ?? { x: 0, y: 0, w: plan.widthPx, h: plan.heightPx }
}

export function httpError(status, message) {
    return Object.assign(new Error(message), { status })
}

// SN: 00001
