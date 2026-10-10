// exchange.test.js — Map export/import: file format, validation, match proposals (run: npm test)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Layout } from '../lib/layout.js'
import { buildExport, parseImport, proposeMatches, matchScore, FORMAT } from '../lib/exchange.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const fresh = async () => new Layout(await mkdtemp(path.join(tmpdir(), 'toposite-exchange-')))

// TopoSite nodes (lib/mesh.js shape), local install home cdfbb3c7
const node = (id, name, location, deviceId, extra = {}) =>
    ({ id, key: `zwave:cdfbb3c7:${id}`, name, location, deviceId, role: 'listening', dsk: null, ...extra })
const LOCAL = [
    node(1, 'wopr3', 'Geek Cave', '134-1-90', { role: 'controller' }),
    node(2, 'GeekCave_Lights', 'Geek Cave', '29-12341-17479'),
    node(14, 'Thermostat', 'Hallway', '57-1-17479'),
    node(60, 'Zwift Fan', 'Paincave', '99-1-1'),
    node(61, 'Zwift PC', 'Paincave', '99-1-1'),
]
const entry = (ref, fields) => ({ ref, homeId: null, nodeId: null, name: null, loc: null, deviceId: null, dsk: null, ...fields })

test('match levels follow the MAPS.md table', () => {
    const thermo = LOCAL[2]
    assert.equal(matchScore(entry('a', { homeId: 'cdfbb3c7', nodeId: 14, name: 'Thermostat', deviceId: '57-1-17479' }), thermo, 'cdfbb3c7'), 3, 'same install, same node')
    assert.equal(matchScore(entry('a', { dsk: 'X', name: 'other' }), { ...thermo, dsk: 'X' }, 'cdfbb3c7'), 3, 'same DSK')
    assert.equal(matchScore(entry('a', { homeId: 'aaaa', nodeId: 27, name: 'thermostat ', deviceId: '57-1-17479' }), thermo, 'cdfbb3c7'), 2, 'other network, same name + model')
    assert.equal(matchScore(entry('a', { deviceId: '57-1-17479', loc: 'hallway' }), thermo, 'cdfbb3c7'), 1, 'same model + location')
    assert.equal(matchScore(entry('a', { name: 'Thermostat' }), thermo, 'cdfbb3c7'), 1, 'same name only')
    assert.equal(matchScore(entry('a', { name: 'NodeID 14', deviceId: '1-1-1' }), { ...thermo, name: 'NodeID 14' }, 'x'), 0, 'generic names never match')
    assert.equal(matchScore(entry('a', { deviceId: '57-1-17479' }), thermo, 'cdfbb3c7'), 0, 'model alone is not evidence')
})

test('proposals: one local node per entry, strongest first; ties and contested nodes left for the user', () => {
    const entries = [
        entry('t', { homeId: 'cdfbb3c7', nodeId: 14, name: 'Thermostat', deviceId: '57-1-17479' }),   // certain
        entry('l', { homeId: 'ffff', nodeId: 9, name: 'GeekCave_Lights', deviceId: '29-12341-17479' }), // likely
        entry('f', { deviceId: '99-1-1', loc: 'Paincave' }),                                            // two Paincave 99-1-1 nodes: tie
        entry('c', { name: 'wopr3' }),                                                                   // controller is never proposed
        entry('x', { name: 'Garage Door' }),                                                             // nothing
    ]
    const m = proposeMatches(entries, LOCAL, 'cdfbb3c7')
    assert.deepEqual(m.t, { key: 'zwave:cdfbb3c7:14', confidence: 'certain' })
    assert.deepEqual(m.l, { key: 'zwave:cdfbb3c7:2', confidence: 'likely' })
    assert.equal(m.f.key, null)
    assert.equal(m.f.tied, 2)
    assert.deepEqual(m.c, { key: null, confidence: 'none' })
    assert.deepEqual(m.x, { key: null, confidence: 'none' })

    // two entries both naming the same node as their only best: neither gets it
    const twice = proposeMatches([entry('a', { name: 'Thermostat' }), entry('b', { name: 'Thermostat' })], LOCAL, 'cdfbb3c7')
    assert.equal(twice.a.key, null)
    assert.equal(twice.b.key, null)
    // a node taken at a stronger level isn't offered again lower down
    const once = proposeMatches([entry('a', { homeId: 'cdfbb3c7', nodeId: 14, name: 'Thermostat', deviceId: '57-1-17479' }),
        entry('b', { name: 'Thermostat' })], LOCAL, 'cdfbb3c7')
    assert.equal(once.a.key, 'zwave:cdfbb3c7:14')
    assert.equal(once.b.key, null)
})

test('export → import round trip: images, framing, positions, node list; placeholders for unmatched', async () => {
    const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    const src = await fresh()
    const map = await src.addMap({ name: 'House', widthPx: 3000, heightPx: 5100 })
    await src.setPlacement(map.id, { deviceKey: 'zwave:cdfbb3c7:14', x: 100, y: 200, seen: { name: 'Thermostat', deviceId: '57-1-17479' } })
    await src.setPlacement(map.id, { deviceKey: 'zwave:cdfbb3c7:2', x: 300, y: 400 })
    await src.setMapImage(map.id, { bytes: PNG1 })
    await src.setMapImage(map.id, { bytes: PNG1, variant: 'dark' })
    await src.updateMap(map.id, { nodes: { start: 'include', exceptions: ['zwave:cdfbb3c7:60'] }, view: { center: [5, 6], zoom: 1 } })

    const out = await buildExport({ layout: await src.load(), mapId: map.id, nodes: LOCAL, imagesDir: src.imagesDir, homeId: 'cdfbb3c7', version: '0.1.0' })
    assert.equal(out.format, FORMAT)
    assert.equal(out.version, 2)
    assert.deepEqual(out.nodes.map((n) => n.name), ['Thermostat', 'GeekCave_Lights', 'Zwift Fan'], 'manifest covers placed nodes and exceptions')
    assert.deepEqual(out.map.nodes, { start: 'include', exceptions: ['n3'] }, 'exceptions by ref')
    assert.deepEqual(out.map.imageRect, { x: 0, y: 0, w: 3000, h: 5100 })
    assert.ok(out.map.image.data && out.map.imageDark.data)
    assert.ok(!JSON.stringify(out.placements).includes('zwave:'), 'positions refer to refs, not node IDs')
    await assert.rejects(buildExport({ layout: await src.load(), mapId: 'graph', nodes: [], imagesDir: src.imagesDir }), { status: 409 })

    const parsed = parseImport(Buffer.from(JSON.stringify(out)))
    const dst = await fresh()
    await dst.addMap({ name: 'House' })
    const ref = (name) => out.nodes.find((n) => n.name === name).ref
    const res = await dst.importMap(parsed, { [ref('Thermostat')]: 'zwave:aaaa:27', [ref('GeekCave_Lights')]: null, [ref('Zwift Fan')]: 'zwave:aaaa:61' })
    assert.equal(res.map.name, 'House (imported)')
    assert.deepEqual([res.linked, res.placeholders], [1, 1])
    assert.deepEqual([res.map.widthPx, res.map.heightPx], [3000, 5100])
    assert.deepEqual(res.map.nodes, { start: 'include', exceptions: ['zwave:aaaa:61'] }, 'node list remapped')
    assert.deepEqual(res.map.view.center, [5, 6])
    const l = await dst.load()
    const bg = l.backgrounds.find((x) => x.id === res.map.background.id)
    assert.ok(existsSync(dst.imagePath(bg)) && existsSync(dst.imagePath(bg, 'dark')))
    const pls = l.maps.find((m) => m.id === res.map.id).placements
    assert.deepEqual(pls.find((p) => p.deviceKey), { deviceKey: 'zwave:aaaa:27', x: 100, y: 200 })
    const ph = pls.find((p) => p.placeholder)
    assert.equal(ph.placeholder.name, 'GeekCave_Lights')
    assert.deepEqual([ph.x, ph.y], [300, 400])

    const again = await dst.importMap(parsed, Object.fromEntries(out.nodes.map((n) => [n.ref, null])))
    assert.equal(again.map.name, 'House (imported 2)', 'never overwrites')
    await assert.rejects(dst.importMap(parsed, { [ref('Thermostat')]: 'zwave:aaaa:27' }), { status: 400 }, 'every entry needs a decision')
    await assert.rejects(dst.importMap(parsed, Object.fromEntries(out.nodes.map((n) => [n.ref, 'zwave:aaaa:27']))), { status: 400 }, 'one device per entry')
})

test('bad files are refused with a clear reason', () => {
    const ok = { format: FORMAT, version: 2, map: { name: 'M', widthPx: 10, heightPx: 10 }, nodes: [], placements: [] }
    const bad = (obj, status = 400) => assert.throws(() => parseImport(Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))), { status })
    assert.equal(parseImport(Buffer.from(JSON.stringify(ok))).map.name, 'M')
    bad('not json')
    bad({ ...ok, format: 'other' })
    bad({ ...ok, version: 1 })
    bad({ ...ok, version: 3 })
    bad({ ...ok, map: { ...ok.map, widthPx: 0 } })
    bad({ ...ok, map: { ...ok.map, image: { data: Buffer.from('<svg/>').toString('base64') } } }, 415)
    bad({ ...ok, nodes: [{ ref: 'a' }, { ref: 'a' }] })
    bad({ ...ok, placements: [{ ref: 'nope', x: 1, y: 1 }] })
    bad({ ...ok, nodes: [{ ref: 'a' }], placements: [{ ref: 'a', x: 'one', y: 1 }] })
})

// SN: 00001
