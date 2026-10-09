// index.js — TopoSite plugin entry point for Z-Wave JS UI.
//
// Z-Wave JS UI (≥ 11.6.0) loads this with import() and constructs the default
// export with a PluginContext { zwave, mqtt, app, logger } (docs/guide/plugins.md).
//
// Routes: plugin routes are mounted at the ROOT of Z-Wave JS UI's web server,
// so every TopoSite route lives under BASE to avoid collisions.
// Auth: plugin routes run BEFORE Z-Wave JS UI's login check, so anything served
// here is reachable without logging in. Keep routes read-only until TopoSite
// has its own auth (see CLAUDE.md, Known Issues). The map page's "Refresh
// neighbors" button talks to Z-Wave JS UI's own authenticated socket API, not
// to a route here.

import { fileURLToPath } from 'node:url'
import { getNodes } from './lib/mesh.js'

export const BASE = '/toposite'
export const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url))

export default class TopoSite {
    constructor(ctx) {
        this.zwave = ctx.zwave
        this.logger = ctx.logger
        this.app = ctx.app

        this.app.get(`${BASE}/api/nodes`, (req, res) => {
            // zwave is optional in PluginContext on Z-Wave JS UI's backend-refactor
            // branch (PR #4747): absent when Z-Wave isn't configured.
            if (!this.zwave) {
                return res.status(503).json({ success: false, message: 'Z-Wave is not enabled in Z-Wave JS UI' })
            }
            try {
                res.json({ success: true, data: getNodes(this.zwave) })
            } catch (error) {
                this.logger.error(`TopoSite: failed to read nodes: ${error.message}`)
                res.status(500).json({ success: false, message: error.message })
            }
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

        this.logger.info(`TopoSite loaded — map at ${BASE}/, API at ${BASE}/api/nodes`)
    }

    async destroy() {
        // Nothing to clean up yet: no event listeners or timers registered.
    }
}

// SN: 00001
