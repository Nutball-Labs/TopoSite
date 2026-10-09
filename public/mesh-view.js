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

// SN: 00001
