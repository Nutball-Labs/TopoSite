// mesh-view.js — Pure view logic for the map page: colors, auto-layout and
// route segments. No DOM or Leaflet here, so `npm test` can exercise it in Node.
//
// Colors and route drawing follow Z-Wave JS UI's mesh graph
// (src/components/custom/ZwaveGraph.vue) — see CLAUDE.md, "Z-Wave visual language".

export const CONTROLLER_COLOR = '#7e57c2'
export const DEAD_COLOR = '#8b0000'
export const UNKNOWN_COLOR = '#666666'

// Index = hop count. 5+ hops is a TopoSite addition (Z-Wave JS UI stops at 4).
const HOP_COLORS = [null, '#00BCD4', '#2DCC70', '#F1C40F', '#E77E23', '#4a148c']

// zwave-js ProtocolDataRate: 1 = 9.6k, 2 = 40k, 3 = 100k, 4 = Long Range 100k
const RATE_COLORS = { 1: '#8b0000', 2: '#F1C40F', 3: '#2DCC70', 4: '#3F51B5' }
const RATE_LABELS = { 1: '9.6 kbit/s', 2: '40 kbit/s', 3: '100 kbit/s', 4: 'LR 100 kbit/s' }

export const HOP_LEGEND = [
    ['Controller', CONTROLLER_COLOR],
    ['Direct', HOP_COLORS[1]],
    ['2 hops', HOP_COLORS[2]],
    ['3 hops', HOP_COLORS[3]],
    ['4 hops', HOP_COLORS[4]],
    ['5+ hops', HOP_COLORS[5]],
    ['Dead / failed', DEAD_COLOR],
    ['Unknown', UNKNOWN_COLOR],
]
export const RATE_LEGEND = [1, 2, 3, 4].map((r) => [RATE_LABELS[r], RATE_COLORS[r]])

/** The route a node is colored and drawn by: LWR, or NLWR when there is no LWR. */
export function mainRoute(node) {
    return node.lwr ?? node.nlwr ?? null
}

export function hopsOf(node) {
    return mainRoute(node)?.hops ?? null
}

export function nodeColor(node) {
    if (node.role === 'controller') return CONTROLLER_COLOR
    if (node.status !== 'ok') return DEAD_COLOR
    const hops = hopsOf(node)
    if (!hops) return UNKNOWN_COLOR
    return HOP_COLORS[Math.min(hops, 5)]
}

export function rateColor(rate) {
    return RATE_COLORS[rate] ?? UNKNOWN_COLOR
}

export function rateLabel(rate) {
    return RATE_LABELS[rate] ?? 'unknown rate'
}

/** Display text for an RSSI value from the API (dBm, 'saturated', 'no-signal' or null). */
export function rssiLabel(rssi) {
    if (typeof rssi === 'number') return `${rssi} dBm`
    if (rssi === 'saturated') return 'saturated'
    if (rssi === 'no-signal') return 'no signal'
    return ''
}

export function nodeLabel(node) {
    if (node.status === 'dead') return `DEAD: ${node.name}`
    if (node.status === 'failed') return `FAILED: ${node.name}`
    return node.name
}

/**
 * Temporary automatic placement until nodes can be dragged and saved
 * (that needs a write route, which needs auth first — see CLAUDE.md).
 *
 * Controller in the center. Each Z-Wave JS UI location gets a pie slice sized
 * by its node count, so rooms stay together; within a slice, distance from the
 * center is the hop count, so the rings still read as "how far out".
 * Returns Map(id → [y, x]) in plan pixels of a size × size square.
 */
export function autoLayout(nodes, size = 1000) {
    const pos = new Map()
    const c = size / 2
    const ring = size / 2 / 7
    const controller = nodes.find((n) => n.role === 'controller')
    if (controller) pos.set(controller.id, [c, c])

    const others = nodes.filter((n) => n !== controller)
    const byLoc = new Map()
    for (const n of others) {
        const loc = n.location || '(no location)'
        if (!byLoc.has(loc)) byLoc.set(loc, [])
        byLoc.get(loc).push(n)
    }
    const locs = [...byLoc.keys()].sort((a, b) => a.localeCompare(b))
    const total = others.length || 1
    let angle = -Math.PI / 2
    for (const loc of locs) {
        const group = byLoc.get(loc).sort((a, b) => (hopsOf(a) ?? 9) - (hopsOf(b) ?? 9) || a.id - b.id)
        const span = (2 * Math.PI * group.length) / total
        group.forEach((n, i) => {
            const a = angle + (span * (i + 0.5)) / group.length
            const hops = n.status === 'ok' ? hopsOf(n) : null
            const r = ring * (hops ? Math.min(hops, 5) : 6)
            pos.set(n.id, [c + r * Math.sin(a), c + r * Math.cos(a)])
        })
        angle += span
    }
    return pos
}

/**
 * Break a route into hop segments the way Z-Wave JS UI does: controller →
 * repeaters[0] → … → node. Segment i is labeled with rssi (i = 0) or
 * repeaterRSSI[i - 1].
 */
export function routeSegments(node, route, controllerId) {
    const segs = []
    const reps = route.repeaters ?? []
    for (let i = 0; i <= reps.length; i++) {
        segs.push({
            from: i === 0 ? controllerId : reps[i - 1],
            to: i < reps.length ? reps[i] : node.id,
            rssi: i === 0 ? route.rssi : route.repeaterRSSI?.[i - 1] ?? null,
            rate: route.protocolDataRate,
        })
    }
    return segs
}

/**
 * Every line to draw, deduplicated per kind:
 *   kind 'lwr'      — last working route hops (and NLWR for nodes with no LWR)
 *   kind 'nlwr'     — next-to-last working route hops
 *   kind 'failed'   — the failed hop recorded on a route
 *   kind 'neighbor' — neighbor-table entries (only where Z-Wave JS UI has them)
 * Each link: {kind, a, b, rssi, rate, routes: [node ids whose route uses it]}.
 */
export function buildLinks(nodes) {
    const controller = nodes.find((n) => n.role === 'controller')
    const cid = controller?.id ?? 1
    const ids = new Set(nodes.map((n) => n.id))
    const links = new Map()
    const add = (kind, a, b, extra = {}) => {
        if (!ids.has(a) || !ids.has(b) || a === b) return
        const key = `${kind}:${Math.min(a, b)}-${Math.max(a, b)}`
        const l = links.get(key) ?? { kind, a, b, rssi: null, rate: null, routes: [] }
        if (l.rssi === null && extra.rssi !== undefined) l.rssi = extra.rssi
        if (l.rate === null && extra.rate !== undefined) l.rate = extra.rate
        if (extra.route !== undefined) l.routes.push(extra.route)
        links.set(key, l)
    }
    for (const n of nodes) {
        const routes = [['lwr', n.lwr], [n.lwr ? 'nlwr' : 'lwr', n.nlwr]]
        for (const [kind, route] of routes) {
            if (!route) continue
            for (const s of routeSegments(n, route, cid)) add(kind, s.from, s.to, { rssi: s.rssi, rate: s.rate, route: n.id })
            if (route.failedBetween) add('failed', route.failedBetween[0], route.failedBetween[1], { route: n.id })
        }
        for (const nb of n.neighbors ?? []) add('neighbor', n.id, nb)
    }
    return [...links.values()]
}

/**
 * What a map draws (MAPS.md "Rendering rules"), given which nodes are shown and
 * where nodes sit on this map:
 *   - routes of shown nodes only (LWR; NLWR as kind 'nlwr', or 'lwr' when there
 *     is no LWR — same as buildLinks), plus their failed hops
 *   - neighbor lines only between shown, positioned nodes
 *   - ghosts: nodes on a shown node's route that aren't drawn as nodes — hidden
 *     repeaters (and a hidden controller), or shown ones with no position yet.
 *     A ghost sits at its position on this map when it has one; otherwise
 *     midway between its nearest positioned neighbors on the route, flagged
 *     `approx`. Ghost kind is 'lwr' if it's on any LWR-kind route, else 'nlwr'
 *     (so it can be hidden with the backup-routes layer).
 * shown: Set of node ids; positioned: Map(id → [y, x]) of every node with a
 * position on this map (shown or not).
 * Returns {links, ghosts: [{id, kind, pos, approx, shown}], pos: Map(id → [y, x])}
 * where pos covers shown positioned nodes and ghosts.
 */
export function mapView(nodes, shown, positioned) {
    const controller = nodes.find((n) => n.role === 'controller')
    const cid = controller?.id ?? 1
    const ids = new Set(nodes.map((n) => n.id))
    const pos = new Map()
    for (const [id, p] of positioned) if (shown.has(id)) pos.set(id, p)
    const ghosts = new Map()

    const paths = []
    for (const n of nodes) {
        if (!shown.has(n.id)) continue
        for (const [kind, route] of [['lwr', n.lwr], [n.lwr ? 'nlwr' : 'lwr', n.nlwr]]) {
            if (route) paths.push({ kind, n, route, path: [cid, ...(route.repeaters ?? []), n.id].filter((id) => ids.has(id)) })
        }
    }
    paths.sort((a, b) => (a.kind === 'lwr' ? 0 : 1) - (b.kind === 'lwr' ? 0 : 1))
    for (const { kind, path } of paths) {
        // Exact ghosts first: hidden nodes on the route that have a position here
        for (const id of path) {
            if (pos.has(id) || shown.has(id) || !positioned.has(id)) continue
            pos.set(id, positioned.get(id))
            ghosts.set(id, { id, kind, pos: positioned.get(id), approx: false, shown: false })
        }
        // Then anything still without a position: interpolate along the route
        for (let i = 0; i < path.length; i++) {
            const id = path[i]
            if (pos.has(id)) continue
            let j = i - 1
            while (j >= 0 && !pos.has(path[j])) j--
            let k = i + 1
            while (k < path.length && !pos.has(path[k])) k++
            if (j < 0 || k >= path.length) continue
            const [a, b] = [pos.get(path[j]), pos.get(path[k])]
            const t = (i - j) / (k - j)
            const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
            pos.set(id, p)
            ghosts.set(id, { id, kind, pos: p, approx: true, shown: shown.has(id) })
        }
    }

    const links = new Map()
    const add = (kind, a, b, extra = {}) => {
        if (!pos.has(a) || !pos.has(b) || a === b) return
        const key = `${kind}:${Math.min(a, b)}-${Math.max(a, b)}`
        const l = links.get(key) ?? { kind, a, b, rssi: null, rate: null, routes: [] }
        if (l.rssi === null && extra.rssi !== undefined) l.rssi = extra.rssi
        if (l.rate === null && extra.rate !== undefined) l.rate = extra.rate
        if (extra.route !== undefined && !l.routes.includes(extra.route)) l.routes.push(extra.route)
        links.set(key, l)
    }
    for (const { kind, n, route } of paths) {
        for (const s of routeSegments(n, route, cid)) add(kind, s.from, s.to, { rssi: s.rssi, rate: s.rate, route: n.id })
        if (route.failedBetween) add('failed', route.failedBetween[0], route.failedBetween[1], { route: n.id })
    }
    for (const n of nodes) {
        if (!shown.has(n.id) || ghosts.has(n.id)) continue
        for (const nb of n.neighbors ?? []) if (shown.has(nb) && !ghosts.has(nb)) add('neighbor', n.id, nb)
    }
    return { links: [...links.values()], ghosts: [...ghosts.values()], pos }
}

// Mesh-health thresholds — first guesses, to be tuned by eye on a real mesh
export const HEALTH = {
    weakRssi: -85,       // dBm: a route hop at or below this is weak
    veryWeakRssi: -95,   // dBm: …and at or below this, very weak (as is 'no-signal')
    fewNeighbors: 2,     // a node with fewer neighbors than this has little to route through
}
export const HEALTH_COLORS = { warn: '#ff9800', bad: '#e53935' }

/**
 * Mesh-health flags (CLAUDE.md: "Mesh health is core scope"). Pure, from
 * /api/nodes data:
 *   nodes: Map(id → {level: 'warn'|'bad', reasons: [text]})
 *     bad:  no neighbors at all (isolated); a failed hop on its route
 *     warn: fewer than HEALTH.fewNeighbors neighbors; no route statistics;
 *           its main route has a weak hop; running on a backup route only
 *     Neighbor counts are only judged once neighbor tables are known for most
 *     of the mesh (they're a cache that's empty until refreshed).
 *     Dead/failed status is already shown by the node color, so it isn't repeated.
 *   hops: [{a, b, level, rssi}] — weak route hops (LWR, and NLWR as kind 'nlwr')
 *   oneWay: [{from, to}] — `from` lists `to` as a neighbor but not the other way
 *     round (both tables known)
 */
export function meshHealth(nodes) {
    const controller = nodes.find((n) => n.role === 'controller')
    const cid = controller?.id ?? 1
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const known = nodes.filter((n) => n.neighbors?.length).length
    const tablesKnown = nodes.length > 1 && known >= (nodes.length - 1) / 2
    const flags = new Map()
    const flag = (id, level, reason) => {
        const f = flags.get(id) ?? { level, reasons: [] }
        if (level === 'bad') f.level = 'bad'
        f.reasons.push(reason)
        flags.set(id, f)
    }
    const hopLevel = (rssi) => (rssi === 'no-signal' || (typeof rssi === 'number' && rssi <= HEALTH.veryWeakRssi)) ? 'bad'
        : typeof rssi === 'number' && rssi <= HEALTH.weakRssi ? 'warn' : null
    const hops = new Map()
    for (const n of nodes) {
        if (n.role === 'controller') continue
        if (tablesKnown && n.status === 'ok') {
            const count = n.neighbors?.length ?? 0
            if (count === 0) flag(n.id, 'bad', 'Isolated — no neighbors')
            else if (count < HEALTH.fewNeighbors) flag(n.id, 'warn', `Only ${count} neighbor${count === 1 ? '' : 's'}`)
        }
        if (!n.lwr && !n.nlwr) {
            if (n.status === 'ok') flag(n.id, 'warn', 'No route statistics yet')
        } else if (!n.lwr) {
            flag(n.id, 'warn', 'Running on its backup route (no last working route)')
        }
        for (const [kind, route] of [['lwr', n.lwr], [n.lwr ? 'nlwr' : 'lwr', n.nlwr]]) {
            if (!route) continue
            if (route.failedBetween && kind === 'lwr') flag(n.id, 'bad', `Failed hop ${route.failedBetween.join(' → ')}`)
            let worst = null
            for (const s of routeSegments(n, route, cid)) {
                const level = hopLevel(s.rssi)
                if (!level) continue
                const key = `${kind}:${Math.min(s.from, s.to)}-${Math.max(s.from, s.to)}`
                if (!hops.has(key) || level === 'bad') hops.set(key, { a: s.from, b: s.to, kind, level, rssi: s.rssi })
                if (worst !== 'bad') worst = level
            }
            if (worst && kind === 'lwr') flag(n.id, worst === 'bad' ? 'bad' : 'warn', 'Weak signal on its route')
        }
    }
    const oneWay = []
    for (const n of nodes) {
        for (const nb of n.neighbors ?? []) {
            const other = byId.get(nb)
            if (other?.neighbors?.length && !other.neighbors.includes(n.id)) oneWay.push({ from: n.id, to: nb })
        }
    }
    return { nodes: flags, hops: [...hops.values()], oneWay }
}

// SN: 00001
