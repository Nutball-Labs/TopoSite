// routes.test.js — Plugin routes with a fake router and a temp store (run: npm test)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import TopoSite, { BASE, PUBLIC_DIR } from '../index.js'

async function setup({ nodes = [{ id: 1, isControllerNode: true, available: true }], authEnabled = false, zwave = true } = {}) {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'toposite-routes-'))
    await writeFile(path.join(storeDir, 'settings.json'), JSON.stringify({ gateway: { authEnabled } }))
    const routes = {}
    const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((m) =>
        [m, (p, fn) => { routes[`${m.toUpperCase()} ${p}`] = fn }]))
    const ctx = {
        zwave: zwave ? { homeHex: '0xcdfbb3c7', getNodes: () => nodes } : undefined,
        mqtt: null,
        app,
        logger: { info() {}, error() {} },
    }
    new TopoSite(ctx, { storeDir, env: {} })
    return { routes, storeDir }
}

/** Call a guarded API handler; resolves with {status, body}. */
function call(handler, req = {}) {
    return new Promise((resolve) => {
        let status = 200
        const res = {
            headersSent: false,
            status(c) { status = c; return this },
            json(body) { this.headersSent = true; resolve({ status, body }) },
        }
        handler({ headers: {}, query: {}, params: {}, ...req }, res)
    })
}

test('nodes API serves nodes with placement keys', async () => {
    const { routes } = await setup()
    const { status, body } = await call(routes[`GET ${BASE}/api/nodes`])
    assert.equal(status, 200)
    assert.equal(body.data[0].role, 'controller')
    assert.equal(body.data[0].key, 'zwave:cdfbb3c7:1')
})

test('nodes API reports a clear error when Z-Wave is not enabled', async () => {
    const { routes } = await setup({ zwave: false })
    const { status, body } = await call(routes[`GET ${BASE}/api/nodes`])
    assert.equal(status, 503)
    assert.match(body.message, /not enabled/)
})

test('with Z-Wave JS UI auth on, every API route needs a login', async () => {
    const { routes } = await setup({ authEnabled: true })
    for (const key of Object.keys(routes).filter((k) => k.includes('/api/'))) {
        const { status, body } = await call(routes[key], { params: { id: 'x', deviceKey: 'x', phId: 'x' }, body: {} })
        assert.equal(status, 401, key)
        assert.equal(body.code, 'auth')
    }
})

test('map API: create a map, place a node, read the v2 layout', async () => {
    const { routes } = await setup()
    const created = await call(routes[`POST ${BASE}/api/maps`], { body: { name: 'House', widthPx: 100, heightPx: 100 } })
    assert.equal(created.status, 200)
    const id = created.body.data.id
    const put = routes[`PUT ${BASE}/api/maps/:id/placements`]
    assert.equal((await call(put, { params: { id }, body: { deviceKey: 'bad', x: 1, y: 1 } })).status, 400)
    assert.equal((await call(put, { params: { id: 'nope' }, body: { deviceKey: 'zwave:cdfbb3c7:2', x: 1, y: 1 } })).status, 404)
    assert.equal((await call(put, { params: { id: 'graph' }, body: { deviceKey: 'zwave:cdfbb3c7:2', x: 1, y: 1 } })).status, 409)
    const ok = await call(put, { params: { id }, body: { deviceKey: 'zwave:cdfbb3c7:1', x: 10, y: 20 } })
    assert.equal(ok.status, 200)
    const layout = await call(routes[`GET ${BASE}/api/layout`])
    assert.equal(layout.body.data.version, 2)
    const house = layout.body.data.maps.find((m) => m.id === id)
    assert.deepEqual(house.placements[0].deviceKey, 'zwave:cdfbb3c7:1')
    assert.ok(layout.body.data.maps.some((m) => m.id === 'graph'))
})

test('map page: bare base redirects to the trailing-slash URL, files come from public/', async () => {
    const { routes } = await setup()

    let redirect
    let passed = false
    routes[`GET ${BASE}`]({ path: BASE }, { redirect: (to) => { redirect = to } }, () => {})
    routes[`GET ${BASE}`]({ path: `${BASE}/` }, { redirect: () => assert.fail('redirect loop') }, () => { passed = true })
    assert.equal(redirect, 'toposite/')
    assert.ok(passed, '/toposite/ falls through to the page handler')

    const sent = []
    const res = { sendFile: (file, opts) => sent.push([file, opts]) }
    routes[`GET ${BASE}/*`]({ params: { 0: '' } }, res)
    routes[`GET ${BASE}/*`]({ params: { 0: 'vendor/leaflet/leaflet.js' } }, res)
    assert.equal(sent[0][0], 'index.html')
    assert.equal(sent[1][0], 'vendor/leaflet/leaflet.js')
    assert.equal(sent[0][1].root, PUBLIC_DIR)
    assert.equal(sent[0][1].dotfiles, 'deny')
})

// SN: 00002
