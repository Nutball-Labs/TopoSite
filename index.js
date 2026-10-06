// index.js — TopoSite plugin entry point for Z-Wave JS UI.
//
// Z-Wave JS UI loads this with import() and constructs the default export with
// a PluginContext { zwave, mqtt, app, logger } (docs/guide/plugins.md).
//
// Routes: plugin routes are mounted at the ROOT of Z-Wave JS UI's web server,
// so every TopoSite route lives under BASE to avoid collisions.
// Auth: plugin routes run BEFORE Z-Wave JS UI's login check, so anything served
// here is reachable without logging in. Keep routes read-only until TopoSite
// has its own auth (see CLAUDE.md, Known Issues).

import { getNodes } from './lib/mesh.js'

export const BASE = '/toposite'

export default class TopoSite {
    constructor(ctx) {
        this.zwave = ctx.zwave
        this.logger = ctx.logger
        this.app = ctx.app

        this.app.get(`${BASE}/api/nodes`, (req, res) => {
            try {
                res.json({ success: true, data: getNodes(this.zwave) })
            } catch (error) {
                this.logger.error(`TopoSite: failed to read nodes: ${error.message}`)
                res.status(500).json({ success: false, message: error.message })
            }
        })

        this.logger.info(`TopoSite loaded — API at ${BASE}/api/nodes`)
    }

    async destroy() {
        // Nothing to clean up yet: no event listeners or timers registered.
    }
}

// SN: 00001
