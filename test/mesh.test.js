// mesh.test.js — Tests for the ZUINode → TopoSite node mapping (run: npm test)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toNode, toRoute } from '../lib/mesh.js'
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
