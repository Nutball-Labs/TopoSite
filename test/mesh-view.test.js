// mesh-view.test.js — Tests for the map page's pure view logic (run: npm test)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoLayout, buildLinks, nodeColor, routeSegments, rssiLabel, nodeLabel } from '../public/mesh-view.js'

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

// SN: 00001
