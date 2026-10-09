// app.js — TopoSite map page (Leaflet, simple/pixel CRS).
//
// Reads /toposite/api/nodes and /toposite/api/layout, shows the selected plan
// image (or a placeholder grid), and draws nodes, routes and neighbor links in
// Z-Wave JS UI's visual language. With a plan shown, nodes can be dragged into
// place; positions are saved server-side in plan pixels. Unplaced nodes use a
// temporary auto-layout and are drawn faded.
//
// Drawing (Leaflet-Geoman, opt-in mode so it never touches nodes or links):
// rectangles, circles, lines and text labels on any plan — a blank "drawing"
// plan or over an image. The whole drawing is saved after each change.
//
// Every /toposite/api call sends Z-Wave JS UI's login token (if any); TopoSite
// accepts exactly the logins Z-Wave JS UI accepts (lib/auth.js).
//
// "Refresh neighbors" calls Z-Wave JS UI's own socket.io API (refreshNeighbors),
// which Z-Wave JS UI authenticates, rate-limits (once per 60 s) and runs with
// the radio briefly paused.

import {
    autoLayout, buildLinks, nodeColor, nodeLabel, mainRoute, rateColor, rateLabel,
    rssiLabel, HOP_LEGEND, RATE_LEGEND,
} from './mesh-view.js'

/* global L, io */

const GRID_SIZE = 1000
const POLL_MS = 30_000
const REFRESH_COOLDOWN_MS = 60_000
const PLAN_KEY = 'toposite.plan'
const BLANK_SIZE = { widthPx: 3000, heightPx: 2000 }
const SAVE_DELAY_MS = 800
// Z-Wave JS UI's root, as the browser sees it (keeps working behind a path prefix)
const ZUI_BASE = location.pathname.replace(/toposite\/.*$/, '')
const LOGIN_LINK = `<a href="${ZUI_BASE}" target="_blank">log in to Z-Wave JS UI</a>`

const map = L.map('map', { crs: L.CRS.Simple, minZoom: -5, maxZoom: 3, zoomSnap: 0.25, attributionControl: false })

// Background images get their own pane under the overlay pane (z 400), so they
// always sit beneath route lines no matter when they're added; drawn shapes sit
// between the two.
map.createPane('ts-background').style.zIndex = 300
map.createPane('ts-drawing').style.zIndex = 350

// Geoman manages only layers created with pmIgnore: false (our drawn shapes)
L.PM.setOptIn(true)
const drawColor = () => getComputedStyle(document.documentElement).getPropertyValue('--draw').trim() || '#3a3a3a'
const shapeStyle = () => ({ color: drawColor(), weight: 3, fillOpacity: 0.04, pane: 'ts-drawing', pmIgnore: false })

const layers = {
    background: L.layerGroup().addTo(map),
    drawing: L.featureGroup().addTo(map),
    routes: L.layerGroup().addTo(map),
    nlwr: L.layerGroup(),
    neighbors: L.layerGroup().addTo(map),
    nodes: L.layerGroup().addTo(map),
}
L.control.layers(null, {
    'Routes (last working)': layers.routes,
    'Backup routes (next-to-last)': layers.nlwr,
    'Neighbors (when known)': layers.neighbors,
    'Nodes': layers.nodes,
    'Drawing': layers.drawing,
}, { collapsed: false, position: 'topright' }).addTo(map)

map.pm.setGlobalOptions({
    layerGroup: layers.drawing,
    pathOptions: shapeStyle(),
    textOptions: { className: 'ts-label', focusAfterDraw: true, removeIfEmpty: true },
    snappable: true,
    continueDrawing: false,
})
map.on('pm:create', (e) => {
    e.layer.options.pmIgnore = false
    L.PM.reInitLayer(e.layer)
    watchShape(e.layer)
    scheduleSave()
})
map.on('pm:remove', () => scheduleSave())

const state = {
    nodes: [],
    layout: { plans: [], placements: [] },
    planId: readPref(PLAN_KEY),
    shownPlanId: undefined, // plan the view was last fitted to
    imageUrls: new Map(), // planId → object URL of the fetched image
    labelZoom: 0,
    drawing: false, // draw mode on?
    drawnPlanId: undefined, // plan whose shapes are in layers.drawing
    drawnJSON: '', // those shapes as last loaded
    saveTimer: null,
}

const panel = addPanel()
addLegend()
map.on('zoomend', applyLabelZoom)

let lastNodesJSON = ''
let lastLayoutJSON = ''
reload()
setInterval(reload, POLL_MS)

// ---------------------------------------------------------------- API

/** fetch() a TopoSite API path with Z-Wave JS UI's login token. Returns `data`, throws on failure. */
async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...options.headers }
    const token = storedToken()
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(`api/${path}`, { cache: 'no-store', ...options, headers })
    if (options.raw) {
        if (!res.ok) throw await apiError(res)
        return res
    }
    const body = await res.json().catch(() => ({ success: false, message: `HTTP ${res.status}` }))
    if (!body.success) throw Object.assign(new Error(body.message || `HTTP ${res.status}`), { auth: res.status === 401 })
    return body.data
}

async function apiError(res) {
    const body = await res.json().catch(() => ({}))
    return Object.assign(new Error(body.message || `HTTP ${res.status}`), { auth: res.status === 401 })
}

function explain(error, what) {
    return error.auth
        ? `${what}: ${esc(error.message)} — ${LOGIN_LINK} in this browser, then reload.`
        : `${what}: ${esc(error.message)}`
}

async function reload() {
    try {
        const [nodes, layout] = await Promise.all([api('nodes'), api('layout')])
        const nodesJSON = JSON.stringify(nodes)
        const layoutJSON = JSON.stringify(layout)
        if (nodesJSON !== lastNodesJSON || layoutJSON !== lastLayoutJSON) {
            lastNodesJSON = nodesJSON
            lastLayoutJSON = layoutJSON
            state.nodes = nodes
            state.layout = layout
            await draw()
        }
        panel.setSummary(nodes)
        panel.setPlans(layout.plans, currentPlan()?.id)
    } catch (error) {
        panel.setStatus(explain(error, "Can't load the map"))
    }
}

function currentPlan() {
    const plans = state.layout.plans
    return plans.find((p) => p.id === state.planId) ?? plans[0] ?? null
}

// ---------------------------------------------------------------- drawing

async function draw() {
    const plan = currentPlan()
    const width = plan?.widthPx ?? GRID_SIZE
    const height = plan?.heightPx ?? GRID_SIZE
    const bounds = [[0, 0], [height, width]]

    // Background: plan image, or the placeholder grid
    layers.background.clearLayers()
    if (plan?.image) {
        const url = await planImageUrl(plan).catch((error) => {
            panel.setStatus(explain(error, `Can't load image for ${esc(plan.name)}`))
            return null
        })
        if (url) L.imageOverlay(url, bounds, { pane: 'ts-background' }).addTo(layers.background)
    } else {
        L.imageOverlay(gridImage(width, height), bounds, { opacity: 0.6, pane: 'ts-background' }).addTo(layers.background)
    }
    if (state.shownPlanId !== (plan?.id ?? null)) {
        state.shownPlanId = plan?.id ?? null
        map.fitBounds(bounds, { padding: [20, 20] })
        state.labelZoom = map.getZoom() + 0.75
        applyLabelZoom()
    }

    // Positions: saved placements on this plan, auto-layout for the rest
    const placed = new Map()
    for (const p of state.layout.placements) {
        if (plan && p.planId === plan.id) placed.set(p.deviceKey, [height - p.y, p.x])
    }
    const side = Math.min(width, height) * 0.9
    const auto = autoLayout(state.nodes, side)
    const pos = new Map()
    for (const n of state.nodes) {
        const saved = n.key && placed.get(n.key)
        if (saved) {
            pos.set(n.id, saved)
        } else {
            const [y, x] = auto.get(n.id) ?? [side / 2, side / 2]
            pos.set(n.id, [y + (height - side) / 2, x + (width - side) / 2])
        }
    }

    drawShapes(plan)
    drawLinks(pos)
    drawNodes(pos, plan, placed, height)
}

function drawLinks(pos) {
    for (const g of [layers.routes, layers.nlwr, layers.neighbors]) g.clearLayers()
    const byId = new Map(state.nodes.map((n) => [n.id, n]))
    const name = (id) => esc(byId.get(id)?.name ?? `NodeID ${id}`)

    for (const l of buildLinks(state.nodes)) {
        const a = pos.get(l.a)
        const b = pos.get(l.b)
        if (!a || !b) continue
        const tip = `${name(l.a)} ↔ ${name(l.b)}`
        if (l.kind === 'neighbor') {
            L.polyline([a, b], { color: '#888888', weight: 1, opacity: 0.45, interactive: false })
                .addTo(layers.neighbors)
        } else if (l.kind === 'failed') {
            L.polyline([a, b], { color: '#8b0000', weight: 1.5, dashArray: '2 4' })
                .bindTooltip(`${tip}<br>Failed ❌`, { sticky: true })
                .addTo(layers.routes)
        } else {
            const lwr = l.kind === 'lwr'
            const detail = [rssiLabel(l.rssi), rateLabel(l.rate)].filter(Boolean).join(' · ')
            L.polyline([a, b], {
                color: rateColor(l.rate),
                weight: lwr ? 4 : 1.5,
                dashArray: lwr ? null : '5 5',
                opacity: 0.85,
            })
                .bindTooltip(`${tip}<br>${detail}<br><span class="muted">route of ${l.routes.map(name).join(', ')}</span>`, { sticky: true })
                .addTo(lwr ? layers.routes : layers.nlwr)
        }
    }
}

function drawNodes(pos, plan, placed, height) {
    layers.nodes.clearLayers()
    for (const n of state.nodes) {
        const p = pos.get(n.id)
        if (!p) continue
        const isPlaced = !!(n.key && placed.has(n.key))
        const marker = L.marker(p, {
            icon: nodeIcon(n, isPlaced || !plan),
            keyboard: false,
            draggable: !!(plan && n.key),
        })
            .bindTooltip(nodeTooltip(n, plan, isPlaced), { direction: 'top', offset: [0, -14] })
            .addTo(layers.nodes)

        if (!plan || !n.key) continue
        marker.on('dragend', async () => {
            const { lat, lng } = marker.getLatLng()
            try {
                await api('placements', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ deviceKey: n.key, planId: plan.id, x: lng, y: height - lat }),
                })
                panel.setStatus(`Placed ${esc(n.name)}.`)
            } catch (error) {
                panel.setStatus(explain(error, `Couldn't save ${esc(n.name)}`))
            }
            reload()
        })
        if (isPlaced) {
            marker.on('contextmenu', async () => {
                try {
                    await api(`placements/${encodeURIComponent(n.key)}`, { method: 'DELETE' })
                    panel.setStatus(`${esc(n.name)} back to auto-layout.`)
                } catch (error) {
                    panel.setStatus(explain(error, `Couldn't unplace ${esc(n.name)}`))
                }
                reload()
            })
        }
    }
}

function nodeIcon(n, solid) {
    const color = nodeColor(n)
    const stroke = n.status === 'ok' ? '#222' : '#fff'
    let shape
    if (n.role === 'controller') {
        shape = `<polygon points="${starPoints(12, 12, 12, 5)}" fill="${color}" stroke="${stroke}" stroke-width="1.5"/>`
    } else if (n.role === 'listening') {
        shape = `<polygon points="${hexPoints(12, 12, 10)}" fill="${color}" stroke="${stroke}" stroke-width="1.5"/>`
    } else {
        shape = `<rect x="3" y="3" width="18" height="18" rx="2" fill="${color}" stroke="${stroke}" stroke-width="1.5"/>`
    }
    return L.divIcon({
        className: `ts-node${solid ? '' : ' ts-unplaced'}`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
        html: `<svg width="24" height="24" viewBox="0 0 24 24">${shape}</svg><span class="lbl">${esc(nodeLabel(n))}</span>`,
    })
}

function nodeTooltip(n, plan, isPlaced) {
    const route = mainRoute(n)
    const lines = [`<b>${esc(nodeLabel(n))}</b> (node ${n.id})`]
    if (n.location) lines.push(esc(n.location))
    lines.push({ controller: 'Controller', listening: 'Mains — always listening', sleeping: n.isFrequentListening ? 'FLiRS (battery, wakes often)' : 'Battery — sleeps' }[n.role])
    if (route) {
        const via = route.repeaters.length ? ` via ${route.repeaters.join(' → ')}` : ' (direct)'
        lines.push(`${route.hops} hop${route.hops > 1 ? 's' : ''}${via}${n.lwr ? '' : ' — backup route only'}`)
        const r = rssiLabel(route.rssi)
        if (r) lines.push(`RSSI ${r} · ${rateLabel(route.protocolDataRate)}`)
        if (route.failedBetween) lines.push(`Failed hop: ${route.failedBetween.join(' → ')}`)
    } else if (n.role !== 'controller') {
        lines.push('No route statistics')
    }
    if (n.neighbors.length) lines.push(`Neighbors: ${n.neighbors.join(', ')}`)
    if (n.unknownNeighbors?.length) lines.push(`Stale neighbor IDs (no such node): ${n.unknownNeighbors.join(', ')}`)
    if (plan) {
        lines.push(`<span class="muted">${isPlaced ? 'Drag to move · right-click to unplace' : 'Not placed — drag onto the plan'}</span>`)
    }
    return lines.join('<br>')
}

function applyLabelZoom() {
    map.getContainer().classList.toggle('ts-labels', map.getZoom() >= state.labelZoom)
}

/** Plan images go through api() so the login token is sent; shown via an object URL. */
async function planImageUrl(plan) {
    const cached = state.imageUrls.get(plan.id)
    if (cached) return cached
    const res = await api(`plans/${plan.id}/image`, { raw: true, headers: { Accept: 'image/*' } })
    const url = URL.createObjectURL(await res.blob())
    state.imageUrls.set(plan.id, url)
    return url
}

// ---------------------------------------------------------------- drawing

/** Rebuild drawn shapes from the layout, unless the user is mid-edit on this plan. */
function drawShapes(plan) {
    const shapes = plan ? state.layout.shapes.filter((sh) => sh.planId === plan.id) : []
    const json = JSON.stringify(shapes)
    const samePlan = state.drawnPlanId === (plan?.id ?? null)
    if (samePlan && (state.drawing || state.saveTimer || json === state.drawnJSON)) return
    if (!samePlan && state.drawing) setDrawing(false)
    layers.drawing.clearLayers()
    state.drawnPlanId = plan?.id ?? null
    state.drawnJSON = json
    if (!plan) return
    const H = plan.heightPx
    for (const sh of shapes) {
        let layer
        if (sh.type === 'rect') layer = L.rectangle([[H - sh.y - sh.h, sh.x], [H - sh.y, sh.x + sh.w]], shapeStyle())
        else if (sh.type === 'circle') layer = L.circle([H - sh.y, sh.x], { ...shapeStyle(), radius: sh.r })
        else if (sh.type === 'line') layer = L.polyline(sh.points.map(([x, y]) => [H - y, x]), { ...shapeStyle(), fill: false })
        else if (sh.type === 'label') layer = L.marker([H - sh.y, sh.x], { textMarker: true, text: sh.text, className: 'ts-label', pmIgnore: false })
        if (!layer) continue
        layer.addTo(layers.drawing)
        watchShape(layer)
    }
}

function watchShape(layer) {
    for (const ev of ['pm:edit', 'pm:dragend', 'pm:textchange', 'pm:textblur']) layer.on(ev, scheduleSave)
}

/** Current drawing → shapes in plan pixels (x right, y down). */
function collectShapes(plan) {
    const H = plan.heightPx
    const shapes = []
    layers.drawing.eachLayer((layer) => {
        if (layer instanceof L.Rectangle) {
            const b = layer.getBounds()
            shapes.push({ type: 'rect', x: b.getWest(), y: H - b.getNorth(), w: b.getEast() - b.getWest(), h: b.getNorth() - b.getSouth() })
        } else if (layer instanceof L.Circle) {
            const c = layer.getLatLng()
            shapes.push({ type: 'circle', x: c.lng, y: H - c.lat, r: layer.getRadius() })
        } else if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) {
            const pts = layer.getLatLngs().flat(Infinity)
            if (pts.length >= 2) shapes.push({ type: 'line', points: pts.map((p) => [p.lng, H - p.lat]) })
        } else if (layer instanceof L.Marker && layer.options.textMarker) {
            const text = layer.pm?.getText?.() ?? layer.options.text ?? ''
            const c = layer.getLatLng()
            if (text.trim()) shapes.push({ type: 'label', x: c.lng, y: H - c.lat, text })
        }
    })
    return shapes
}

function scheduleSave() {
    clearTimeout(state.saveTimer)
    state.saveTimer = setTimeout(saveShapes, SAVE_DELAY_MS)
}

async function saveShapes() {
    const plan = state.layout.plans.find((p) => p.id === state.drawnPlanId)
    if (!plan) { state.saveTimer = null; return }
    try {
        const saved = await api(`plans/${plan.id}/shapes`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shapes: collectShapes(plan) }),
        })
        state.drawnJSON = JSON.stringify(saved)
        panel.setStatus(`Drawing saved (${saved.length} shape${saved.length === 1 ? '' : 's'}).`)
    } catch (error) {
        panel.setStatus(explain(error, "Couldn't save the drawing"))
    }
    state.saveTimer = null
    reload()
}

function setDrawing(on) {
    state.drawing = on
    map.getContainer().classList.toggle('ts-drawing-on', on)
    if (on) {
        map.pm.setPathOptions(shapeStyle())
        map.pm.addControls({
            position: 'topleft',
            drawMarker: false, drawCircleMarker: false, drawPolygon: false, cutPolygon: false, rotateMode: false,
            drawRectangle: true, drawCircle: true, drawPolyline: true, drawText: true,
            editMode: true, dragMode: true, removalMode: true,
        })
        panel.setStatus('Drawing: pick a tool on the left. Lines finish with a click on the last point. Changes save automatically.')
    } else {
        map.pm.disableDraw()
        map.pm.disableGlobalEditMode()
        map.pm.disableGlobalDragMode()
        map.pm.disableGlobalRemovalMode()
        map.pm.removeControls()
        if (state.saveTimer) { clearTimeout(state.saveTimer); saveShapes() }
    }
    panel.setDrawing(on)
}

async function newDrawing() {
    try {
        const n = state.layout.plans.filter((p) => !p.image).length + 1
        const plan = await api('plans/blank', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: n === 1 ? 'Floor plan' : `Floor plan ${n}`, ...BLANK_SIZE }),
        })
        selectPlan(plan.id)
        panel.setStatus(`Added ${esc(plan.name)}. Click Draw to start.`)
    } catch (error) {
        panel.setStatus(explain(error, "Couldn't create a drawing"))
    }
}

// ---------------------------------------------------------------- plans

async function uploadPlan(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
        return panel.setStatus('Use a PNG, JPEG or WebP image.')
    }
    if (file.size > 25 * 1024 * 1024) {
        return panel.setStatus('That image is over 25 MB — export a smaller one.')
    }
    panel.setStatus(`Uploading ${esc(file.name)}…`)
    try {
        const bitmap = await createImageBitmap(file)
        const { width, height } = bitmap
        bitmap.close()
        const name = file.name.replace(/\.[^.]+$/, '')
        const qs = new URLSearchParams({ name, widthPx: width, heightPx: height })
        const plan = await api(`plans?${qs}`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file })
        selectPlan(plan.id)
        panel.setStatus(`Added ${esc(plan.name)} (${width} × ${height}). Drag nodes onto it.`)
    } catch (error) {
        panel.setStatus(explain(error, 'Upload failed'))
    }
}

async function deletePlan(plan) {
    try {
        await api(`plans/${plan.id}`, { method: 'DELETE' })
        const url = state.imageUrls.get(plan.id)
        if (url) URL.revokeObjectURL(url)
        state.imageUrls.delete(plan.id)
        panel.setStatus(`Deleted ${esc(plan.name)} and its placements.`)
    } catch (error) {
        panel.setStatus(explain(error, 'Delete failed'))
    }
    reload()
}

function selectPlan(id) {
    state.planId = id
    writePref(PLAN_KEY, id)
    lastLayoutJSON = '' // force a redraw
    reload()
}

// ---------------------------------------------------------------- refresh neighbors

async function refreshNeighbors(button) {
    button.disabled = true
    const done = (msg, cooldown = false) => {
        panel.setStatus(msg)
        if (cooldown) setTimeout(() => { button.disabled = false }, REFRESH_COOLDOWN_MS)
        else button.disabled = false
    }

    let auth
    try {
        // Z-Wave JS UI's history fallback rewrites any GET whose Accept header contains
        // */* (plain fetch) to its SPA page; Accept starting with application/json skips it.
        const res = await fetch(`${ZUI_BASE}api/auth-enabled`, { cache: 'no-store', headers: { Accept: 'application/json' } })
        const authEnabled = (await res.json()).data === true
        if (authEnabled) {
            const token = storedToken()
            if (!token) {
                return done(`Log in to <a href="${ZUI_BASE}" target="_blank">Z-Wave JS UI</a> in this browser first, then try again.`)
            }
            auth = { token }
        }
    } catch (error) {
        return done(`Can't reach Z-Wave JS UI: ${esc(error.message)}`)
    }

    panel.setStatus('Connecting to Z-Wave JS UI…')
    const socket = io({ path: `${ZUI_BASE}socket.io`, auth, reconnection: false, timeout: 10_000 })
    try {
        await new Promise((resolve, reject) => {
            socket.once('connect', resolve)
            socket.once('connect_error', reject)
        })
    } catch (error) {
        socket.disconnect()
        const msg = /auth/i.test(error.message)
            ? `Z-Wave JS UI refused the login — <a href="${ZUI_BASE}" target="_blank">log in again</a>, then retry.`
            : `Can't connect to Z-Wave JS UI: ${esc(error.message)}`
        return done(msg)
    }

    panel.setStatus('Reading neighbors from the controller (radio paused briefly)…')
    const result = await new Promise((resolve) => {
        socket.timeout(120_000).emit('ZWAVE_API', { api: 'refreshNeighbors', args: [] }, (err, response) => {
            resolve(err ? { success: false, message: 'timed out waiting for Z-Wave JS UI' } : response)
        })
    })
    socket.disconnect()

    if (!result?.success) return done(`Refresh failed: ${esc(result?.message ?? 'unknown error')}`, /60 seconds/.test(result?.message ?? ''))
    await reload()
    done(`Neighbors refreshed at ${new Date().toLocaleTimeString()}.`, true)
}

/** Z-Wave JS UI keeps its login (with the JWT) in localStorage 'user' (src/views/Login.vue). */
function storedToken() {
    try {
        return JSON.parse(localStorage.getItem('user') ?? 'null')?.token ?? null
    } catch {
        return null
    }
}

// ---------------------------------------------------------------- controls

function addPanel() {
    let els
    let armedDelete = null
    const Panel = L.Control.extend({
        onAdd() {
            const div = L.DomUtil.create('div', 'ts-panel')
            div.innerHTML = `<h1>TopoSite</h1>
                <div class="muted" id="ts-summary">Loading…</div>
                <div class="ts-row">
                    <select id="ts-plan" title="Background image"></select>
                    <button type="button" id="ts-add" title="Upload a PNG, JPEG or WebP image as a new background">Add image…</button>
                    <button type="button" id="ts-new" title="Start a blank floor plan to draw on">New drawing</button>
                    <button type="button" id="ts-del" title="Delete this background and every node position on it">Delete</button>
                    <input type="file" id="ts-file" accept="image/png,image/jpeg,image/webp" hidden>
                </div>
                <div class="ts-row"><button type="button" id="ts-draw" title="Draw rectangles, circles, lines and labels on this plan">Draw</button><button type="button" id="ts-refresh"
                    title="Asks Z-Wave JS UI to re-read every node's neighbor list from the controller. The radio pauses for a few seconds; allowed once a minute.">Refresh neighbors</button></div>
                <div class="muted" id="ts-status"></div>`
            L.DomEvent.disableClickPropagation(div)
            L.DomEvent.disableScrollPropagation(div)
            els = Object.fromEntries(['summary', 'plan', 'add', 'new', 'del', 'draw', 'file', 'refresh', 'status']
                .map((k) => [k, div.querySelector(`#ts-${k}`)]))
            els.refresh.addEventListener('click', () => refreshNeighbors(els.refresh))
            els.add.addEventListener('click', () => els.file.click())
            els.new.addEventListener('click', () => newDrawing())
            els.draw.addEventListener('click', () => setDrawing(!state.drawing))
            els.file.addEventListener('change', () => {
                const file = els.file.files[0]
                els.file.value = ''
                if (file) uploadPlan(file)
            })
            els.plan.addEventListener('change', () => selectPlan(els.plan.value))
            // Two clicks to delete, instead of a confirm() dialog
            els.del.addEventListener('click', () => {
                const plan = currentPlan()
                if (!plan) return
                if (armedDelete !== plan.id) {
                    armedDelete = plan.id
                    els.del.textContent = 'Really delete?'
                    setTimeout(() => { armedDelete = null; els.del.textContent = 'Delete' }, 4000)
                    return
                }
                armedDelete = null
                els.del.textContent = 'Delete'
                deletePlan(plan)
            })
            return div
        },
    })
    new Panel({ position: 'topleft' }).addTo(map)
    return {
        setStatus(html) { els.status.innerHTML = html },
        setDrawing(on) {
            els.draw.textContent = on ? 'Done drawing' : 'Draw'
            els.draw.classList.toggle('on', on)
        },
        setSummary(nodes) {
            const dead = nodes.filter((n) => n.status !== 'ok').length
            const withNb = nodes.filter((n) => n.neighbors.length).length
            els.summary.textContent = `${nodes.length} nodes · ${dead} dead/failed · neighbors known for ${withNb}`
        },
        setPlans(plans, selectedId) {
            els.plan.hidden = plans.length === 0
            els.del.hidden = plans.length === 0
            els.draw.hidden = plans.length === 0
            els.plan.innerHTML = plans.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')
            if (selectedId) els.plan.value = selectedId
        },
    }
}

function addLegend() {
    const Legend = L.Control.extend({
        onAdd() {
            const div = L.DomUtil.create('div', 'ts-panel ts-legend')
            const shapes = [['★', 'Controller'], ['⬢', 'Mains (repeats)'], ['■', 'Battery (sleeps)']]
            div.innerHTML = `<h2>Shape</h2>${shapes.map(([s, t]) => `<div><span>${s}</span>${t}</div>`).join('')}
                <h2>Node color = hops</h2>${HOP_LEGEND.map(([t, c]) => `<div><span class="sw" style="background:${c}"></span>${t}</div>`).join('')}
                <h2>Link color = data rate</h2>${RATE_LEGEND.map(([t, c]) => `<div><span class="ln" style="border-color:${c}"></span>${t}</div>`).join('')}
                <div><span class="ln" style="border-top-style:dashed;border-color:#888"></span>backup route</div>
                <div><span class="sw" style="background:#888;opacity:.45"></span>faded = not placed yet</div>`
            return div
        },
    })
    new Legend({ position: 'bottomleft' }).addTo(map)
}

// ---------------------------------------------------------------- helpers

function readPref(key) {
    try { return localStorage.getItem(key) } catch { return null }
}

function writePref(key, value) {
    try { localStorage.setItem(key, value) } catch { /* private mode: not remembered */ }
}

function starPoints(cx, cy, outer, inner) {
    const pts = []
    for (let i = 0; i < 10; i++) {
        const r = i % 2 ? inner : outer
        const a = -Math.PI / 2 + (i * Math.PI) / 5
        pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`)
    }
    return pts.join(' ')
}

function hexPoints(cx, cy, r) {
    const pts = []
    for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3
        pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`)
    }
    return pts.join(' ')
}

/** Placeholder background for the default view and blank drawing plans: a light 100-px grid. */
function gridImage(width = GRID_SIZE, height = GRID_SIZE) {
    const step = 100
    let lines = ''
    for (let x = 0; x <= width; x += step) lines += `<line x1="${x}" y1="0" x2="${x}" y2="${height}"/>`
    for (let y = 0; y <= height; y += step) lines += `<line x1="0" y1="${y}" x2="${width}" y2="${y}"/>`
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g stroke="#999" stroke-width="2" opacity="0.35">${lines}</g></svg>`
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// SN: 00001
