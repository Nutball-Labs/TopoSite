// mesh-view.test.js — Tests for the map page's pure view logic (run: npm test)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoLayout, buildLinks, forceLayout, mapView, meshHealth, nodeColor, routeSegments, rssiLabel, nodeLabel } from '../public/mesh-view.js'

// Shaped like /toposite/api/nodes output; values from a live 11.24.2 mesh (2026-10-09).
const route = (repeaters, rssi, repeaterRSSI, rate, failedBetween = null) =>
    ({ hops: repeaters.length + 1, repeaters, rssi, repeaterRSSI, protocolDataRate: rate, failedBetween })
const node = (id, extra) => ({
    id, name: `n${id}`, location: '', role: 'listening', status: 'ok',
    neighbors: [], unknownNeighbors: [], lwr: null, nlwr: null, ...extra,
})

const NODES = [
    node(1, { role: 'controller' }),
    node(2, { location: 'Geek Cave', lwr: route([], -76, [], 3), neighbors: [1, 3] }),
    node(3, { location: 'Hallway', lwr: route([2], -75, [null], 1), neighbors: [2] }),
    node(59, { location: 'Paincave', lwr: route([2, 3], -75, [null, -74], 3) }),
    node(68, { location: 'Workshop', nlwr: route([], null, [], 3) }),
    node(75, { location: 'Living Room', role: 'sleeping', status: 'dead' }),
    node(78, { location: 'Workshop', lwr: route([2], -94, [-95], 1, [2, 78]) }),
]

test('node colors follow hop count, with 5+ hops dark purple', () => {
    assert.equal(nodeColor(NODES[0]), '#7e57c2')
    assert.equal(nodeColor(NODES[1]), '#00BCD4')
    assert.equal(nodeColor(NODES[3]), '#F1C40F')
    assert.equal(nodeColor(node(9, { lwr: route([2, 3, 60, 78], -75, [], 3) })), '#4a148c')
    assert.equal(nodeColor(node(9, { lwr: route([2, 3, 60, 78, 5, 6], -75, [], 3) })), '#4a148c')
    assert.equal(nodeColor(NODES[4]), '#00BCD4', 'NLWR used when there is no LWR')
    assert.equal(nodeColor(NODES[5]), '#8b0000')
    assert.equal(nodeColor(node(9, {})), '#666666')
    assert.equal(nodeLabel(NODES[5]), 'DEAD: n75')
})

test('route segments run controller → repeaters → node with Z-Wave JS UI RSSI labels', () => {
    const segs = routeSegments(NODES[3], NODES[3].lwr, 1)
    assert.deepEqual(segs.map((s) => [s.from, s.to, s.rssi]), [[1, 2, -75], [2, 3, null], [3, 59, -74]])
    assert.equal(rssiLabel(-74), '-74 dBm')
    assert.equal(rssiLabel(null), '')
    assert.equal(rssiLabel('saturated'), 'saturated')
})

test('links are deduplicated per kind and include failed hops and known neighbors', () => {
    const links = buildLinks(NODES)
    const key = (l) => `${l.kind}:${Math.min(l.a, l.b)}-${Math.max(l.a, l.b)}`
    const keys = links.map(key).sort()
    assert.ok(keys.includes('lwr:1-2'))
    assert.equal(keys.filter((k) => k === 'lwr:1-2').length, 1, 'shared hop drawn once')
    assert.deepEqual(links.find((l) => key(l) === 'lwr:1-2').routes.sort((a, b) => a - b), [2, 3, 59, 78])
    assert.ok(keys.includes('lwr:1-68'), 'NLWR drawn as main route when no LWR')
    assert.ok(keys.includes('failed:2-78'))
    assert.ok(keys.includes('neighbor:1-2') && keys.includes('neighbor:2-3'))
    assert.equal(keys.filter((k) => k === 'neighbor:2-3').length, 1)
})

test('auto-layout puts the controller in the center and every node on the plan', () => {
    const pos = autoLayout(NODES, 1000)
    assert.deepEqual(pos.get(1), [500, 500])
    assert.equal(pos.size, NODES.length)
    for (const [y, x] of pos.values()) {
        assert.ok(y >= 0 && y <= 1000 && x >= 0 && x <= 1000)
    }
    const dist = (id) => Math.hypot(pos.get(id)[0] - 500, pos.get(id)[1] - 500)
    assert.ok(dist(2) < dist(3) && dist(3) < dist(59), 'more hops = further out')
    assert.ok(dist(75) > dist(59), 'dead node on the outer ring')
})

test('map view: hidden repeaters on shown routes become ghosts; links and neighbors follow the shown set', () => {
    // 59 routes 1 → 2 → 3 → 59. Show only 59 and the controller; 2 is placed on this map, 3 isn't.
    const shown = new Set([1, 59])
    const positioned = new Map([[1, [0, 0]], [2, [0, 100]], [59, [0, 400]], [75, [9, 9]]])
    const v = mapView(NODES, shown, positioned)
    const g = Object.fromEntries(v.ghosts.map((x) => [x.id, x]))
    assert.deepEqual(Object.keys(g).map(Number).sort((a, b) => a - b), [2, 3], 'only route repeaters, not other hidden nodes')
    assert.deepEqual([g[2].approx, g[2].pos], [false, [0, 100]], 'placed hidden repeater: exact')
    assert.deepEqual([g[3].approx, g[3].pos], [true, [0, 250]], 'unplaced: midway between its route neighbors')
    assert.equal(g[3].kind, 'lwr')
    const kinds = v.links.map((l) => `${l.kind}:${l.a}-${l.b}`).sort()
    assert.deepEqual(kinds, ['lwr:1-2', 'lwr:2-3', 'lwr:3-59'], "no neighbor lines to ghosts, no hidden nodes' routes")
    assert.ok(!v.pos.has(75), 'hidden node off every shown route is not drawn')

    // Shown but not placed (in the tray) and on a route: an approximate ghost, flagged shown
    const v2 = mapView(NODES, new Set([1, 2, 3, 59]), new Map([[1, [0, 0]], [2, [0, 100]], [59, [0, 400]]]))
    const g3 = v2.ghosts.find((x) => x.id === 3)
    assert.deepEqual([g3.approx, g3.shown], [true, true])
    assert.ok(v2.links.some((l) => l.kind === 'neighbor' && l.a === 2 && l.b === 1), 'neighbors between shown, positioned nodes')
    assert.ok(!v2.links.some((l) => l.kind === 'neighbor' && (l.a === 3 || l.b === 3)), 'none to a node that is only a ghost')

    // NLWR-only repeaters get kind 'nlwr' (hidden with the backup-routes layer)
    const extra = [...NODES, node(80, { lwr: route([], -60, [], 3), nlwr: route([68], -70, [-71], 3) })]
    const v3 = mapView(extra, new Set([1, 80]), new Map([[1, [0, 0]], [80, [0, 200]]]))
    assert.deepEqual(v3.ghosts.map((x) => [x.id, x.kind, x.pos]), [[68, 'nlwr', [0, 100]]])

    // Can't place a ghost with no positioned anchor on one side: its segments are skipped
    const v4 = mapView(NODES, new Set([59]), new Map([[59, [0, 400]]]))
    assert.deepEqual([v4.ghosts.length, v4.links.length], [0, 0])
})

test('mesh health: isolated, few neighbors, weak hops, backup-only, failed hops, one-way links', () => {
    const h = meshHealth(NODES)
    const f = (id) => h.nodes.get(id)
    // Neighbor tables are known for 2 of 7 nodes — too few to judge neighbor counts
    assert.ok(!f(59)?.reasons.some((r) => /neighbor/i.test(r)))
    assert.deepEqual(f(78), { level: 'bad', reasons: ['Failed hop 2 → 78', 'Weak signal on its route'] })
    assert.equal(f(68).reasons[0], 'Running on its backup route (no last working route)')
    assert.equal(f(75), undefined, 'dead is already shown by color, and dead nodes have no route to judge')
    assert.deepEqual(h.hops.map((x) => [x.a, x.b, x.level]), [[1, 2, 'warn'], [2, 78, 'bad']])
    assert.deepEqual(h.oneWay, [], 'node 2 lists 1, but 1 has no table to compare')

    const mesh = [
        node(1, { role: 'controller', neighbors: [2, 3] }),
        node(2, { lwr: route([], -60, [], 3), neighbors: [1, 3] }),
        node(3, { lwr: route([], -60, [], 3), neighbors: [1] }),   // 2 lists 3, 3 doesn't list 2
        node(4, { lwr: route([], -60, [], 3), neighbors: [] }),
        node(5, {}),
    ]
    const h2 = meshHealth(mesh)
    assert.deepEqual(h2.nodes.get(4), { level: 'bad', reasons: ['Isolated — no neighbors'] })
    assert.deepEqual(h2.nodes.get(3), { level: 'warn', reasons: ['Only 1 neighbor'] })
    assert.ok(h2.nodes.get(5).reasons.includes('No route statistics yet'))
    assert.deepEqual(h2.oneWay, [{ from: 2, to: 3 }])
})

test('network graph layout: controller centred, deterministic, on the canvas, route neighbors closer than strangers', () => {
    const a = forceLayout(NODES, 1000)
    const b = forceLayout(NODES, 1000)
    assert.deepEqual([...a], [...b], 'same mesh, same picture')
    assert.deepEqual(a.get(1), [500, 500])
    for (const [y, x] of a.values()) assert.ok(y >= 0 && y <= 1000 && x >= 0 && x <= 1000)
    const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1])
    assert.ok(dist(a.get(3), a.get(2)) < dist(a.get(3), a.get(75)), '3 routes via 2, nothing ties it to the dead node 75')
    const seen = new Set([...a.values()].map(([y, x]) => `${Math.round(y)},${Math.round(x)}`))
    assert.equal(seen.size, NODES.length, 'no two nodes on the same spot')
})

// SN: 00001
