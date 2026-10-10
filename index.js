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

import { createReadStream, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { authenticate } from './lib/auth.js'
import { getNodes, homeIdOf } from './lib/mesh.js'
import { Layout, MAX_IMAGE_BYTES, httpError } from './lib/layout.js'
import { buildExport, parseImport, proposeMatches, MAX_FILE_BYTES } from './lib/exchange.js'
import { resolveStoreDir } from './lib/store.js'

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
const IMPORT_TTL_MS = 10 * 60 * 1000   // a previewed import file is held this long for its commit

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
        this.imports = new Map() // import preview token → {file, expires}
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

        // Body (JSON): any of {name, widthPx, heightPx, metersPerPixel}
        api('patch', '/plans/:id', (req) => this._layout().updatePlan(req.params.id, req.body))

        api('delete', '/plans/:id', (req) => this._layout().deletePlan(req.params.id))


        // Body: raw image bytes. Query: imgWidthPx, imgHeightPx (decoded by the browser),
        // variant=light|dark (default light; dark is shown while the UI is in dark mode).
        // Sets or replaces the background; placements and scale stay.
        api('put', '/plans/:id/image', async (req) => {
            const bytes = await readBody(req, MAX_IMAGE_BYTES)
            return this._layout().setImage(req.params.id, {
                bytes,
                imgWidthPx: Number(req.query.imgWidthPx),
                imgHeightPx: Number(req.query.imgHeightPx),
                variant: req.query.variant ?? 'light',
            })
        })

        // ?variant=dark removes just the dark version; default removes both
        api('delete', '/plans/:id/image', (req) => this._layout().removeImage(req.params.id, req.query.variant ?? 'all'))

        api('get', '/plans/:id/image', async (req, res) => {
            const layout = await this._layout().load()
            const plan = layout.plans.find((p) => p.id === req.params.id)
            const field = req.query.variant === 'dark' ? 'imageDark' : 'image'
            if (!plan || !plan[field]) throw httpError(404, 'No such plan image')
            res.type(plan[field].split('.').pop())
            res.set('Cache-Control', 'private, max-age=3600')
            res.set('X-Content-Type-Options', 'nosniff')
            await new Promise((resolve, reject) => {
                createReadStream(this._layout().imagePath(plan, field === 'imageDark' ? 'dark' : 'light')).on('error', reject).on('end', resolve).pipe(res)
            })
            return undefined // response already sent
        })

        // Body (JSON, parsed by Z-Wave JS UI's express.json): {deviceKey, planId, x, y}
        // Body (JSON): {deviceKey, planId, x, y}. The node's identity is snapshotted
        // with the placement so the link can be repaired after a re-inclusion.
        api('put', '/placements', (req) => {
            const body = req.body ?? {}
            return this._layout().setPlacement({ ...body, seen: this._seen(body.deviceKey) })
        })
        // Unplace a device on one plan; its spots on other plans stay
        api('delete', '/plans/:id/placements/:deviceKey', (req) =>
            this._layout().removePlacement(req.params.id, req.params.deviceKey))

        // Placeholders (imported positions with no matched node): link to a device, or delete
        api('put', '/plans/:id/placeholders/:phId', (req) => {
            const key = req.body?.deviceKey
            return this._layout().linkPlaceholder(req.params.id, req.params.phId, key, this._seen(key))
        })
        api('delete', '/plans/:id/placeholders/:phId', (req) =>
            this._layout().removePlaceholder(req.params.id, req.params.phId))

        // Export one map as a .toposite file (MAPS.md "Import / export")
        api('get', '/plans/:id/export', async (req, res) => {
            const out = await buildExport({
                layout: await this._layout().load(),
                planId: req.params.id,
                nodes: this._nodes(),
                imagesDir: this._layout().imagesDir,
                homeId: this.zwave ? homeIdOf(this.zwave) : null,
                version: VERSION,
            })
            const file = (out.map.name.replace(/[^\w .()-]+/g, '_').trim() || 'map') + '.toposite'
            res.set('Content-Disposition', `attachment; filename="${file}"`)
            res.type('application/json').send(JSON.stringify(out))
            return undefined // response already sent
        })

        // Import, step 1: upload the file (raw bytes — Z-Wave JS UI's 5 MB JSON limit
        // doesn't apply), get proposed matches and a token. Nothing is created yet.
        api('post', '/import/preview', async (req) => {
            const file = parseImport(await readBody(req, MAX_FILE_BYTES))
            const nodes = this._nodes()
            const proposals = proposeMatches(file.nodes, nodes, this.zwave ? homeIdOf(this.zwave) : null)
            const token = randomBytes(12).toString('hex')
            this._sweepImports()
            this.imports.set(token, { file, expires: Date.now() + IMPORT_TTL_MS })
            return {
                token,
                map: {
                    name: file.map.name,
                    widthPx: file.map.widthPx,
                    heightPx: file.map.heightPx,
                    hasImage: !!file.images.image,
                    hasDarkImage: !!file.images.imageDark,
                },
                source: file.source,
                entries: file.nodes.map((e) => ({ ...e, ...proposals[e.ref] })),
                nodes: nodes.filter((n) => n.key && n.role !== 'controller').map((n) =>
                    ({ key: n.key, id: n.id, name: n.name, location: n.location, deviceId: n.deviceId, productLabel: n.productLabel })),
            }
        })

        // Import, step 2: Body (JSON) {token, matches: {ref: deviceKey | null}, name?}.
        // Creates a new map; never overwrites an existing one.
        api('post', '/import/commit', async (req) => {
            const { token, matches, name } = req.body ?? {}
            this._sweepImports()
            const held = this.imports.get(token)
            if (!held) throw httpError(410, 'That import has expired — choose the file again')
            const result = await this._layout().importMap(held.file, matches, { nodes: this._nodes(), name })
            this.imports.delete(token)
            return result
        })

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

    /** This install's nodes in TopoSite's model, or [] when Z-Wave isn't running. */
    _nodes() {
        try {
            return this.zwave ? getNodes(this.zwave) : []
        } catch {
            return []
        }
    }

    /** Identity snapshot for a placement: {name, deviceId, dsk} of the node, if known. */
    _seen(deviceKey) {
        const n = this._nodes().find((node) => node.key === deviceKey)
        return n ? { name: n.name, deviceId: n.deviceId, dsk: n.dsk } : undefined
    }

    _sweepImports() {
        const now = Date.now()
        for (const [token, held] of this.imports) if (held.expires < now) this.imports.delete(token)
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
