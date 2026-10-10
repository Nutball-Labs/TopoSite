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

test('export → import round trip: images, positions, identities; placeholders for unmatched', async () => {
    const src = await fresh()
    const plan = await src.addBlankPlan({ name: 'House', widthPx: 3000, heightPx: 5100 })
    await src.setPlacement({ deviceKey: 'zwave:cdfbb3c7:14', planId: plan.id, x: 100, y: 200, seen: { name: 'Thermostat', deviceId: '57-1-17479' } })
    await src.setPlacement({ deviceKey: 'zwave:cdfbb3c7:2', planId: plan.id, x: 300, y: 400 })
    await src.setImage(plan.id, { bytes: PNG, imgWidthPx: 3000, imgHeightPx: 5100 })
    await src.setImage(plan.id, { bytes: PNG, imgWidthPx: 3000, imgHeightPx: 5100, variant: 'dark' })

    const out = await buildExport({ layout: await src.load(), planId: plan.id, nodes: LOCAL, imagesDir: src.imagesDir, homeId: 'cdfbb3c7', version: '0.1.0' })
    assert.equal(out.format, FORMAT)
    assert.equal(out.nodes.length, 2)
    assert.equal(out.nodes[0].name, 'Thermostat')
    assert.equal(out.nodes[0].deviceId, '57-1-17479')
    assert.ok(out.map.image.data && out.map.imageDark.data)
    assert.ok(!JSON.stringify(out.placements).includes('zwave:'), 'positions refer to refs, not node IDs')

    const parsed = parseImport(Buffer.from(JSON.stringify(out)))
    assert.equal(parsed.images.image.ext, 'png')

    // import elsewhere: thermostat matched, lights left as a placeholder
    const dst = await fresh()
    await dst.addBlankPlan({ name: 'House', widthPx: 10, heightPx: 10 })
    const thermoRef = out.nodes.find((n) => n.name === 'Thermostat').ref
    const lightsRef = out.nodes.find((n) => n.name === 'GeekCave_Lights').ref
    const res = await dst.importMap(parsed, { [thermoRef]: 'zwave:aaaa:27', [lightsRef]: null })
    assert.equal(res.plan.name, 'House (imported)')
    assert.deepEqual([res.linked, res.placeholders], [1, 1])
    assert.deepEqual([res.plan.widthPx, res.plan.heightPx], [3000, 5100])
    assert.ok(existsSync(dst.imagePath(res.plan)) && existsSync(dst.imagePath(res.plan, 'dark')))
    const pls = (await dst.load()).placements.filter((p) => p.planId === res.plan.id)
    assert.deepEqual(pls.find((p) => p.deviceKey).deviceKey, 'zwave:aaaa:27')
    assert.deepEqual([pls.find((p) => p.deviceKey).x, pls.find((p) => p.deviceKey).y], [100, 200])
    const ph = pls.find((p) => p.placeholder)
    assert.equal(ph.placeholder.name, 'GeekCave_Lights')
    assert.deepEqual([ph.x, ph.y], [300, 400])
    assert.match(ph.id, /^ph-/)

    const again = await dst.importMap(parsed, { [thermoRef]: null, [lightsRef]: null })
    assert.equal(again.plan.name, 'House (imported 2)', 'never overwrites')
    await assert.rejects(dst.importMap(parsed, { [thermoRef]: 'zwave:aaaa:27' }), { status: 400 }, 'every entry needs a decision')
    await assert.rejects(dst.importMap(parsed, { [thermoRef]: 'zwave:aaaa:27', [lightsRef]: 'zwave:aaaa:27' }), { status: 400 }, 'one device per entry')
})

test('bad files are refused with a clear reason', () => {
    const ok = { format: FORMAT, version: 1, map: { name: 'M', widthPx: 10, heightPx: 10 }, nodes: [], placements: [] }
    const bad = (obj, status = 400) => assert.throws(() => parseImport(Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))), { status })
    assert.equal(parseImport(Buffer.from(JSON.stringify(ok))).map.name, 'M')
    bad('not json')
    bad({ ...ok, format: 'other' })
    bad({ ...ok, version: 2 })
    bad({ ...ok, map: { ...ok.map, widthPx: 0 } })
    bad({ ...ok, map: { ...ok.map, image: { data: Buffer.from('<svg/>').toString('base64') } } }, 415)
    bad({ ...ok, nodes: [{ ref: 'a' }, { ref: 'a' }] })
    bad({ ...ok, placements: [{ ref: 'nope', x: 1, y: 1 }] })
    bad({ ...ok, nodes: [{ ref: 'a' }], placements: [{ ref: 'a', x: 'one', y: 1 }] })
})

// SN: 00001
