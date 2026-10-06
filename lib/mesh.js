// mesh.js — Convert Z-Wave JS UI node objects into TopoSite's node model.
//
// This is the ONLY file that reads Z-Wave JS UI's internal ZUINode shape
// (api/lib/ZwaveClient.ts). ZUINode is not a stable API, so when a Z-Wave JS UI
// release changes it, the fix belongs here and nowhere else.

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
        rssi: route.rssi ?? null,
        repeaterRSSI: route.repeaterRSSI ? [...route.repeaterRSSI] : [],
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
        name: node.name || `NodeID ${node.id}`,
        location: node.loc || '',
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

/** Convert every node known to the Z-Wave client. */
export function getNodes(zwave) {
    return zwave.getNodes().map(toNode)
}

// SN: 00001
