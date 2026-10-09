// layout.test.js — Plans, placements and image checks (run: npm test)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Layout, sniffImage, cleanShape, imageRectOf } from '../lib/layout.js'
import { resolveStoreDir } from '../lib/store.js'
import { mkdir, writeFile } from 'node:fs/promises'

export const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

const fresh = async () => new Layout(await mkdtemp(path.join(tmpdir(), 'toposite-layout-')))

test('only PNG, JPEG and WebP are recognized — never SVG', () => {
    assert.equal(sniffImage(PNG).ext, 'png')
    assert.equal(sniffImage(JPEG).ext, 'jpg')
    assert.equal(sniffImage(WEBP).ext, 'webp')
    assert.equal(sniffImage(SVG), null)
    assert.equal(sniffImage(Buffer.alloc(0)), null)
})

test('empty store loads an empty layout', async () => {
    const layout = await fresh()
    assert.deepEqual(await layout.load(), { version: 1, plans: [], placements: [], shapes: [] })
})

test('adding a plan writes the image and layout.json', async () => {
    const layout = await fresh()
    const plan = await layout.addPlan({ name: 'Google Earth', widthPx: 1920, heightPx: 1080, bytes: PNG })
    assert.match(plan.id, /^[0-9a-f]{8}$/)
    assert.equal(plan.image, `${plan.id}.png`)
    assert.ok(existsSync(layout.imagePath(plan)))
    const saved = JSON.parse(await readFile(layout.file, 'utf8'))
    assert.deepEqual(saved.plans, [plan])
})

test('bad uploads are refused with the right status', async () => {
    const layout = await fresh()
    await assert.rejects(layout.addPlan({ name: 'x', widthPx: 10, heightPx: 10, bytes: SVG }), { status: 415 })
    await assert.rejects(layout.addPlan({ name: 'x', widthPx: 0, heightPx: 10, bytes: PNG }), { status: 400 })
    await assert.rejects(layout.addPlan({ name: 'x', widthPx: 1.5, heightPx: 10, bytes: PNG }), { status: 400 })
    await assert.rejects(layout.addPlan({ name: 'x', widthPx: NaN, heightPx: 10, bytes: PNG }), { status: 400 })
})

test('placements: one per device, clamped to the plan, removed with their plan', async () => {
    const layout = await fresh()
    const plan = await layout.addPlan({ name: 'p', widthPx: 100, heightPx: 50, bytes: PNG })
    await layout.setPlacement({ deviceKey: 'zwave:cdfbb3c7:2', planId: plan.id, x: 10, y: 20 })
    await layout.setPlacement({ deviceKey: 'zwave:cdfbb3c7:2', planId: plan.id, x: 500, y: -5 })
    let saved = await layout.load()
    assert.deepEqual(saved.placements, [{ deviceKey: 'zwave:cdfbb3c7:2', planId: plan.id, x: 100, y: 0 }])

    await assert.rejects(layout.setPlacement({ deviceKey: 'zwave:cdfbb3c7:3', planId: 'nope', x: 1, y: 1 }), { status: 404 })
    await assert.rejects(layout.setPlacement({ deviceKey: '../etc', planId: plan.id, x: 1, y: 1 }), { status: 400 })
    await assert.rejects(layout.setPlacement({ deviceKey: 'zwave:cdfbb3c7:3', planId: plan.id, x: '1', y: 1 }), { status: 400 })

    await layout.removePlacement('zwave:cdfbb3c7:2')
    assert.deepEqual((await layout.load()).placements, [])

    await layout.setPlacement({ deviceKey: 'zwave:cdfbb3c7:4', planId: plan.id, x: 1, y: 1 })
    await layout.deletePlan(plan.id)
    saved = await layout.load()
    assert.deepEqual(saved, { version: 1, plans: [], placements: [], shapes: [] })
    assert.ok(!existsSync(layout.imagePath(plan)))
})

test('concurrent placements are all kept', async () => {
    const layout = await fresh()
    const plan = await layout.addPlan({ name: 'p', widthPx: 100, heightPx: 100, bytes: PNG })
    await Promise.all([2, 3, 4, 5, 6].map((id) =>
        layout.setPlacement({ deviceKey: `zwave:cdfbb3c7:${id}`, planId: plan.id, x: id, y: id })))
    assert.equal((await layout.load()).placements.length, 5)
})

test('shapes: rect, circle, line and label are validated and trimmed to known fields', () => {
    assert.deepEqual(cleanShape({ id: 'a1', type: 'rect', x: 1.234, y: 2, w: -30, h: 40, evil: '<script>' }, 0, 'p'),
        { id: 'a1', planId: 'p', type: 'rect', x: 1.2, y: 2, w: 30, h: 40 })
    assert.deepEqual(cleanShape({ id: 'c', type: 'circle', x: 5, y: 5, r: 10 }, 0, 'p'),
        { id: 'c', planId: 'p', type: 'circle', x: 5, y: 5, r: 10 })
    assert.deepEqual(cleanShape({ id: 'l', type: 'line', points: [[0, 0], [10, 0], [10, 10]] }, 0, 'p').points, [[0, 0], [10, 0], [10, 10]])
    assert.equal(cleanShape({ id: 't', type: 'label', x: 1, y: 1, text: 'K'.repeat(500) }, 0, 'p').text.length, 200)
    assert.match(cleanShape({ id: '../x', type: 'circle', x: 1, y: 1, r: 1 }, 0, 'p').id, /^[0-9a-f]{8}$/, 'odd ids replaced')
    for (const bad of [
        null,
        { type: 'polygon' },
        { type: 'rect', x: '1', y: 1, w: 1, h: 1 },
        { type: 'circle', x: 1, y: 1, r: Infinity },
        { type: 'line', points: [[0, 0]] },
        { type: 'line', points: [[0, 0], [1]] },
        { type: 'label', x: 1, y: 1, text: 42 },
    ]) {
        assert.throws(() => cleanShape(bad, 3, 'p'), { status: 400 }, JSON.stringify(bad))
    }
})

test('blank plans hold shapes; saving replaces only that plan\'s shapes; deleting removes them', async () => {
    const layout = await fresh()
    const a = await layout.addBlankPlan({ name: 'House', widthPx: 3000, heightPx: 2000 })
    const b = await layout.addBlankPlan({ name: 'Shop', widthPx: 1000, heightPx: 1000 })
    assert.equal(a.image, null)
    await layout.setShapes(a.id, [{ type: 'rect', x: 0, y: 0, w: 10, h: 10 }, { type: 'label', x: 5, y: 5, text: 'Kitchen' }])
    await layout.setShapes(b.id, [{ type: 'circle', x: 1, y: 1, r: 1 }])
    await layout.setShapes(a.id, [{ type: 'line', points: [[0, 0], [5, 5]] }])
    let saved = await layout.load()
    assert.deepEqual(saved.shapes.map((sh) => [sh.planId, sh.type]).sort(), [[a.id, 'line'], [b.id, 'circle']].sort())

    await assert.rejects(layout.setShapes(a.id, [{ type: 'bogus' }]), { status: 400 })
    assert.equal((await layout.load()).shapes.length, 2, 'a rejected save changes nothing')
    await assert.rejects(layout.setShapes('nope', []), { status: 404 })
    await assert.rejects(layout.addBlankPlan({ name: 'x', widthPx: 0, heightPx: 1 }), { status: 400 })

    await layout.deletePlan(a.id)
    saved = await layout.load()
    assert.deepEqual(saved.shapes.map((sh) => sh.planId), [b.id])
})

test('updatePlan renames, resizes blank plans and sets scale; image plans keep their size', async () => {
    const layout = await fresh()
    const blank = await layout.addBlankPlan({ name: 'House', widthPx: 3000, heightPx: 2000 })
    await layout.setPlacement({ deviceKey: 'zwave:cdfbb3c7:2', planId: blank.id, x: 500, y: 1900 })
    const grown = await layout.updatePlan(blank.id, { heightPx: 3000, metersPerPixel: 0.3048 / 50, name: 'House + garage' })
    assert.equal(grown.heightPx, 3000)
    assert.equal(grown.widthPx, 3000)
    assert.equal(grown.metersPerPixel, 0.3048 / 50)
    assert.equal(grown.name, 'House + garage')
    assert.deepEqual((await layout.load()).placements[0], { deviceKey: 'zwave:cdfbb3c7:2', planId: blank.id, x: 500, y: 1900 },
        'growing a plan leaves positions alone')

    const img = await layout.addPlan({ name: 'img', widthPx: 10, heightPx: 10, bytes: PNG })
    const grownImg = await layout.updatePlan(img.id, { heightPx: 20 })
    assert.equal(grownImg.heightPx, 20, 'image plans can grow')
    assert.deepEqual(grownImg.imageRect, { x: 0, y: 0, w: 10, h: 10 }, 'and the image keeps its size')
    assert.equal((await layout.updatePlan(img.id, { metersPerPixel: 0.01 })).metersPerPixel, 0.01, 'scale is fine on image plans')
    await assert.rejects(layout.updatePlan(blank.id, { widthPx: 0 }), { status: 400 })
    await assert.rejects(layout.updatePlan(blank.id, { metersPerPixel: -1 }), { status: 400 })
    await assert.rejects(layout.updatePlan('nope', { name: 'x' }), { status: 404 })
})

test('padTop/padLeft add room and move placements and shapes with the drawing; expect* guards retries', async () => {
    const layout = await fresh()
    const plan = await layout.addBlankPlan({ name: 'House', widthPx: 3000, heightPx: 3000 })
    await layout.setPlacement({ deviceKey: 'zwave:cdfbb3c7:2', planId: plan.id, x: 500, y: 600 })
    await layout.setShapes(plan.id, [
        { type: 'rect', x: 262, y: 354, w: 2475, h: 1292 },
        { type: 'line', points: [[0, 0], [10, 20]] },
        { type: 'label', x: 5, y: 6, text: 'BR 1' },
    ])
    const padded = await layout.updatePlan(plan.id, { padTop: 2100, expectHeightPx: 3000 })
    assert.equal(padded.heightPx, 5100)
    assert.equal(padded.widthPx, 3000)
    const saved = await layout.load()
    assert.deepEqual([saved.placements[0].x, saved.placements[0].y], [500, 2700])
    assert.deepEqual(saved.shapes.map((sh) => sh.points ?? [sh.x, sh.y]), [[262, 2454], [[0, 2100], [10, 2120]], [5, 2106]])
    await assert.rejects(layout.updatePlan(plan.id, { padTop: 2100, expectHeightPx: 3000 }), { status: 409 }, 'a retry is refused')
    assert.equal((await layout.load()).plans[0].heightPx, 5100, 'and changes nothing')
    await assert.rejects(layout.updatePlan(plan.id, { padTop: -1 }), { status: 400 })
})

test('a background can be set on, replaced in and removed from an existing plan — placements and shapes stay', async () => {
    const layout = await fresh()
    const plan = await layout.addBlankPlan({ name: 'House', widthPx: 3000, heightPx: 5100 })
    await layout.setPlacement({ deviceKey: 'zwave:cdfbb3c7:2', planId: plan.id, x: 500, y: 3000 })
    await layout.setShapes(plan.id, [{ type: 'rect', x: 262, y: 2454, w: 2475, h: 1292 }])

    const set = await layout.setImage(plan.id, { bytes: PNG, imgWidthPx: 1500, imgHeightPx: 2550 })
    assert.match(set.image, new RegExp(`^${plan.id}-[0-9a-f]{6}\\.png$`))
    assert.deepEqual(set.imageRect, { x: 0, y: 0, w: 3000, h: 5100 }, 'a new background covers the plan')
    assert.equal(set.stretched, false, '1500x2550 has the same aspect as 3000x5100')
    assert.ok(existsSync(layout.imagePath(set)))

    const pad = await layout.updatePlan(plan.id, { padTop: 100 })
    assert.deepEqual(pad.imageRect, { x: 0, y: 100, w: 3000, h: 5100 }, 'padding moves the background with the drawing')

    const replaced = await layout.setImage(plan.id, { bytes: JPEG, imgWidthPx: 400, imgHeightPx: 400 })
    assert.notEqual(replaced.image, set.image)
    assert.ok(!existsSync(layout.imagePath(set)), 'old image file deleted')
    assert.deepEqual(replaced.imageRect, { x: 0, y: 100, w: 3000, h: 5100 }, 'a replacement takes the old one\'s place')
    assert.equal(replaced.stretched, true)

    const saved = await layout.load()
    assert.deepEqual([saved.placements[0].x, saved.placements[0].y], [500, 3100])
    assert.equal(saved.shapes.length, 1)

    const removed = await layout.removeImage(plan.id)
    assert.equal(removed.image, null)
    assert.equal(removed.imageRect, undefined)
    assert.ok(!existsSync(layout.imagePath(replaced)))
    assert.equal((await layout.load()).placements.length, 1, 'placements survive removing the background')

    await assert.rejects(layout.setImage(plan.id, { bytes: Buffer.from('<svg/>'), imgWidthPx: 1, imgHeightPx: 1 }), { status: 415 })
    await assert.rejects(layout.setImage('nope', { bytes: PNG, imgWidthPx: 1, imgHeightPx: 1 }), { status: 404 })
    assert.deepEqual(imageRectOf({ widthPx: 7, heightPx: 9 }), { x: 0, y: 0, w: 7, h: 9 }, 'legacy plans: whole plan')
})

test("store dir: env overrides, then <cwd>/store, then two levels above the plugin", async () => {
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

// SN: 00001
