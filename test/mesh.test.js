// mesh.test.js — Tests for the ZUINode → TopoSite node mapping (run: npm test)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toNode, toRoute, toRSSI, getNodes } from '../lib/mesh.js'
import TopoSite, { BASE } from '../index.js'

test('controller, mains and battery nodes get the Z-Wave JS UI roles', () => {
    assert.equal(toNode({ id: 1, isControllerNode: true, isListening: true, available: true }).role, 'controller')
    assert.equal(toNode({ id: 2, isListening: true, available: true }).role, 'listening')
    assert.equal(toNode({ id: 3, isListening: false, isFrequentListening: '1000ms', available: true }).role, 'sleeping')
})

test('failed takes precedence over dead', () => {
    assert.equal(toNode({ id: 4, failed: true, available: false }).status, 'failed')
    assert.equal(toNode({ id: 5, failed: false, available: false }).status, 'dead')
    assert.equal(toNode({ id: 6, failed: false, available: true }).status, 'ok')
})

test('route hop count is repeaters + 1', () => {
    const r = toRoute({ repeaters: [7, 9], rssi: -60, repeaterRSSI: [-70, -65], protocolDataRate: 3 })
    assert.equal(r.hops, 3)
    assert.deepEqual(r.repeaters, [7, 9])
    assert.equal(toRoute(undefined), null)
    assert.equal(toRoute({}).hops, 1)
})

test('missing name falls back to Z-Wave JS UI style label', () => {
    const n = toNode({ id: 12, available: true, neighbors: [1, 4] })
    assert.equal(n.name, 'NodeID 12')
    assert.deepEqual(n.neighbors, [1, 4])
    assert.equal(n.lwr, null)
})

// Values below are from a live Z-Wave JS UI 11.24.2 mesh (2026-10-09).

test('RSSI error codes are not reported as dBm', () => {
    assert.equal(toRSSI(-94), -94)
    assert.equal(toRSSI(127), null)
    assert.equal(toRSSI(126), 'saturated')
    assert.equal(toRSSI(125), 'no-signal')
    assert.equal(toRSSI(undefined), null)
    const r = toRoute({ repeaters: [2, 3, 60, 78], rssi: -75, repeaterRSSI: [127, 127, -74, -71], protocolDataRate: 3 })
    assert.equal(r.hops, 5)
    assert.deepEqual(r.repeaterRSSI, [null, null, -74, -71])
    assert.equal(toRoute({ repeaters: [2], repeaterRSSI: [127] }).rssi, null)
})

test('route failure between two nodes is kept', () => {
    const r = toRoute({ repeaters: [58, 45], rssi: -94, repeaterRSSI: [-95, -85], protocolDataRate: 1, routeFailedBetween: [58, 78] })
    assert.deepEqual(r.failedBetween, [58, 78])
})

test('NUL-padded names and locations count as empty', () => {
    const n = toNode({ id: 63, name: '\u0000', loc: '\u0000', available: true })
    assert.equal(n.name, 'NodeID 63')
    assert.equal(n.location, '')
    assert.equal(toNode({ id: 3, name: ' Hall Bath Fan ', loc: 'Hallway', available: true }).name, 'Hall Bath Fan')
})

test('getNodes skips virtual nodes and separates stale neighbor IDs', () => {
    const zwave = {
        getNodes: () => [
            { id: 255, name: 'Broadcast', virtual: true, kind: 'broadcast', available: true },
            { id: 1, isControllerNode: true, isListening: true, available: true },
            { id: 2, isListening: true, available: true, neighbors: [1, 6, 75] },
            { id: 75, isListening: false, available: false, neighbors: [] },
        ],
    }
    const nodes = getNodes(zwave)
    assert.deepEqual(nodes.map((n) => n.id), [1, 2, 75])
    const n2 = nodes.find((n) => n.id === 2)
    assert.deepEqual(n2.neighbors, [1, 75], 'dead node 75 still exists, so it stays')
    assert.deepEqual(n2.unknownNeighbors, [6], 'node 6 was removed but is still in the controller table')
})

test('plugin registers its API under the TopoSite base path and serves nodes', () => {
    const routes = {}
    const ctx = {
        zwave: { getNodes: () => [{ id: 1, isControllerNode: true, available: true }] },
        mqtt: null,
        app: { get: (path, fn) => { routes[path] = fn } },
        logger: { info() {}, error() {} },
    }
    new TopoSite(ctx)
    const handler = routes[`${BASE}/api/nodes`]
    assert.ok(handler, 'nodes route registered')

    let body
    handler({}, { json: (b) => { body = b }, status() { return this } })
    assert.equal(body.success, true)
    assert.equal(body.data[0].role, 'controller')
})

// SN: 00001
