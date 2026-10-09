// mesh.js — Convert Z-Wave JS UI node objects into TopoSite's node model.
//
// This is the ONLY file that reads Z-Wave JS UI's internal ZUINode shape
// (api/lib/ZwaveClient.ts). ZUINode is not a stable API, so when a Z-Wave JS UI
// release changes it, the fix belongs here and nowhere else.

// zwave-js RssiError codes: values in the rssi fields that are not dBm readings.
const RSSI_CODES = {
    127: null,          // NotAvailable — no measurement
    126: 'saturated',   // ReceiverSaturated — signal too strong to measure
    125: 'no-signal',   // NoSignalDetected
}

/** An RSSI value: dBm number, 'saturated', 'no-signal', or null when not measured. */
export function toRSSI(value) {
    if (value === undefined || value === null) return null
    return value in RSSI_CODES ? RSSI_CODES[value] : value
}

/** Strip the NUL padding some devices report as their name or location. */
export function cleanText(value) {
    return (value ?? '').replace(/\0/g, '').trim()
}

/**
 * Map a zwave-js RouteStatistics object (node.statistics.lwr / .nlwr) to a
 * plain route: hop count, repeaters, per-hop RSSI and data rate.
 */
export function toRoute(route) {
    if (!route) return null
    const repeaters = route.repeaters ?? []
    return {
        hops: repeaters.length + 1,
        repeaters: [...repeaters],
        rssi: toRSSI(route.rssi),
        repeaterRSSI: (route.repeaterRSSI ?? []).map(toRSSI),
        protocolDataRate: route.protocolDataRate ?? null,
        failedBetween: route.routeFailedBetween ? [...route.routeFailedBetween] : null,
    }
}

/**
 * Role decides the map shape, following Z-Wave JS UI's mesh graph:
 * controller = star, listening (mains) = hexagon, sleeping (battery, incl. FLiRS) = square.
 */
export function roleOf(node) {
    if (node.isControllerNode) return 'controller'
    return node.isListening ? 'listening' : 'sleeping'
}

/**
 * Status follows Z-Wave JS UI's labels: failed takes precedence over dead.
 */
export function statusOf(node) {
    if (node.failed) return 'failed'
    if (!node.available) return 'dead'
    return 'ok'
}

/** Convert one ZUINode to a TopoSite node. */
export function toNode(node) {
    return {
        id: node.id,
        name: cleanText(node.name) || `NodeID ${node.id}`,
        location: cleanText(node.loc),
        role: roleOf(node),
        isListening: !!node.isListening,
        isFrequentListening: node.isFrequentListening || false,
        isRouting: !!node.isRouting,
        status: statusOf(node),
        neighbors: [...(node.neighbors ?? [])],
        lwr: toRoute(node.statistics?.lwr),
        nlwr: toRoute(node.statistics?.nlwr),
    }
}

/** Network home ID as lowercase hex without 0x (e.g. 'cdfbb3c7'), or null before the driver is ready. */
export function homeIdOf(zwave) {
    const hex = zwave.homeHex
    return typeof hex === 'string' && /^0x[0-9a-f]+$/i.test(hex) ? hex.slice(2).toLowerCase() : null
}

/**
 * Convert every physical node known to the Z-Wave client. Virtual nodes
 * (broadcast, multicast groups) are skipped. Neighbor IDs that match no node —
 * stale entries left in the controller's table after a node was removed — move
 * to unknownNeighbors so the map never draws a link to nothing. Each node gets
 * `key` = zwave:<homeId>:<nodeId>, the placement key (ROADMAP.md deviceKey).
 *
 * Neighbors are only as fresh as Z-Wave JS UI's cache: it fills them when a
 * node is opened in its Network Graph or refreshNeighbors() runs, and they are
 * empty after a restart. LWR/NLWR routes are always present.
 */
export function getNodes(zwave) {
    const home = homeIdOf(zwave)
    const nodes = zwave.getNodes().filter((n) => !n.virtual).map(toNode)
    for (const n of nodes) n.key = home ? `zwave:${home}:${n.id}` : null
    const ids = new Set(nodes.map((n) => n.id))
    for (const n of nodes) {
        n.unknownNeighbors = n.neighbors.filter((id) => !ids.has(id))
        n.neighbors = n.neighbors.filter((id) => ids.has(id))
    }
    return nodes
}

// SN: 00001
