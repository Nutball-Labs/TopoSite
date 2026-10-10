// layout.test.js — Maps, backgrounds and positions (run: npm test)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Layout, sniffImage, imageSize, cleanSeen, GRAPH_ID } from '../lib/layout.js'
import { resolveStoreDir } from '../lib/store.js'

// a real 1×1 PNG (header readable) and a header-only PNG (size unknown)
const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

const fresh = async () => new Layout(await mkdtemp(path.join(tmpdir(), 'toposite-layout-')))
const K = (n) => `zwave:cdfbb3c7:${n}`
const images = (layout) => (existsSync(layout.imagesDir) ? readdirSync(layout.imagesDir).sort() : [])

test('only PNG, JPEG and WebP are recognized — never SVG; sizes are read from the header', () => {
    assert.equal(sniffImage(PNG).ext, 'png')
    assert.equal(sniffImage(JPEG).ext, 'jpg')
    assert.equal(sniffImage(WEBP).ext, 'webp')
    assert.equal(sniffImage(SVG), null)
    assert.deepEqual(imageSize(PNG1), { w: 1, h: 1 })
    assert.equal(imageSize(PNG), null, 'header too short')
    // minimal JPEG: SOI, SOF0 with 40×30
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x1e, 0x00, 0x28, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    assert.deepEqual(imageSize(jpg), { w: 40, h: 30 })
})

test('an empty store has the built-in Network Graph map as the default', async () => {
    const layout = await fresh()
    const l = await layout.load()
    assert.equal(l.version, 2)
    assert.deepEqual(l.maps.map((m) => [m.id, m.layout, m.builtin]), [[GRAPH_ID, 'graph', true]])
    assert.equal(l.settings.defaultMapId, GRAPH_ID)
    assert.deepEqual(l.backgrounds, [])
})

test('a layout.json that isn\'t version 2 is refused, not overwritten', async () => {
    const layout = await fresh()
    await mkdir(layout.dir, { recursive: true })
    const v1 = JSON.stringify({ version: 1, plans: [], placements: [] })
    await writeFile(layout.file, v1)
    await assert.rejects(layout.load(), { status: 500 })
    await assert.rejects(layout.addMap({ name: 'X' }), { status: 500 })
    assert.equal(await readFile(layout.file, 'utf8'), v1)
})

test('maps: create, rename, node list, view, pad and delete; the built-in map is protected', async () => {
    const layout = await fresh()
    const m = await layout.addMap({ name: 'Workshop' })
    assert.deepEqual([m.layout, m.widthPx, m.heightPx, m.background], ['placed', 3000, 2000, null])
    await layout.setPlacement(m.id, { deviceKey: K(58), x: 100, y: 200 })

    const r = await layout.updateMap(m.id, { name: 'Workshop sketch', nodes: { start: 'exclude', exceptions: [K(58), K(58)] },
        view: { center: [1, 2], zoom: -1, layers: { neighbors: false, bogus: true } } })
    assert.equal(r.name, 'Workshop sketch')
    assert.deepEqual(r.nodes, { start: 'exclude', exceptions: [K(58)] }, 'exceptions de-duplicated')
    assert.deepEqual(r.view, { center: [1, 2], zoom: -1, layers: { routes: true, backupRoutes: false, neighbors: false, nodes: true, health: true, battery: false, names: true } })
    await assert.rejects(layout.updateMap(m.id, { nodes: { start: 'some' } }), { status: 400 })

    const padded = await layout.updateMap(m.id, { padTop: 100, expectHeightPx: 2000 })
    assert.equal(padded.heightPx, 2100)
    assert.deepEqual([padded.placements[0].x, padded.placements[0].y], [100, 300])
    await assert.rejects(layout.updateMap(m.id, { padTop: 100, expectHeightPx: 2000 }), { status: 409 }, 'a retried pad is refused')

    await assert.rejects(layout.updateMap(GRAPH_ID, { name: 'x' }), { status: 409 })
    await assert.rejects(layout.updateMap(GRAPH_ID, { padTop: 5 }), { status: 409 }, 'graph map has no canvas')
    assert.deepEqual((await layout.updateMap(GRAPH_ID, { nodes: { start: 'exclude', exceptions: [] } })).nodes.start, 'exclude', 'but its node list saves')
    await assert.rejects(layout.deleteMap(GRAPH_ID), { status: 409 })
    await assert.rejects(layout.setPlacement(GRAPH_ID, { deviceKey: K(1), x: 1, y: 1 }), { status: 409 })

    await layout.updateSettings({ defaultMapId: m.id })
    await assert.rejects(layout.updateSettings({ defaultMapId: 'nope' }), { status: 404 })
    await layout.deleteMap(m.id)
    const l = await layout.load()
    assert.ok(!l.maps.some((x) => x.id === m.id))
    assert.equal(l.settings.defaultMapId, GRAPH_ID, 'deleting the default falls back to the Network Graph')
})

test('positions are per map: placing or unplacing on one map leaves the others alone', async () => {
    const layout = await fresh()
    const a = await layout.addMap({ name: 'House', widthPx: 1000, heightPx: 1000 })
    const b = await layout.addMap({ name: 'Shop', widthPx: 1000, heightPx: 1000 })
    await layout.setPlacement(a.id, { deviceKey: K(2), x: 10, y: 10 })
    const moved = await layout.setPlacement(a.id, { deviceKey: K(2), x: 5000, y: -5, seen: { name: 'Lights', deviceId: '29-1-2', evil: 'x' } })
    assert.deepEqual(moved, { deviceKey: K(2), x: 1000, y: 0, seen: { name: 'Lights', deviceId: '29-1-2' } }, 'clamped, one per device per map')
    await layout.setPlacement(b.id, { deviceKey: K(2), x: 90, y: 90 })
    await layout.removePlacement(b.id, K(2))
    const l = await layout.load()
    assert.equal(l.maps.find((m) => m.id === a.id).placements.length, 1)
    assert.equal(l.maps.find((m) => m.id === b.id).placements.length, 0)
    await assert.rejects(layout.setPlacement(a.id, { deviceKey: '../etc', x: 1, y: 1 }), { status: 400 })
    await assert.rejects(layout.setPlacement('nope', { deviceKey: K(2), x: 1, y: 1 }), { status: 404 })
    assert.deepEqual(cleanSeen({ name: 5, dsk: 'abc' }), { dsk: 'abc' })
})

test('backgrounds: first image sizes an empty map; replace keeps framing; shared backgrounds fork; unset cleans up', async () => {
    const layout = await fresh()
    const a = await layout.addMap({ name: 'House' })
    const set = await layout.setMapImage(a.id, { bytes: PNG1 })
    assert.deepEqual([set.map.widthPx, set.map.heightPx], [1, 1], 'canvas takes the image size (nothing placed yet)')
    assert.deepEqual(set.map.background.imageRect, { x: 0, y: 0, w: 1, h: 1 })
    assert.equal(set.stretched, false)
    const bgId = set.background.id

    await layout.updateMap(a.id, { widthPx: 3000, heightPx: 5100 })
    await layout.setPlacement(a.id, { deviceKey: K(2), x: 2000, y: 3000 })
    const dark = await layout.setMapImage(a.id, { bytes: PNG, imgWidthPx: 1, imgHeightPx: 1, variant: 'dark' })
    assert.equal(dark.background.id, bgId, 'unshared background is updated in place')
    assert.ok(dark.background.imageDark)
    const replaced = await layout.setMapImage(a.id, { bytes: PNG1 })
    assert.notEqual(replaced.background.image, set.background.image)
    assert.ok(!existsSync(path.join(layout.imagesDir, set.background.image)), 'old file removed')
    assert.deepEqual(replaced.map.background.imageRect, { x: 0, y: 0, w: 1, h: 1 }, 'framing kept')

    // a second map sharing the same background (as step 5's library will allow)
    const b = await layout.addMap({ name: 'House (battery)' })
    const raw = await layout.load()
    raw.maps.find((m) => m.id === b.id).background = { id: bgId, imageRect: { x: 0, y: 0, w: 1, h: 1 } }
    await writeFile(layout.file, JSON.stringify(raw))
    const forked = await layout.setMapImage(b.id, { bytes: PNG1 })
    assert.notEqual(forked.background.id, bgId, 'shared background forked for the changed map')
    const l = await layout.load()
    assert.equal(l.maps.find((m) => m.id === a.id).background.id, bgId, 'the other map keeps its background')
    const forkBg = l.backgrounds.find((x) => x.id === forked.background.id)
    assert.ok(forkBg.imageDark && forkBg.imageDark !== l.backgrounds.find((x) => x.id === bgId).imageDark, 'dark image copied, never shared')

    await layout.removeMapImage(a.id, 'dark')
    assert.equal((await layout.load()).backgrounds.find((x) => x.id === bgId).imageDark, undefined)
    const before = images(layout).length
    await layout.removeMapImage(a.id)
    const after = await layout.load()
    assert.equal(after.maps.find((m) => m.id === a.id).background, null)
    assert.equal(after.maps.find((m) => m.id === a.id).placements.length, 1, 'placements survive unsetting the background')
    assert.ok(!after.backgrounds.some((x) => x.id === bgId), 'unused background removed')
    assert.ok(images(layout).length < before, 'with its files')

    await assert.rejects(layout.setMapImage(a.id, { bytes: SVG, imgWidthPx: 1, imgHeightPx: 1 }), { status: 415 })
    await assert.rejects(layout.setMapImage(a.id, { bytes: PNG }), { status: 400 }, 'size unknown and not supplied')
    await assert.rejects(layout.setMapImage(GRAPH_ID, { bytes: PNG1 }), { status: 409 })
    await layout.deleteMap(b.id)
    assert.deepEqual((await layout.load()).backgrounds, [], 'deleting the last map using a background removes it')
})

test('new map on a library background: framing from a map already using it; copy positions only on the same background', async () => {
    const layout = await fresh()
    const house = await layout.addMap({ name: 'House', widthPx: 3000, heightPx: 5100 })
    await layout.setPlacement(house.id, { deviceKey: K(2), x: 100, y: 200, seen: { name: 'Lights' } })
    await layout.setMapImage(house.id, { bytes: PNG1 })   // something placed → canvas keeps its size
    await layout.updateMap(house.id, { metersPerPixel: 0.006 })
    const bgId = (await layout.load()).maps.find((m) => m.id === house.id).background.id

    const battery = await layout.addMap({ name: 'Battery', backgroundId: bgId, nodes: { start: 'exclude', exceptions: [K(5)] } })
    assert.deepEqual([battery.widthPx, battery.heightPx, battery.metersPerPixel], [3000, 5100, 0.006], 'canvas from House')
    assert.equal(battery.background.id, bgId, 'shares the library background')
    assert.deepEqual(battery.placements, [], 'no positions unless asked')
    assert.deepEqual(battery.nodes, { start: 'exclude', exceptions: [K(5)] })

    const copy = await layout.addMap({ name: 'Copy', backgroundId: bgId, copyPositionsFrom: house.id })
    assert.deepEqual(copy.placements, [{ deviceKey: K(2), x: 100, y: 200, seen: { name: 'Lights' } }])
    await layout.setPlacement(copy.id, { deviceKey: K(2), x: 5, y: 5 })
    const l = await layout.load()
    assert.equal(l.maps.find((m) => m.id === house.id).placements[0].x, 100, 'copies are independent')
    assert.equal(l.backgrounds.length, 1)

    await assert.rejects(layout.addMap({ name: 'X', copyPositionsFrom: house.id }), { status: 409 }, 'different background')
    await assert.rejects(layout.addMap({ name: 'X', backgroundId: 'nope' }), { status: 404 })
    await assert.rejects(layout.addMap({ name: 'X', copyPositionsFrom: 'graph' }), { status: 409 })
    const blank = await layout.addMap({ name: 'Blank', widthPx: 800, heightPx: 600 })
    await layout.setPlacement(blank.id, { deviceKey: K(3), x: 1, y: 2 })
    const blank2 = await layout.addMap({ name: 'Blank 2', copyPositionsFrom: blank.id })
    assert.deepEqual([blank2.widthPx, blank2.heightPx, blank2.background, blank2.placements.length], [800, 600, null, 1])
})

test('placeholders can be linked to a device (taking its spot) or deleted', async () => {
    const layout = await fresh()
    const m = await layout.addMap({ name: 'House', widthPx: 1000, heightPx: 1000 })
    await layout.setPlacement(m.id, { deviceKey: K(2), x: 1, y: 2 })
    const raw = await layout.load()
    raw.maps.find((x) => x.id === m.id).placements.push(
        { id: 'ph1', deviceKey: null, x: 300, y: 400, placeholder: { name: 'Thermostat' } },
        { id: 'ph2', deviceKey: null, x: 5, y: 5, placeholder: { name: 'Gone' } })
    await writeFile(layout.file, JSON.stringify(raw))

    const linked = await layout.linkPlaceholder(m.id, 'ph1', K(2), { name: 'Lights' })
    assert.deepEqual(linked, { deviceKey: K(2), x: 300, y: 400, seen: { name: 'Lights' } })
    let pls = (await layout.load()).maps.find((x) => x.id === m.id).placements
    assert.equal(pls.filter((p) => p.deviceKey === K(2)).length, 1, "the device's old spot is replaced")
    await assert.rejects(layout.linkPlaceholder(m.id, 'ph1', K(2)), { status: 404 }, 'already linked')
    await layout.removePlaceholder(m.id, 'ph2')
    pls = (await layout.load()).maps.find((x) => x.id === m.id).placements
    assert.equal(pls.length, 1)
    await assert.rejects(layout.removePlaceholder(m.id, 'ph2'), { status: 404 })
})

test('concurrent placements are all kept', async () => {
    const layout = await fresh()
    const m = await layout.addMap({ name: 'p', widthPx: 100, heightPx: 100 })
    await Promise.all([2, 3, 4, 5, 6].map((id) => layout.setPlacement(m.id, { deviceKey: K(id), x: id, y: id })))
    assert.equal((await layout.load()).maps.find((x) => x.id === m.id).placements.length, 5)
})

test('store dir: env overrides, then <cwd>/store, then two levels above the plugin', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'toposite-store-'))
    const store = path.join(root, 'store')
    await mkdir(path.join(store, 'plugins', 'toposite'), { recursive: true })
    await writeFile(path.join(store, 'settings.json'), '{}')
    const plugin = path.join(store, 'plugins', 'toposite')
    assert.equal(resolveStoreDir({}, root, '/nowhere'), store, '<cwd>/store (Docker: /usr/src/app/store)')
    assert.equal(resolveStoreDir({}, '/nowhere', plugin), store, 'plugin installed in <store>/plugins/toposite')
    assert.equal(resolveStoreDir({ STORE_DIR: store }, '/nowhere', '/nowhere'), store)
    assert.equal(resolveStoreDir({ TOPOSITE_STORE_DIR: '/nowhere' }, root, '/nowhere'), store, 'a dir without settings.json is skipped')
    assert.equal(resolveStoreDir({}, '/nowhere', '/nowhere'), null)
})

// SN: 00002
