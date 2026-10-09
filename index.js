// index.js — TopoSite plugin entry point for Z-Wave JS UI.
//
// Z-Wave JS UI (≥ 11.6.0) loads this with import() and constructs the default
// export with a PluginContext { zwave, mqtt, app, logger } (docs/guide/plugins.md).
//
// Routes: plugin routes are mounted at the ROOT of Z-Wave JS UI's web server,
// so every TopoSite route lives under BASE to avoid collisions.
// Auth: plugin routes run BEFORE Z-Wave JS UI's login check, so every API route
// here goes through lib/auth.js, which accepts exactly the logins Z-Wave JS UI
// accepts (open when Z-Wave JS UI's auth is off). The static page files carry
// no data and stay open so the page can load and ask for a login.

import { createReadStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { authenticate } from './lib/auth.js'
import { getNodes } from './lib/mesh.js'
import { Layout, MAX_IMAGE_BYTES, httpError } from './lib/layout.js'
import { resolveStoreDir } from './lib/store.js'

export const BASE = '/toposite'
export const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url))

export default class TopoSite {
    constructor(ctx, options = {}) {
        this.zwave = ctx.zwave
        this.logger = ctx.logger
        this.app = ctx.app
        this.env = options.env ?? process.env
        this.storeDir = options.storeDir !== undefined ? options.storeDir : resolveStoreDir(this.env)
        this.layout = this.storeDir ? new Layout(this.storeDir) : null
        if (!this.storeDir) this.logger.error('TopoSite: Z-Wave JS UI store directory not found — set TOPOSITE_STORE_DIR')

        const api = (method, path, handler) => this.app[method](`${BASE}/api${path}`, this._guard(handler))

        api('get', '/nodes', () => {
            // zwave is optional in PluginContext on Z-Wave JS UI's backend-refactor
            // branch (PR #4747): absent when Z-Wave isn't configured.
            if (!this.zwave) throw httpError(503, 'Z-Wave is not enabled in Z-Wave JS UI')
            return getNodes(this.zwave)
        })

        api('get', '/layout', () => this._layout().load())

        // Body: the raw image bytes. Query: name, widthPx, heightPx (decoded by the browser).
        api('post', '/plans', async (req) => {
            const bytes = await readBody(req, MAX_IMAGE_BYTES)
            return this._layout().addPlan({
                name: req.query.name,
                widthPx: Number(req.query.widthPx),
                heightPx: Number(req.query.heightPx),
                bytes,
            })
        })

        // Body (JSON): {name, widthPx, heightPx} → a blank plan to draw on
        api('post', '/plans/blank', (req) => {
            const { name, widthPx, heightPx } = req.body ?? {}
            return this._layout().addBlankPlan({ name, widthPx, heightPx })
        })

        api('delete', '/plans/:id', (req) => this._layout().deletePlan(req.params.id))

        // Body (JSON): {shapes: [...]} — replaces every drawn shape on the plan
        api('put', '/plans/:id/shapes', (req) => this._layout().setShapes(req.params.id, req.body?.shapes))

        api('get', '/plans/:id/image', async (req, res) => {
            const layout = await this._layout().load()
            const plan = layout.plans.find((p) => p.id === req.params.id)
            if (!plan || !plan.image) throw httpError(404, 'No such plan image')
            res.type(plan.image.split('.').pop())
            res.set('Cache-Control', 'private, max-age=3600')
            res.set('X-Content-Type-Options', 'nosniff')
            await new Promise((resolve, reject) => {
                createReadStream(this._layout().imagePath(plan)).on('error', reject).on('end', resolve).pipe(res)
            })
            return undefined // response already sent
        })

        // Body (JSON, parsed by Z-Wave JS UI's express.json): {deviceKey, planId, x, y}
        api('put', '/placements', (req) => this._layout().setPlacement(req.body ?? {}))
        api('delete', '/placements/:deviceKey', (req) => this._layout().removePlacement(req.params.deviceKey))

        // The page uses relative URLs, so it must be loaded with the trailing slash.
        // Relative redirect keeps it working behind a path prefix (reverse proxy).
        // Express routing ignores the trailing slash, so /toposite/ lands here too.
        this.app.get(BASE, (req, res, next) => {
            if (req.path.endsWith('/')) return next()
            res.redirect('toposite/')
        })

        // Map page and its assets. sendFile with `root` refuses paths that
        // climb out of public/ (403) and dotfiles.
        this.app.get(`${BASE}/*`, (req, res) => {
            const file = req.params[0] || 'index.html'
            res.sendFile(file, { root: PUBLIC_DIR, dotfiles: 'deny' }, (error) => {
                if (error && !res.headersSent) res.status(error.status || 404).end()
            })
        })

        this.logger.info(`TopoSite loaded — map at ${BASE}/, data in ${this.storeDir ?? '(no store dir)'}/toposite`)
    }

    _layout() {
        if (!this.layout) throw httpError(503, 'Z-Wave JS UI store directory not found')
        return this.layout
    }

    /** Auth check + JSON envelope {success, data | message} for an API handler. */
    _guard(handler) {
        return async (req, res) => {
            try {
                const auth = await authenticate(req, this.storeDir, this.env)
                if (!auth.ok) {
                    return res.status(401).json({ success: false, code: 'auth', message: `Not authorized: ${auth.reason}` })
                }
                const data = await handler(req, res)
                if (!res.headersSent) res.json({ success: true, data })
            } catch (error) {
                const status = error.status ?? 500
                if (status >= 500) this.logger.error(`TopoSite: ${req.method} ${req.path}: ${error.message}`)
                if (!res.headersSent) res.status(status).json({ success: false, message: error.message })
            }
        }
    }

    async destroy() {
        // Nothing to clean up yet: no event listeners or timers registered.
    }
}

/** Read a raw request body up to `limit` bytes (Z-Wave JS UI only parses JSON/urlencoded bodies). */
export function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (chunk) => {
            size += chunk.length
            if (size > limit) {
                // Keep draining (and discarding) instead of destroying the socket,
                // so the client gets the 413 rather than a dropped connection.
                chunks.length = 0
                reject(httpError(413, `Upload larger than ${Math.round(limit / 1024 / 1024)} MB`))
                return
            }
            chunks.push(chunk)
        })
        req.on('end', () => resolve(Buffer.concat(chunks)))
        req.on('error', reject)
    })
}

// SN: 00001
