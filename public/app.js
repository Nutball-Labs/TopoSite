// app.js — TopoSite map page (Leaflet, simple/pixel CRS).
//
// Reads /toposite/api/nodes and /toposite/api/layout (MAPS.md data model v2:
// settings, backgrounds, maps) and draws the current map: nodes, routes and
// neighbor links in Z-Wave JS UI's visual language. The default map opens on load.
// Each map has a node list (include all / exclude all + exceptions): hidden nodes
// aren't drawn. The page is read-only until Edit map is on; then nodes can be shown
// or hidden, dragged into place on a placed map (positions saved inside the map, in
// canvas pixels), and dragged in from the "Not placed yet" tray — a shown node with
// no position on a placed map waits there instead of being drawn. The built-in
// Network Graph map (layout "graph") is laid out automatically by a force-directed
// layout (mesh-view.js forceLayout) recomputed from the live routes.
//
// Backgrounds are images the user supplies (light, and optionally a dark version).
//
// Every /toposite/api call sends Z-Wave JS UI's login token (if any); TopoSite
// accepts exactly the logins Z-Wave JS UI accepts (lib/auth.js).
//
// "Refresh neighbors" calls Z-Wave JS UI's own socket.io API (refreshNeighbors),
// which Z-Wave JS UI authenticates, rate-limits (once per 60 s) and runs with
// the radio briefly paused.

import {
    agoLabel, batteryLevelClass, forceLayout, mapView, meshHealth, BATTERY_LOW, HEALTH_COLORS, nodeColor, nodeLabel, mainRoute, rateColor, rateLabel,
    rssiLabel, HOP_LEGEND, RATE_LEGEND,
} from './mesh-view.js'

/* global L, io */

const GRID_SIZE = 1000
const POLL_MS = 30_000
const REFRESH_COOLDOWN_MS = 60_000
const PANE_KEY = 'toposite.paneWidth'
// Z-Wave JS UI's root, as the browser sees it (keeps working behind a path prefix)
const ZUI_BASE = location.pathname.replace(/toposite\/.*$/, '')
const LOGIN_LINK = `<a href="${ZUI_BASE}" target="_blank">log in to Z-Wave JS UI</a>`

const map = L.map('map', { crs: L.CRS.Simple, minZoom: -5, maxZoom: 3, zoomSnap: 0.25, attributionControl: false })

// Background images get their own pane under the overlay pane (z 400), so they
// always sit beneath route lines no matter when they're added.
map.createPane('ts-background').style.zIndex = 300

const layers = {
    background: L.layerGroup().addTo(map),
    routes: L.layerGroup().addTo(map),
    nlwr: L.layerGroup(),
    neighbors: L.layerGroup().addTo(map),
    nodes: L.layerGroup().addTo(map),
    health: L.layerGroup().addTo(map),
    battery: L.layerGroup(),
}
const LAYER_CHOICES = [
    ['Routes (last working)', layers.routes],
    ['Backup routes (next-to-last)', layers.nlwr],
    ['Neighbors (when known)', layers.neighbors],
    ['Nodes', layers.nodes],
    ['Mesh health', layers.health],
    ['Battery level', layers.battery],
]
// view.layers keys saved with each map (lib/layout.js DEFAULT_LAYERS) → layer groups
const VIEW_LAYERS = { routes: layers.routes, backupRoutes: layers.nlwr, neighbors: layers.neighbors, nodes: layers.nodes, health: layers.health, battery: layers.battery }
const VIEW_DEFAULTS = { routes: true, backupRoutes: false, neighbors: true, nodes: true, health: true, battery: false }
addLayersButton()

const state = {
    nodes: [],
    layout: { settings: {}, backgrounds: [], maps: [] },
    mapId: null, // map picked this visit; on load the default map opens
    edit: false, // Edit map on: node list, tray, dragging
    shownMapId: undefined, // map the view was last fitted to
    imageUrls: new Map(), // "<backgroundId>:<variant>" → {image, url}: object URL of a fetched background
    labelZoom: 0,
}

const panel = addPanel()
// While editing, pans, zooms and layer changes are saved as the map's view
map.on('moveend layeradd layerremove', (e) => {
    if (e.type !== 'moveend' && !Object.values(VIEW_LAYERS).includes(e.layer)) return
    saveViewSoon()
})
addLegend()
setupPane()
map.on('zoomend', applyLabelZoom)

// Theme changed (index.html): redraw so a map's dark/light background swaps
window.addEventListener('ts-theme', () => {
    lastLayoutJSON = ''
    reload()
})

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
        panel.setMaps(layout.maps, currentMap()?.id)
    } catch (error) {
        panel.setStatus(explain(error, "Can't load the map"))
    }
}

/** The map being shown: the one picked here, else the default map, else the first. */
function currentMap() {
    const maps = state.layout.maps
    return maps.find((m) => m.id === state.mapId) ?? maps.find((m) => m.id === state.layout.settings?.defaultMapId) ?? maps[0] ?? null
}

/** Is node n shown on map m? The map's starting rule, flipped for its exceptions. */
function isShown(m, n) {
    const flipped = (m?.nodes?.exceptions ?? []).includes(n.key)
    return (m?.nodes?.start ?? 'include') === 'include' ? !flipped : flipped
}

/** A placed map's library background, or null. */
function backgroundOf(map) {
    return map?.background ? state.layout.backgrounds.find((b) => b.id === map.background.id) ?? null : null
}

// ---------------------------------------------------------------- rendering

async function draw() {
    const cur = currentMap()
    // `plan` = the current map when it's a placed map (has a canvas); null on the Network Graph
    const plan = cur?.layout === 'placed' ? cur : null
    const width = plan?.widthPx ?? GRID_SIZE
    const height = plan?.heightPx ?? GRID_SIZE
    const bg = backgroundOf(plan)
    const bounds = [[0, 0], [height, width]]

    // Background: the map's image, the grid on a placed map without one, nothing on the graph
    layers.background.clearLayers()
    if (bg && (bg.image || bg.imageDark)) {
        // Dark version while the UI is dark (if there is one), otherwise the normal image
        const variant = (isDarkTheme() && bg.imageDark) || !bg.image ? 'dark' : 'light'
        const url = await backgroundUrl(bg, variant).catch((error) => {
            panel.setStatus(explain(error, `Can't load image for ${esc(plan.name)}`))
            return null
        })
        // imageRect: where the picture sits on this map's canvas, in canvas px (y down)
        const r = plan.background.imageRect
        const imgBounds = [[height - (r.y + r.h), r.x], [height - r.y, r.x + r.w]]
        if (url) L.imageOverlay(url, imgBounds, { pane: 'ts-background' }).addTo(layers.background)
    } else if (plan) {
        L.imageOverlay(gridImage(width, height), bounds, { opacity: 0.6, pane: 'ts-background' }).addTo(layers.background)
    }
    if (state.shownMapId !== (cur?.id ?? null)) {
        // A newly opened map: its saved view (zoom, centre, layers), else fit it
        state.shownMapId = cur?.id ?? null
        state.applyingView = true
        const v = cur?.view ?? {}
        if (Array.isArray(v.center) && typeof v.zoom === 'number') map.setView(v.center, v.zoom, { animate: false })
        else map.fitBounds(bounds, { padding: [20, 20], animate: false })
        for (const [k, layer] of Object.entries(VIEW_LAYERS)) {
            if (v.layers?.[k] ?? VIEW_DEFAULTS[k]) layer.addTo(map)
            else map.removeLayer(layer)
        }
        state.applyingView = false
        state.labelZoom = map.getBoundsZoom(bounds, false, L.point(40, 40)) + 0.75
        applyLabelZoom()
    }

    // Positions: on a placed map, where shown nodes were put (the rest wait in the
    // tray); on the Network Graph, the automatic layout of the shown nodes.
    const shown = state.nodes.filter((n) => isShown(cur, n))
    const placed = new Map()
    for (const p of plan?.placements ?? []) {
        if (p.deviceKey) placed.set(p.deviceKey, [height - p.y, p.x])
    }
    // `positioned` = every node with a spot on this map, shown or not (hidden ones
    // can still appear as ghost repeaters on a shown node's route)
    const positioned = new Map()
    const unplaced = []
    if (plan) {
        for (const n of state.nodes) {
            const saved = n.key && placed.get(n.key)
            if (saved) positioned.set(n.id, saved)
            else if (isShown(cur, n)) unplaced.push(n)
        }
    } else {
        // Network Graph: lay out the shown nodes plus the repeaters on their routes
        // (hidden ones then show as ghosts in their proper place)
        const ids = new Set(shown.map((n) => n.id))
        const controllerId = state.nodes.find((n) => n.role === 'controller')?.id
        for (const n of shown) {
            for (const r of [n.lwr, n.nlwr]) {
                if (!r) continue
                for (const id of [controllerId, ...r.repeaters]) if (id != null) ids.add(id)
            }
        }
        const graphNodes = state.nodes.filter((n) => ids.has(n.id))
        const side = Math.min(width, height) * 0.9
        const laid = forceLayout(graphNodes, side)
        for (const n of graphNodes) {
            const [y, x] = laid.get(n.id)
            positioned.set(n.id, [y + (height - side) / 2, x + (width - side) / 2])
        }
    }
    const view = mapView(state.nodes, new Set(shown.map((n) => n.id)), positioned)
    const ghostIds = new Set(view.ghosts.map((g) => g.id))
    const nodePos = new Map([...view.pos].filter(([id]) => !ghostIds.has(id)))

    drawLinks(view.links, view.pos)
    drawGhosts(view.ghosts)
    hintPlacing(plan, placed, unplaced)
    drawNodes(nodePos, plan, height)
    drawHealth(shown, nodePos, view.pos)
    drawBattery(nodePos)
    drawPlaceholders(plan, height)
    panel.setEdit(cur, unplaced)
}

function drawLinks(links, pos) {
    for (const g of [layers.routes, layers.nlwr, layers.neighbors]) g.clearLayers()
    const byId = new Map(state.nodes.map((n) => [n.id, n]))
    const name = (id) => esc(byId.get(id)?.name ?? `NodeID ${id}`)

    for (const l of links) {
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

function drawNodes(pos, plan, height) {
    layers.nodes.clearLayers()
    for (const n of state.nodes) {
        const p = pos.get(n.id)
        if (!p) continue
        const marker = L.marker(p, {
            icon: nodeIcon(n),
            keyboard: false,
            draggable: !!(state.edit && plan && n.key),
        })
            .bindTooltip(nodeTooltip(n, plan), { direction: 'top', offset: [0, -14] })
            .addTo(layers.nodes)
        // Right-click opens a menu; nothing changes until a menu item is clicked
        marker.on('contextmenu', (e) => {
            L.DomEvent.preventDefault(e.originalEvent)          // no browser menu over nodes
            openNodeMenu(n, marker, plan)
        })
        if (state.edit && plan && n.key) {
            marker.on('dragend', () => {
                const { lat, lng } = marker.getLatLng()
                placeNode(plan, n, lng, height - lat)
            })
        }
    }
}

/**
 * Ghosts: nodes on a shown node's route that aren't drawn as nodes here — hidden
 * repeaters, or shown ones not placed yet. Small grey dots (dashed ring when the
 * spot is approximate), in the same layer as the route they belong to.
 */
function drawGhosts(ghosts) {
    const byId = new Map(state.nodes.map((n) => [n.id, n]))
    for (const g of ghosts) {
        const n = byId.get(g.id)
        const label = n ? nodeLabel(n) : `NodeID ${g.id}`
        const why = g.shown ? 'Not placed on this map yet' : 'Hidden on this map'
        const where = g.approx ? 'drawn midway between its route neighbors (approximate spot)' : 'shown at its spot on this map'
        L.marker(g.pos, {
            keyboard: false,
            icon: L.divIcon({
                className: `ts-node ts-ghost${g.approx ? ' ts-approx' : ''}`,
                iconSize: [12, 12],
                iconAnchor: [6, 6],
                html: `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5"/></svg><span class="lbl">${esc(label)}</span>`,
            }),
        })
            .bindTooltip(`<b>${esc(label)}</b> (node ${g.id})<br>${why} — it repeats for a shown node's ${g.kind === 'lwr' ? 'route' : 'backup route'},` +
                ` so it's ${where}.`, { direction: 'top', offset: [0, -8] })
            .addTo(g.kind === 'lwr' ? layers.routes : layers.nlwr)
    }
}

/**
 * Mesh health (mesh-view.js meshHealth): a ring around flagged nodes, a "!" on
 * weak route hops, dotted lines for one-way neighbor entries. These avoid the
 * colors and line styles Z-Wave JS UI already gives meaning to. The pane lists
 * every flagged node shown on this map; clicking one jumps to it.
 */
function drawHealth(shown, nodePos, allPos) {
    layers.health.clearLayers()
    const h = meshHealth(state.nodes)
    const byId = new Map(state.nodes.map((n) => [n.id, n]))
    const name = (id) => esc(byId.get(id)?.name ?? `NodeID ${id}`)
    for (const [id, f] of h.nodes) {
        const p = nodePos.get(id)
        if (!p) continue
        L.circleMarker(p, { radius: 17, color: HEALTH_COLORS[f.level], weight: 3, fill: false, interactive: false }).addTo(layers.health)
    }
    for (const hop of h.hops) {
        if (hop.kind !== 'lwr') continue
        const a = allPos.get(hop.a)
        const b = allPos.get(hop.b)
        if (!a || !b) continue
        L.marker([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], {
            keyboard: false,
            icon: L.divIcon({ className: `ts-hopwarn ts-${hop.level}`, iconSize: [16, 16], iconAnchor: [8, 8], html: '!' }),
        }).bindTooltip(`${hop.level === 'bad' ? 'Very weak' : 'Weak'} hop ${name(hop.a)} ↔ ${name(hop.b)}: ${esc(rssiLabel(hop.rssi))}`, { direction: 'top' })
            .addTo(layers.health)
    }
    for (const w of h.oneWay) {
        const a = nodePos.get(w.from)
        const b = nodePos.get(w.to)
        if (!a || !b) continue
        L.polyline([a, b], { color: HEALTH_COLORS.warn, weight: 2, dashArray: '1 6', lineCap: 'round' })
            .bindTooltip(`One-way: ${name(w.from)} lists ${name(w.to)} as a neighbor, but not the other way round`, { sticky: true })
            .addTo(layers.health)
    }
    const listed = [...h.nodes].filter(([id]) => shown.some((n) => n.id === id))
        .sort(([, a], [, b]) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1))
    panel.setHealth(listed.map(([id, f]) => ({ id, name: byId.get(id) ? nodeLabel(byId.get(id)) : `NodeID ${id}`, ...f, pos: nodePos.get(id) ?? allPos.get(id) })),
        h.oneWay.filter((w) => nodePos.has(w.from) && nodePos.has(w.to)).length)
}

/** Battery layer: a percentage tag beside each battery node (amber / red when low). */
function drawBattery(nodePos) {
    layers.battery.clearLayers()
    for (const n of state.nodes) {
        const p = nodePos.get(n.id)
        if (!p || n.battery == null) continue
        L.marker(p, {
            keyboard: false,
            interactive: true,
            icon: L.divIcon({ className: `ts-batt ts-batt-${batteryLevelClass(n.battery)}`, iconSize: null, iconAnchor: [-14, 8], html: `${n.battery}%` }),
        }).bindTooltip(`${esc(n.name)}: battery ${n.battery}%, last heard from ${agoLabel(n.lastSeen)}`, { direction: 'top' })
            .addTo(layers.battery)
    }
}

let saveViewTimer = 0
/** Save the current zoom, centre and layers with the map — only in edit mode. */
function saveViewSoon() {
    if (!state.edit || state.applyingView) return
    const m = currentMap()
    if (!m) return
    clearTimeout(saveViewTimer)
    saveViewTimer = setTimeout(async () => {
        const c = map.getCenter()
        const view = { center: [c.lat, c.lng], zoom: map.getZoom(), layers: { ...VIEW_DEFAULTS, ...m.view?.layers } }
        for (const [k, layer] of Object.entries(VIEW_LAYERS)) view.layers[k] = map.hasLayer(layer)
        try {
            await api(`maps/${m.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ view }) })
            m.view = view // keep the local copy current; the next poll brings the same
        } catch (error) {
            panel.setStatus(explain(error, "Couldn't save the map's view"))
        }
    }, 800)
}

/** Save node n's position on a placed map (canvas px, y down). */
async function placeNode(plan, n, x, y) {
    try {
        await api(`maps/${plan.id}/placements`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceKey: n.key, x, y }),
        })
        panel.setStatus(`Placed ${esc(n.name)}.`)
    } catch (error) {
        panel.setStatus(explain(error, `Couldn't save ${esc(n.name)}`))
    }
    reload()
}

/** Show exactly the nodes in `keys` on map m: exceptions follow from its starting rule. */
async function setShown(m, keys, start = m.nodes.start) {
    const all = state.nodes.filter((n) => n.key)
    const exceptions = start === 'include'
        ? all.filter((n) => !keys.has(n.key)).map((n) => n.key)
        : all.filter((n) => keys.has(n.key)).map((n) => n.key)
    try {
        await api(`maps/${m.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodes: { start, exceptions } }),
        })
    } catch (error) {
        panel.setStatus(explain(error, "Couldn't change the node list"))
    }
    lastLayoutJSON = ''
    reload()
}

/** Keys of the nodes currently shown on map m. */
function shownKeys(m) {
    return new Set(state.nodes.filter((n) => n.key && isShown(m, n)).map((n) => n.key))
}

/**
 * Placeholders: imported positions whose node wasn't matched. Drawn as dashed,
 * hollow markers labelled "not linked"; right-click to Link to… a device or Delete.
 */
function drawPlaceholders(plan, height) {
    if (!plan) return
    for (const ph of plan.placements) {
        if (!ph.placeholder) continue
        const label = `${ph.placeholder.name ?? 'Unknown device'} — not linked`
        const marker = L.marker([height - ph.y, ph.x], {
            keyboard: false,
            icon: L.divIcon({
                className: 'ts-node ts-ph',
                iconSize: [24, 24],
                iconAnchor: [12, 12],
                html: '<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /></svg>' +
                    `<span class="lbl">${esc(label)}</span>`,
            }),
        })
            .bindTooltip(`<b>${esc(label)}</b><br>${[ph.placeholder.loc, ph.placeholder.productLabel ?? ph.placeholder.deviceId]
                .filter(Boolean).map(esc).join(' · ')}<br><span class="muted">Imported position with no matching device — right-click to link it</span>`,
            { direction: 'top', offset: [0, -14] })
            .addTo(layers.nodes)
        marker.on('contextmenu', (e) => {
            L.DomEvent.preventDefault(e.originalEvent)
            openPlaceholderMenu(ph, marker, plan)
        })
    }
}

function openPlaceholderMenu(ph, marker, plan) {
    marker.closeTooltip()
    if (!state.edit) {
        L.popup({ closeButton: true, autoClose: true, offset: [0, -10] }).setLatLng(marker.getLatLng())
            .setContent(`<div class="ts-menu"><div class="ts-menu-title">${esc(ph.placeholder.name ?? 'Unknown device')} <span class="muted">not linked</span></div>` +
                '<div class="muted">Press <b>Edit map</b> to link or delete this placeholder.</div></div>')
            .openOn(map)
        return
    }
    const choices = state.nodes.filter((n) => n.key && n.role !== 'controller')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((n) => `<option value="${esc(n.key)}">${esc(n.name)}${n.location ? ` — ${esc(n.location)}` : ''} (node ${n.id})</option>`)
    const div = document.createElement('div')
    div.className = 'ts-menu'
    div.innerHTML = `<div class="ts-menu-title">${esc(ph.placeholder.name ?? 'Unknown device')} <span class="muted">not linked</span></div>
        <div class="ts-menu-actions">
            <select data-act="pick" aria-label="Device to link"><option value="">Link to…</option>${choices.join('')}</select>
            <button type="button" data-act="link" disabled title="The chosen device takes this spot">Link</button>
            <button type="button" data-act="delete" title="Remove this placeholder (click twice)">Delete placeholder</button>
        </div>`
    const popup = L.popup({ closeButton: true, autoClose: true, offset: [0, -10] })
        .setLatLng(marker.getLatLng()).setContent(div).openOn(map)
    const pick = div.querySelector('[data-act="pick"]')
    const link = div.querySelector('[data-act="link"]')
    const del = div.querySelector('[data-act="delete"]')
    pick.addEventListener('change', () => { link.disabled = !pick.value })
    link.addEventListener('click', async () => {
        map.closePopup(popup)
        try {
            await api(`maps/${plan.id}/placeholders/${encodeURIComponent(ph.id)}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceKey: pick.value }),
            })
            panel.setStatus(`Linked — ${esc(pick.selectedOptions[0].textContent)} now sits at that spot.`)
        } catch (error) {
            panel.setStatus(explain(error, "Couldn't link the placeholder"))
        }
        reload()
    })
    let armed = false
    del.addEventListener('click', async () => {
        if (!armed) { armed = true; del.textContent = 'Really delete?'; return }
        map.closePopup(popup)
        try {
            await api(`maps/${plan.id}/placeholders/${encodeURIComponent(ph.id)}`, { method: 'DELETE' })
            panel.setStatus('Placeholder deleted.')
        } catch (error) {
            panel.setStatus(explain(error, "Couldn't delete the placeholder"))
        }
        reload()
    })
}

/** On a placed map with nothing placed yet, say how to place nodes (and that positions are per map). */
function hintPlacing(plan, placed, unplaced) {
    if (!plan || placed.size || !unplaced.length) return
    const elsewhere = state.layout.maps.filter((m) => m.id !== plan.id && m.placements?.some((pl) => pl.deviceKey))
    panel.setStatus(`No nodes placed on ${esc(plan.name)} yet — press <b>Edit map</b> and drag them in from <b>Not placed yet</b>.` +
        (elsewhere.length ? ` Positions are saved per map; ${elsewhere.map((p) => esc(p.name)).join(', ')} has its own.` : ''))
}

/**
 * Node menu (right-click): actions only — details stay on the hover tooltip.
 * Nothing changes until an item is clicked.
 */
function openNodeMenu(n, marker, plan) {
    marker.closeTooltip()
    const cur = currentMap()
    const actions = []
    if (state.edit && n.key) {
        if (plan) actions.push('<button type="button" data-act="unplace" title="Remove its position on this map — it goes back to Not placed yet">Unplace</button>')
        actions.push('<button type="button" data-act="hide" title="Stop showing this node on this map">Hide on this map</button>')
    }
    const hint = !n.key ? 'This node has no key yet, so it can\'t be changed on a map.'
        : 'Press <b>Edit map</b> to move, unplace or hide nodes.'
    const div = document.createElement('div')
    div.className = 'ts-menu'
    div.innerHTML = `<div class="ts-menu-title">${esc(nodeLabel(n))} <span class="muted">node ${n.id}</span></div>` +
        (actions.length ? `<div class="ts-menu-actions">${actions.join('')}</div>` : `<div class="muted">${hint}</div>`)
    const popup = L.popup({ closeButton: true, autoClose: true, offset: [0, -10] })
        .setLatLng(marker.getLatLng())
        .setContent(div)
        .openOn(map)
    div.querySelector('[data-act="unplace"]')?.addEventListener('click', async () => {
        map.closePopup(popup)
        try {
            await api(`maps/${plan.id}/placements/${encodeURIComponent(n.key)}`, { method: 'DELETE' })
            panel.setStatus(`${esc(n.name)} unplaced — it's back in Not placed yet.`)
        } catch (error) {
            panel.setStatus(explain(error, `Couldn't unplace ${esc(n.name)}`))
        }
        reload()
    })
    div.querySelector('[data-act="hide"]')?.addEventListener('click', () => {
        map.closePopup(popup)
        const keys = shownKeys(cur)
        keys.delete(n.key)
        panel.setStatus(`${esc(n.name)} hidden on ${esc(cur.name)} — tick it under Nodes on this map to show it again.`)
        setShown(cur, keys)
    })
}

function nodeIcon(n) {
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
        className: 'ts-node',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
        html: `<svg width="24" height="24" viewBox="0 0 24 24">${shape}</svg><span class="lbl">${esc(nodeLabel(n))}</span>`,
    })
}

function nodeTooltip(n, plan) {
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
    if (n.battery != null) lines.push(`Battery ${n.battery}% · last heard from ${agoLabel(n.lastSeen)}`)
    if (n.neighbors.length) lines.push(`Neighbors: ${n.neighbors.join(', ')}`)
    if (n.unknownNeighbors?.length) lines.push(`Stale neighbor IDs (no such node): ${n.unknownNeighbors.join(', ')}`)
    lines.push(`<span class="muted">${state.edit ? (plan ? 'Drag to move · right-click for options' : 'Right-click for options')
        : 'Right-click for options'}</span>`)
    return lines.join('<br>')
}

function applyLabelZoom() {
    map.getContainer().classList.toggle('ts-labels', map.getZoom() >= state.labelZoom)
}

/** Background images go through api() so the login token is sent; shown via an object URL. */
async function backgroundUrl(bg, variant = 'light') {
    const key = `${bg.id}:${variant}`
    const image = variant === 'dark' ? bg.imageDark : bg.image
    const cached = state.imageUrls.get(key)
    if (cached?.image === image) return cached.url
    if (cached) URL.revokeObjectURL(cached.url)
    const res = await api(`backgrounds/${bg.id}/image?variant=${variant}`, { raw: true, headers: { Accept: 'image/*' } })
    const url = URL.createObjectURL(await res.blob())
    state.imageUrls.set(key, { image, url })
    return url
}

/** Same rule as index.html's theme script: Z-Wave JS UI's choice, else the OS. */
function isDarkTheme() {
    const t = document.documentElement.dataset.theme
    return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
}

// ---------------------------------------------------------------- export / import

/** Default export file name: the map's name, made safe for a file system. */
function exportName(plan) {
    return `${plan.name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim() || 'map'}.toposite`
}

/** Map ▸ Export: download the current map under the file name the user chose (default <map name>.toposite). */
async function exportMap(plan, fileName = exportName(plan)) {
    const name = /\.toposite$/i.test(fileName) ? fileName : `${fileName}.toposite`
    try {
        const res = await api(`maps/${plan.id}/export`, { raw: true })
        const url = URL.createObjectURL(await res.blob())
        const a = Object.assign(document.createElement('a'), { href: url, download: name })
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
        panel.setStatus(`Exported ${esc(plan.name)} as ${esc(name)}.`)
    } catch (error) {
        panel.setStatus(explain(error, 'Export failed'))
    }
}

/** Map ▸ Import…: upload the file for a preview, then review every node before anything is created. */
async function importPreview(file) {
    panel.setStatus(`Reading ${esc(file.name)}…`)
    try {
        const preview = await api('import/preview', {
            method: 'POST', headers: { 'Content-Type': 'application/x-toposite' }, body: file,
        })
        panel.setStatus('')
        openReview(preview)
    } catch (error) {
        panel.setStatus(explain(error, "Couldn't read that file"))
    }
}

const CONFIDENCE = {
    certain: ['Certain', 'Same device (same network and node, or same S2 key)'],
    likely: ['Likely', 'Same name and same device model'],
    possible: ['Possible — check', 'Same model in the same location, or same name only'],
    none: ['No match', 'No device here looks like it'],
}

/** The review screen: every node in the file, its proposed match (changeable), then Import. */
function openReview(pv) {
    const overlay = document.createElement('div')
    overlay.className = 'ts-review'
    const options = (selected) => ['<option value="">No match — keep as placeholder</option>',
        ...[...pv.nodes].sort((a, b) => a.name.localeCompare(b.name)).map((n) =>
            `<option value="${esc(n.key)}"${n.key === selected ? ' selected' : ''}>${esc(n.name)}${n.location ? ` — ${esc(n.location)}` : ''} (node ${n.id})</option>`)].join('')
    const rows = pv.entries.map((e) => {
        const [label, why] = CONFIDENCE[e.confidence] ?? CONFIDENCE.none
        const detail = [e.loc, e.productLabel ?? e.deviceId, e.nodeId != null ? `was node ${e.nodeId}` : null].filter(Boolean).map(esc).join(' · ')
        return `<tr data-ref="${esc(e.ref)}" data-conf="${esc(e.confidence)}">
            <td><b>${esc(e.name ?? 'Unnamed device')}</b><div class="muted">${detail}</div></td>
            <td><select data-ref="${esc(e.ref)}" aria-label="Match for ${esc(e.name ?? e.ref)}">${options(e.key)}</select></td>
            <td><span class="ts-conf ts-conf-${esc(e.confidence)}" title="${esc(why)}">${label}</span>${e.tied
                ? `<div class="muted">${e.tied} equally good candidates — pick one</div>` : ''}</td></tr>`
    }).join('')
    const m = pv.map
    const facts = [`${m.widthPx} × ${m.heightPx} px`, m.hasImage ? 'background image' : 'no background',
        m.hasDarkImage ? 'dark-mode image' : null, pv.source?.exportedAt ? `exported ${pv.source.exportedAt.slice(0, 10)}` : null]
        .filter(Boolean).join(' · ')
    overlay.innerHTML = `<div class="ts-review-box" role="dialog" aria-modal="true" aria-labelledby="ts-review-title">
        <h2 id="ts-review-title">Import map</h2>
        <div class="muted">${esc(facts)}</div>
        <label class="ts-field"><span>New map name</span><input id="ts-review-name" maxlength="100" value="${esc(m.name)}"></label>
        <p class="muted">Check each device. Choose the matching device on this network, or keep it as a placeholder
            (a dashed marker you can link later). Nothing is created until you press Import.</p>
        <div class="ts-review-filter" role="radiogroup" aria-label="Show">
            <label><input type="radio" name="ts-rf" value="all" checked> All (${pv.entries.length})</label>
            <label><input type="radio" name="ts-rf" value="unconfirmed"> Not certain</label>
            <label><input type="radio" name="ts-rf" value="none"> No match chosen</label>
        </div>
        ${pv.entries.length
            ? `<table class="ts-review-table"><thead><tr><th>In the file</th><th>Matches on this network</th><th>Confidence</th></tr></thead><tbody>${rows}</tbody></table>`
            : '<p>This map has no placed nodes — only its background will be imported.</p>'}
        <div class="ts-review-warn" id="ts-review-warn" hidden></div>
        <div class="ts-review-buttons">
            <button type="button" id="ts-review-cancel">Cancel</button>
            <button type="button" id="ts-review-ok" class="ts-primary">Import</button>
        </div></div>`
    document.body.appendChild(overlay)
    const q = (sel) => overlay.querySelector(sel)
    const selects = [...overlay.querySelectorAll('select[data-ref]')]
    const ok = q('#ts-review-ok')
    const warn = q('#ts-review-warn')

    const refresh = () => {
        const counts = {}
        for (const sel of selects) if (sel.value) counts[sel.value] = (counts[sel.value] ?? 0) + 1
        let dups = 0
        for (const sel of selects) {
            const dup = !!sel.value && counts[sel.value] > 1
            sel.closest('tr').classList.toggle('ts-dup', dup)
            if (dup) dups++
        }
        const linked = selects.filter((sel) => sel.value).length
        warn.hidden = !dups
        warn.textContent = dups ? 'The same device is chosen for more than one entry — each device can only take one spot.' : ''
        ok.disabled = dups > 0
        ok.textContent = `Import (${linked} linked, ${selects.length - linked} placeholder${selects.length - linked === 1 ? '' : 's'})`
        const filter = overlay.querySelector('input[name="ts-rf"]:checked').value
        for (const tr of overlay.querySelectorAll('tbody tr')) {
            const sel = tr.querySelector('select')
            tr.hidden = (filter === 'unconfirmed' && tr.dataset.conf === 'certain') || (filter === 'none' && !!sel.value)
        }
    }
    overlay.addEventListener('change', refresh)
    refresh()

    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey) }
    const onKey = (e) => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', onKey)
    q('#ts-review-cancel').addEventListener('click', close)
    ok.addEventListener('click', async () => {
        ok.disabled = true
        const matches = Object.fromEntries(selects.map((sel) => [sel.dataset.ref, sel.value || null]))
        try {
            const res = await api('import/commit', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: pv.token, matches, name: q('#ts-review-name').value.trim() || undefined }),
            })
            close()
            selectPlan(res.map.id)
            panel.setStatus(`Imported ${esc(res.map.name)}: ${res.linked} node${res.linked === 1 ? '' : 's'} placed` +
                (res.placeholders ? `, ${res.placeholders} placeholder${res.placeholders === 1 ? '' : 's'} to link (right-click a dashed marker).` : '.'))
        } catch (error) {
            ok.disabled = false
            warn.hidden = false
            warn.innerHTML = explain(error, 'Import failed')
        }
    })
    q('#ts-review-name').focus()
}

// ---------------------------------------------------------------- maps

/**
 * Map ▸ New…: name, background (none / one from the library / upload), starting
 * rule, and optionally a one-time copy of positions from a map on the same background.
 */
function openNewMap() {
    const lay = state.layout
    const placedMaps = lay.maps.filter((m) => m.layout === 'placed')
    const usedBy = (bg) => placedMaps.filter((m) => m.background?.id === bg.id).length
    const overlay = document.createElement('div')
    overlay.className = 'ts-review'
    overlay.innerHTML = `<form class="ts-review-box ts-newmap" role="dialog" aria-modal="true" aria-labelledby="ts-nm-title">
        <h2 id="ts-nm-title">New map</h2>
        <label class="ts-field"><span>Name</span><input id="ts-nm-name" maxlength="100" required autocomplete="off"></label>
        <fieldset><legend>Background</legend>
            <label><input type="radio" name="ts-nm-bg" value="" checked> None — a blank grid</label>
            ${lay.backgrounds.map((bg) => `<label><input type="radio" name="ts-nm-bg" value="${esc(bg.id)}"> ${esc(bg.name)}
                <span class="muted">(${bg.widthPx} × ${bg.heightPx} px${bg.imageDark ? ', with dark version' : ''}; used by ${usedBy(bg)} map${usedBy(bg) === 1 ? '' : 's'})</span></label>`).join('')}
            <label><input type="radio" name="ts-nm-bg" value="upload"> Upload an image… <input type="file" id="ts-nm-file" accept="image/png,image/jpeg,image/webp"></label>
        </fieldset>
        <fieldset><legend>Nodes</legend>
            <label><input type="radio" name="ts-nm-start" value="include" checked> Include all — hide the ones you don't want</label>
            <label><input type="radio" name="ts-nm-start" value="exclude"> Exclude all — pick the ones you want</label>
            <div class="muted">This also decides whether nodes added to Z-Wave later appear on this map.</div>
        </fieldset>
        <label class="ts-field"><span>Copy positions from</span><select id="ts-nm-copy"></select></label>
        <div class="muted" id="ts-nm-copyhint"></div>
        <div class="ts-review-warn" id="ts-nm-warn" hidden></div>
        <div class="ts-review-buttons">
            <button type="button" id="ts-nm-cancel">Cancel</button>
            <button type="submit" id="ts-nm-ok" class="ts-primary">Create</button>
        </div></form>`
    document.body.appendChild(overlay)
    const q = (sel) => overlay.querySelector(sel)
    const bgChoice = () => overlay.querySelector('input[name="ts-nm-bg"]:checked').value
    const file = q('#ts-nm-file')
    // Copying positions only makes sense between maps on the same background
    const refreshCopy = () => {
        const bg = bgChoice()
        const sources = bg === 'upload' ? [] : placedMaps.filter((m) => (m.background?.id ?? '') === bg && m.placements.some((p) => p.deviceKey))
        q('#ts-nm-copy').innerHTML = '<option value="">Don\'t copy — start with nothing placed</option>' +
            sources.map((m) => `<option value="${esc(m.id)}">${esc(m.name)} (${m.placements.filter((p) => p.deviceKey).length} placed)</option>`).join('')
        q('#ts-nm-copy').disabled = !sources.length
        q('#ts-nm-copyhint').textContent = sources.length ? 'A one-time copy — afterwards the two maps are independent.'
            : 'Only maps on the same background can be copied from.'
    }
    overlay.addEventListener('change', (e) => {
        if (e.target === file && file.files[0]) overlay.querySelector('input[name="ts-nm-bg"][value="upload"]').checked = true
        refreshCopy()
    })
    refreshCopy()
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey) }
    const onKey = (e) => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', onKey)
    q('#ts-nm-cancel').addEventListener('click', close)
    q('form').addEventListener('submit', async (e) => {
        e.preventDefault()
        const warn = q('#ts-nm-warn')
        const name = q('#ts-nm-name').value.trim()
        const bg = bgChoice()
        if (!name) return q('#ts-nm-name').focus()
        if (bg === 'upload' && !file.files[0]) { warn.hidden = false; warn.textContent = 'Choose an image to upload.'; return }
        q('#ts-nm-ok').disabled = true
        try {
            const created = await api('maps', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    nodes: { start: overlay.querySelector('input[name="ts-nm-start"]:checked').value, exceptions: [] },
                    backgroundId: bg && bg !== 'upload' ? bg : null,
                    copyPositionsFrom: q('#ts-nm-copy').value || null,
                }),
            })
            const upload = bg === 'upload' ? file.files[0] : null
            close()
            state.edit = true
            selectPlan(created.id)
            panel.setStatus(`Created map ${esc(created.name)}. Edit map is on: choose its nodes and drag them in from Not placed yet.`)
            if (upload) await setBackground(created, upload)
        } catch (error) {
            q('#ts-nm-ok').disabled = false
            warn.hidden = false
            warn.innerHTML = explain(error, "Couldn't create the map")
        }
    })
    q('#ts-nm-name').focus()
}

/** Map ▸ Set as default: this map opens when TopoSite loads. */
async function setDefaultMap(m) {
    try {
        await api('settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultMapId: m.id }) })
        panel.setStatus(`${esc(m.name)} now opens when TopoSite loads.`)
    } catch (error) {
        panel.setStatus(explain(error, "Couldn't set the default map"))
    }
    lastLayoutJSON = ''
    reload()
}

function setEdit(on) {
    state.edit = on
    lastLayoutJSON = '' // redraw: dragging and menus follow edit mode
    reload()
}

/** Map ▸ Rename… */
async function renameMap(plan, name) {
    try {
        await api(`maps/${plan.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
        panel.setStatus(`Renamed to ${esc(name)}.`)
    } catch (error) {
        panel.setStatus(explain(error, "Couldn't rename the map"))
    }
    lastLayoutJSON = ''
    reload()
}

/** Drop cached background images (they're re-fetched on the next draw). */
function forgetImage() {
    for (const cached of state.imageUrls.values()) URL.revokeObjectURL(cached.url)
    state.imageUrls.clear()
}

/** Set or replace the current map's background; node positions and scale stay. */
async function setBackground(plan, file, variant = 'light') {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return panel.setStatus('Use a PNG, JPEG or WebP image.')
    if (file.size > 25 * 1024 * 1024) return panel.setStatus('That image is over 25 MB — export a smaller one.')
    panel.setStatus(`Uploading ${esc(file.name)}…`)
    try {
        const bitmap = await createImageBitmap(file)
        const qs = new URLSearchParams({ imgWidthPx: bitmap.width, imgHeightPx: bitmap.height, variant })
        bitmap.close()
        const updated = await api(`maps/${plan.id}/image?${qs}`, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
        forgetImage()
        const which = variant === 'dark' ? 'Dark-mode background' : 'Background'
        panel.setStatus(`${which} of ${esc(plan.name)} set to ${esc(file.name)}. Node positions are unchanged.` +
            (updated.stretched ? " Its proportions don't match where it's drawn on the map, so it's stretched to fit." : ''))
    } catch (error) {
        panel.setStatus(explain(error, 'Background upload failed'))
    }
    lastLayoutJSON = ''
    reload()
}

async function removeBackground(plan) {
    try {
        await api(`maps/${plan.id}/image`, { method: 'DELETE' })
        forgetImage()
        panel.setStatus(`Removed the background of ${esc(plan.name)}. Node positions are unchanged.`)
    } catch (error) {
        panel.setStatus(explain(error, "Couldn't remove the background"))
    }
    lastLayoutJSON = ''
    reload()
}

async function deletePlan(plan) {
    try {
        await api(`maps/${plan.id}`, { method: 'DELETE' })
        forgetImage()
        panel.setStatus(`Deleted ${esc(plan.name)} and its node positions.`)
    } catch (error) {
        panel.setStatus(explain(error, 'Delete failed'))
    }
    reload()
}

function selectPlan(id) {
    state.mapId = id
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
    let armedBg = null
    let nameMode = null // 'rename' | 'export' while the name box is open
    const Panel = L.Control.extend({
        onAdd() {
            const div = L.DomUtil.create('div', 'ts-panel')
            div.innerHTML = `<h1>TopoSite</h1>
                <div class="muted" id="ts-summary">Loading…</div>
                <label class="ts-field"><span>Map</span><select id="ts-plan" title="The map you're looking at (★ = opens when TopoSite loads)"></select></label>
                <button type="button" class="ts-wide" id="ts-edit" aria-pressed="false"
                    title="Turn on to choose this map's nodes, place them and move them. Off, the map is read-only.">Edit map</button>

                <button type="button" class="ts-wide" id="ts-mapmenu" aria-expanded="false" aria-controls="ts-mapitems">Map ▾</button>
                <div class="ts-menu-items" id="ts-mapitems" hidden>
                    <button type="button" id="ts-new" title="Create a new map: name, background, which nodes">New…</button>
                    <button type="button" id="ts-rename" title="Rename the current map">Rename…</button>
                    <button type="button" id="ts-setdef" title="Open this map when TopoSite loads">Set as default</button>
                    <button type="button" id="ts-del" title="Delete the current map, its background and its node positions (click twice)">Delete</button>
                    <button type="button" id="ts-export" title="Download the current map (background, node list and positions) as a .toposite file — you choose the file name">Export…</button>
                    <button type="button" id="ts-import" title="Load a .toposite file as a new map — you review how its nodes match this network first">Import…</button>
                    <input type="file" id="ts-importfile" accept=".toposite,application/json" hidden>
                    <form class="ts-nameform" id="ts-nameform" hidden>
                        <input id="ts-name" maxlength="100" autocomplete="off" aria-label="Map name">
                        <button type="submit" id="ts-nameok">OK</button>
                        <button type="button" id="ts-namecancel">Cancel</button>
                    </form>
                </div>

                <button type="button" class="ts-wide" id="ts-bgmenu" aria-expanded="false" aria-controls="ts-bgitems"
                    title="Set or unset the current map's background image">Background ▾</button>
                <div class="ts-menu-items" id="ts-bgitems" hidden>
                    <button type="button" id="ts-bg" title="Set or replace the current map's background image — node positions stay">Set image…</button>
                    <button type="button" id="ts-bgdark" title="Set or replace the version shown while Z-Wave JS UI is in dark mode">Set dark-mode image…</button>
                    <button type="button" id="ts-bgdel" title="Remove the background images, normal and dark (click twice) — node positions stay">Unset</button>
                    <input type="file" id="ts-bgfile" accept="image/png,image/jpeg,image/webp" hidden>
                    <input type="file" id="ts-bgdarkfile" accept="image/png,image/jpeg,image/webp" hidden>
                </div>

                <button type="button" class="ts-wide" id="ts-refresh"
                    title="Asks Z-Wave JS UI to re-read every node's neighbor list from the controller. The radio pauses for a few seconds; allowed once a minute.">Refresh neighbors</button>
                <div class="muted" id="ts-status"></div>

                <section class="ts-health" id="ts-healthsec" aria-label="Mesh health">
                    <h2>Mesh health <span class="muted" id="ts-healthsum"></span></h2>
                    <ul id="ts-healthlist"></ul>
                </section>

                <section id="ts-editsec" hidden aria-label="Edit this map">
                    <div class="muted">While editing, the zoom, position and layers you leave the map on are saved with it.</div>
                    <h2>Nodes on this map</h2>
                    <div class="ts-rule" role="radiogroup" aria-label="Starting rule">
                        <label title="Every node is shown except the unticked ones; nodes added to Z-Wave later appear"><input type="radio" name="ts-start" value="include"> Include all</label>
                        <label title="Only the ticked nodes are shown; nodes added to Z-Wave later stay hidden"><input type="radio" name="ts-start" value="exclude"> Exclude all</label>
                    </div>
                    <div class="ts-quick" aria-label="Show only">
                        <span class="muted">Show only:</span>
                        <button type="button" data-q="all">All</button>
                        <button type="button" data-q="none">None</button>
                        <button type="button" data-q="mains" title="Always-listening (mains) nodes and the controller">Mains</button>
                        <button type="button" data-q="battery" title="Battery nodes, including FLiRS">Battery</button>
                        <select id="ts-qloc" aria-label="Show only one location"></select>
                    </div>
                    <input id="ts-nfilter" type="search" placeholder="Filter by name or location" aria-label="Filter nodes">
                    <div id="ts-nodelist" class="ts-nodelist"></div>
                    <div id="ts-traysec">
                        <h2>Not placed yet</h2>
                        <div class="muted" id="ts-trayhint"></div>
                        <div id="ts-tray" class="ts-tray"></div>
                    </div>
                </section>`
            L.DomEvent.disableClickPropagation(div)
            L.DomEvent.disableScrollPropagation(div)
            els = Object.fromEntries(['healthsec', 'healthsum', 'healthlist', 'summary', 'plan', 'edit', 'setdef', 'editsec', 'nodelist', 'nfilter', 'qloc', 'traysec', 'trayhint', 'tray',
                'mapmenu', 'mapitems', 'new', 'rename', 'del', 'export', 'import', 'importfile',
                'nameform', 'name', 'nameok', 'namecancel', 'bgmenu', 'bgitems', 'bg', 'bgdark', 'bgdel', 'bgfile', 'bgdarkfile',
                'refresh', 'status'].map((k) => [k, div.querySelector(`#ts-${k}`)]))

            // Menu buttons open and close their item lists
            const menu = (btn, items, label) => btn.addEventListener('click', () => {
                items.hidden = !items.hidden
                btn.setAttribute('aria-expanded', !items.hidden)
                btn.textContent = `${label} ${items.hidden ? '▾' : '▴'}`
                if (items.hidden) closeName()
            })
            menu(els.mapmenu, els.mapitems, 'Map')
            menu(els.bgmenu, els.bgitems, 'Background')

            els.plan.addEventListener('change', () => selectPlan(els.plan.value))

            // Rename uses a name box in the menu; New… opens its own dialog
            // Export reuses it for the file name, prefilled with the default
            const openName = (mode) => {
                nameMode = mode
                els.nameform.hidden = false
                const exporting = mode === 'export'
                els.name.value = exporting ? exportName(currentMap()) : (currentMap()?.name ?? '')
                els.name.placeholder = exporting ? 'File name' : 'New name'
                els.name.setAttribute('aria-label', exporting ? 'Export file name' : 'Map name')
                els.name.maxLength = exporting ? 200 : 100
                els.nameok.textContent = exporting ? 'Download' : 'Rename'
                els.name.focus()
                // select the name part, so typing replaces it but keeps .toposite
                els.name.setSelectionRange(0, exporting ? els.name.value.replace(/\.toposite$/i, '').length : els.name.value.length)
            }
            const closeName = () => { nameMode = null; els.nameform.hidden = true }
            els.new.addEventListener('click', () => { closeName(); openNewMap() })
            els.setdef.addEventListener('click', () => { if (currentMap()) setDefaultMap(currentMap()) })
            els.edit.addEventListener('click', () => setEdit(!state.edit))
            els.rename.addEventListener('click', () => { if (currentMap() && !currentMap().builtin) openName('rename') })
            els.namecancel.addEventListener('click', closeName)
            els.name.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeName() })
            els.nameform.addEventListener('submit', (e) => {
                e.preventDefault()
                const name = els.name.value.trim()
                if (!name) return els.name.focus()
                const mode = nameMode
                closeName()
                if (mode === 'rename' && currentMap()) renameMap(currentMap(), name)
                else if (mode === 'export' && currentMap()?.layout === 'placed') exportMap(currentMap(), name)
            })

            // Two clicks to delete, instead of a confirm() dialog
            els.del.addEventListener('click', () => {
                const plan = currentMap()
                if (!plan || plan.builtin) return
                if (armedDelete !== plan.id) {
                    armedDelete = plan.id
                    els.del.textContent = `Really delete "${plan.name}"?`
                    setTimeout(() => { armedDelete = null; els.del.textContent = 'Delete' }, 4000)
                    return
                }
                armedDelete = null
                els.del.textContent = 'Delete'
                deletePlan(plan)
            })

            // Background: set (normal / dark-mode) or unset
            els.bg.addEventListener('click', () => els.bgfile.click())
            els.bgdark.addEventListener('click', () => els.bgdarkfile.click())
            for (const [input, variant] of [[els.bgfile, 'light'], [els.bgdarkfile, 'dark']]) {
                input.addEventListener('change', () => {
                    const file = input.files[0]
                    input.value = ''
                    const plan = currentMap()
                    if (file && plan?.layout === 'placed') setBackground(plan, file, variant)
                })
            }
            els.bgdel.addEventListener('click', () => {
                const plan = currentMap()
                if (!plan?.background) return
                if (armedBg !== plan.id) {
                    armedBg = plan.id
                    els.bgdel.textContent = 'Really unset the background?'
                    setTimeout(() => { armedBg = null; els.bgdel.textContent = 'Unset' }, 4000)
                    return
                }
                armedBg = null
                els.bgdel.textContent = 'Unset'
                removeBackground(plan)
            })

            els.export.addEventListener('click', () => { if (currentMap()?.layout === 'placed') openName('export') })
            els.import.addEventListener('click', () => els.importfile.click())
            els.importfile.addEventListener('change', () => {
                const file = els.importfile.files[0]
                els.importfile.value = ''
                if (file) importPreview(file)
            })

            els.refresh.addEventListener('click', () => refreshNeighbors(els.refresh))
            // Mesh health is one layer: the pane list shows and hides with the map markings
            const syncHealth = () => { els.healthsec.hidden = !map.hasLayer(layers.health) }
            map.on('layeradd layerremove', (e) => { if (e.layer === layers.health) syncHealth() })
            syncHealth()
            // Mesh health list: click a node to jump to it
            els.healthlist.addEventListener('click', (e) => {
                const li = e.target.closest('[data-y]')
                if (li) map.setView([Number(li.dataset.y), Number(li.dataset.x)], Math.max(map.getZoom(), state.labelZoom))
            })

            // Node list: ticking shows a node on this map, unticking hides it
            els.nodelist.addEventListener('change', (e) => {
                const key = e.target.dataset.key
                const m = currentMap()
                if (!key || !m) return
                const keys = shownKeys(m)
                if (e.target.checked) keys.add(key)
                else keys.delete(key)
                setShown(m, keys)
            })
            // Starting rule: switching keeps what's shown now; it changes what happens to new nodes
            div.querySelector('.ts-rule').addEventListener('change', (e) => {
                const m = currentMap()
                if (m && e.target.value !== m.nodes.start) setShown(m, shownKeys(m), e.target.value)
            })
            // Quick selects replace the shown set in one go
            const quick = (pick) => {
                const m = currentMap()
                if (m) setShown(m, new Set(state.nodes.filter((n) => n.key && pick(n)).map((n) => n.key)))
            }
            div.querySelector('.ts-quick').addEventListener('click', (e) => {
                const q = e.target.dataset.q
                if (q === 'all') quick(() => true)
                else if (q === 'none') quick(() => false)
                else if (q === 'mains') quick((n) => n.role !== 'sleeping')
                else if (q === 'battery') quick((n) => n.role === 'sleeping')
            })
            els.qloc.addEventListener('change', () => {
                const loc = els.qloc.value
                els.qloc.value = ''
                if (loc) quick((n) => (n.location || NO_LOC) === loc)
            })
            els.nfilter.addEventListener('input', () => filterNodeList())

            // Tray: drag a node onto the map, or click it to drop it in the middle of the view
            els.tray.addEventListener('dragstart', (e) => {
                const key = e.target.closest('[data-key]')?.dataset.key
                if (key) e.dataTransfer.setData('text/x-toposite-node', key)
            })
            els.tray.addEventListener('click', (e) => {
                const key = e.target.closest('[data-key]')?.dataset.key
                const m = currentMap()
                const n = state.nodes.find((x) => x.key === key)
                if (!n || m?.layout !== 'placed') return
                const c = map.getCenter()
                placeNode(m, n, c.lng, m.heightPx - c.lat)
            })
            return div
        },
    })
    paneBody().appendChild(new Panel().onAdd(map))
    return {
        setStatus(html) { els.status.innerHTML = html },
        setSummary(nodes) {
            const dead = nodes.filter((n) => n.status !== 'ok').length
            const withNb = nodes.filter((n) => n.neighbors.length).length
            els.summary.textContent = `${nodes.length} nodes · ${dead} dead/failed · neighbors known for ${withNb}`
        },
        setMaps(maps, selectedId) {
            const sel = maps.find((m) => m.id === selectedId)
            const placedMap = sel?.layout === 'placed'
            const defaultId = state.layout.settings?.defaultMapId
            els.setdef.disabled = !sel || sel.id === defaultId
            els.edit.disabled = !sel
            els.edit.setAttribute('aria-pressed', String(state.edit))
            els.edit.textContent = state.edit ? 'Editing — click when done' : 'Edit map'
            els.rename.disabled = !sel || !!sel.builtin
            els.del.disabled = !sel || !!sel.builtin
            els.export.disabled = !placedMap
            els.bgmenu.disabled = !placedMap
            els.bgdel.disabled = !sel?.background
            els.plan.disabled = maps.length === 0
            // Each map keeps its own node positions — show how many, so a map with
            // none doesn't look like the positions were lost.
            const count = (m) => (m.placements ?? []).filter((pl) => pl.deviceKey).length
            els.plan.innerHTML = maps.map((m) => `<option value="${esc(m.id)}">${m.id === defaultId ? '★ ' : ''}${esc(m.name)}${
                m.layout === 'graph' ? ' (automatic layout)' : ` (${count(m)} placed)`}</option>`).join('')
            if (selectedId) els.plan.value = selectedId
        },
        setHealth(items, oneWay) {
            const bad = items.filter((i) => i.level === 'bad').length
            els.healthsum.textContent = items.length || oneWay
                ? `— ${bad} problem${bad === 1 ? '' : 's'}, ${items.length - bad} warning${items.length - bad === 1 ? '' : 's'}${oneWay ? `, ${oneWay} one-way` : ''}`
                : '— nothing flagged'
            els.healthlist.innerHTML = items.map((i) => `<li${i.pos ? ` data-y="${i.pos[0]}" data-x="${i.pos[1]}" title="Show on the map"` : ' title="Not on this map"'}>
                <span class="ts-dot" style="background:${HEALTH_COLORS[i.level]}"></span>
                <span><b>${esc(i.name)}</b> <span class="muted">${i.reasons.map(esc).join(' · ')}</span></span></li>`).join('')
        },
        /** Edit sections: the map's node list and, on a placed map, the unplaced tray. */
        setEdit(m, unplaced) {
            els.editsec.hidden = !state.edit || !m
            if (els.editsec.hidden) return
            for (const r of els.editsec.querySelectorAll('input[name="ts-start"]')) r.checked = r.value === m.nodes.start
            const nodes = [...state.nodes].filter((n) => n.key).sort((a, b) => a.name.localeCompare(b.name))
            const locs = [...new Set(nodes.map((n) => n.location || ''))].sort()
            els.qloc.innerHTML = '<option value="">Location…</option>' + locs.map((l) =>
                `<option value="${l ? esc(l) : NO_LOC}">${l ? esc(l) : '(no location)'}</option>`).join('')
            els.nodelist.innerHTML = nodes.map((n) => `<label data-text="${esc(`${n.name} ${n.location ?? ''}`.toLowerCase())}">
                <input type="checkbox" data-key="${esc(n.key)}"${isShown(m, n) ? ' checked' : ''}>
                <span class="ts-shape" style="color:${nodeColor(n)}">${SHAPE_CHAR[n.role] ?? '■'}</span>
                <span>${esc(nodeLabel(n))} <span class="muted">${n.location ? `${esc(n.location)} · ` : ''}node ${n.id}</span></span></label>`).join('')
            filterNodeList()
            const shownCount = nodes.filter((n) => isShown(m, n)).length
            els.nodelist.setAttribute('aria-label', `${shownCount} of ${nodes.length} nodes shown`)

            els.traysec.hidden = m.layout !== 'placed'
            if (els.traysec.hidden) return
            els.trayhint.textContent = unplaced.length
                ? 'Drag onto the map, or click to drop in the middle of the view.' : 'Every shown node is placed.'
            els.tray.innerHTML = unplaced.map((n) => `<button type="button" draggable="true" data-key="${esc(n.key)}"
                title="Drag onto the map, or click to drop it in the middle of the view">
                <span class="ts-shape" style="color:${nodeColor(n)}">${SHAPE_CHAR[n.role] ?? '■'}</span> ${esc(nodeLabel(n))}</button>`).join('')
        },
    }
}

const SHAPE_CHAR = { controller: '★', listening: '⬢', sleeping: '■' }
const NO_LOC = '\u2205none' // value of the "(no location)" choice; Z-Wave JS UI locations never start with ∅

/** Hide node-list rows that don't match the filter box. */
function filterNodeList() {
    const f = document.getElementById('ts-nfilter').value.trim().toLowerCase()
    for (const row of document.querySelectorAll('#ts-nodelist > label')) row.hidden = !!f && !row.dataset.text.includes(f)
}

// Dropping a tray node on the map places it there
map.getContainer().addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/x-toposite-node')) e.preventDefault()
})
map.getContainer().addEventListener('drop', (e) => {
    const key = e.dataTransfer.getData('text/x-toposite-node')
    const m = currentMap()
    const n = state.nodes.find((x) => x.key === key)
    if (!n || m?.layout !== 'placed' || !state.edit) return
    e.preventDefault()
    const { lat, lng } = map.mouseEventToLatLng(e)
    placeNode(m, n, lng, m.heightPx - lat)
})

/** The right-hand pane (index.html) that holds the controls and the legend. */
function paneBody() {
    return document.getElementById('ts-pane')
}

/**
 * Resizable right-hand pane: drag the handle on its left edge (or use the arrow
 * keys on it). Everything in the pane is sized in em, and the pane's font size
 * follows its width, so the contents scale up and down with it. Width is
 * remembered per browser.
 */
function setupPane() {
    const pane = paneBody()
    const handle = document.getElementById('ts-resizer')
    const MIN = 220
    const max = () => Math.max(MIN, Math.round(window.innerWidth * 0.6))
    let width = 0
    let frame = 0
    const apply = (w) => {
        width = Math.round(Math.min(Math.max(w, MIN), max()))
        pane.style.width = `${width}px`
        pane.style.fontSize = `${Math.min(Math.max(width / 22, 11), 22).toFixed(1)}px`
        handle.setAttribute('aria-valuenow', width)
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => map.invalidateSize({ pan: false }))
    }
    apply(Number(readPref(PANE_KEY)) || 300)

    handle.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        handle.setPointerCapture(e.pointerId)
        handle.classList.add('drag')
        const startX = e.clientX
        const startW = width
        const move = (ev) => apply(startW + (startX - ev.clientX))
        const up = () => {
            handle.classList.remove('drag')
            handle.removeEventListener('pointermove', move)
            handle.removeEventListener('pointerup', up)
            writePref(PANE_KEY, width)
        }
        handle.addEventListener('pointermove', move)
        handle.addEventListener('pointerup', up)
    })
    handle.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 50 : 10
        if (e.key === 'ArrowLeft') apply(width + step)
        else if (e.key === 'ArrowRight') apply(width - step)
        else return
        e.preventDefault()
        writePref(PANE_KEY, width)
    })
    window.addEventListener('resize', () => apply(width))
}

/** "Layers…" button on the map (Google Maps style): opens a small list of layer toggles. */
function addLayersButton() {
    const Ctl = L.Control.extend({
        onAdd() {
            const div = L.DomUtil.create('div', 'ts-layers')
            div.innerHTML = '<button type="button" class="ts-layers-btn" aria-expanded="false" ' +
                'title="Choose what\'s drawn on the map">Layers…</button><div class="ts-layers-pop" hidden></div>'
            const btn = div.querySelector('button')
            const pop = div.querySelector('.ts-layers-pop')
            const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false') }
            btn.addEventListener('click', () => {
                if (!pop.hidden) return close()
                pop.innerHTML = LAYER_CHOICES.map(([label, layer], i) =>
                    `<label><input type="checkbox" data-i="${i}"${map.hasLayer(layer) ? ' checked' : ''}> ${esc(label)}</label>`).join('')
                pop.hidden = false
                btn.setAttribute('aria-expanded', 'true')
            })
            pop.addEventListener('change', (e) => {
                const layer = LAYER_CHOICES[e.target.dataset.i]?.[1]
                if (!layer) return
                if (e.target.checked) layer.addTo(map)
                else map.removeLayer(layer)
            })
            document.addEventListener('pointerdown', (e) => { if (!div.contains(e.target)) close() })
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })
            L.DomEvent.disableClickPropagation(div)
            L.DomEvent.disableScrollPropagation(div)
            return div
        },
    })
    new Ctl({ position: 'topright' }).addTo(map)
}

function addLegend() {
    const Legend = L.Control.extend({
        onAdd() {
            const div = L.DomUtil.create('div', 'ts-panel ts-legend')
            const shapes = [['★', 'Controller'], ['⬢', 'Mains (repeats)'], ['■', 'Battery (sleeps)']]
            // Always starts hidden; not remembered between visits (user, 2026-10-10)
            const open = false
            div.innerHTML = `<button type="button" class="ts-legend-toggle" aria-expanded="${open}" aria-controls="ts-legend-body"
                    title="Show or hide the legend">Legend</button>
                <div id="ts-legend-body"${open ? '' : ' hidden'}>
                <h2>Shape</h2>${shapes.map(([s, t]) => `<div><span>${s}</span>${t}</div>`).join('')}
                <h2>Node color = hops</h2>${HOP_LEGEND.map(([t, c]) => `<div><span class="sw" style="background:${c}"></span>${t}</div>`).join('')}
                <h2>Link color = data rate</h2>${RATE_LEGEND.map(([t, c]) => `<div><span class="ln" style="border-color:${c}"></span>${t}</div>`).join('')}
                <div><span class="ln" style="border-top-style:dashed;border-color:#888"></span>backup route</div>
                <div><span class="ts-gsw"></span>repeater hidden or not placed on this map</div>
                <h2>Battery level (layer)</h2>
                <div><span class="ts-batt ts-batt-ok ts-inline">87%</span>last reported level</div>
                <div><span class="ts-batt ts-batt-warn ts-inline">${BATTERY_LOW.warn}%</span>low (≤ ${BATTERY_LOW.warn}%)</div>
                <div><span class="ts-batt ts-batt-bad ts-inline">${BATTERY_LOW.bad}%</span>very low (≤ ${BATTERY_LOW.bad}%)</div>
                <h2>Mesh health</h2>
                <div><span class="ts-ring" style="border-color:${HEALTH_COLORS.bad}"></span>problem (isolated, failed hop, very weak signal)</div>
                <div><span class="ts-ring" style="border-color:${HEALTH_COLORS.warn}"></span>warning (few neighbors, weak signal, backup route)</div>
                <div><span class="ts-hopwarn ts-warn ts-inline">!</span>weak hop on a route</div>
                <div><span class="ln" style="border-top-style:dotted;border-color:${HEALTH_COLORS.warn}"></span>one-way neighbor entry</div>
                <div><span class="ts-gsw ts-gsw-approx"></span>…at an approximate spot</div>
                </div>`
            const btn = div.querySelector('.ts-legend-toggle')
            const body = div.querySelector('#ts-legend-body')
            btn.addEventListener('click', () => {
                const nowOpen = body.hidden
                body.hidden = !nowOpen
                btn.setAttribute('aria-expanded', nowOpen)
            })
            return div
        },
    })
    paneBody().appendChild(new Legend().onAdd(map))
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

/** Placeholder background for placed maps without an image: a light 100-px grid. */
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

// SN: 00002
