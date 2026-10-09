// app.js — TopoSite map page (Leaflet, simple/pixel CRS).
//
// Reads /toposite/api/nodes, places nodes with a temporary auto-layout and
// draws routes and neighbor links in Z-Wave JS UI's visual language.
//
// "Refresh neighbors" does NOT go through a TopoSite route: TopoSite routes
// run before Z-Wave JS UI's login check. It calls Z-Wave JS UI's own socket.io
// API (refreshNeighbors), which Z-Wave JS UI authenticates, rate-limits
// (once per 60 s) and runs with the radio briefly paused.

import {
    autoLayout, buildLinks, nodeColor, nodeLabel, mainRoute, rateColor, rateLabel,
    rssiLabel, HOP_LEGEND, RATE_LEGEND,
} from './mesh-view.js'

/* global L, io */

const SIZE = 1000
const POLL_MS = 30_000
const REFRESH_COOLDOWN_MS = 60_000
// Z-Wave JS UI's root, as the browser sees it (keeps working behind a path prefix)
const ZUI_BASE = location.pathname.replace(/toposite\/.*$/, '')

const map = L.map('map', { crs: L.CRS.Simple, minZoom: -3, maxZoom: 3, zoomSnap: 0.25, attributionControl: false })
const bounds = [[0, 0], [SIZE, SIZE]]
map.fitBounds(bounds, { padding: [20, 20] })
const labelZoom = map.getZoom() + 0.75

L.imageOverlay(gridImage(), bounds, { opacity: 0.6 }).addTo(map)

const layers = {
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
}, { collapsed: false, position: 'topright' }).addTo(map)

map.on('zoomend', applyLabelZoom)
applyLabelZoom()

const statusPanel = addStatusPanel()
addLegend()

let lastJSON = ''
loadNodes()
setInterval(loadNodes, POLL_MS)

// ---------------------------------------------------------------- data

async function loadNodes() {
    try {
        const res = await fetch('api/nodes', { cache: 'no-store' })
        const body = await res.json()
        if (!body.success) throw new Error(body.message || 'API error')
        const json = JSON.stringify(body.data)
        if (json !== lastJSON) {
            lastJSON = json
            draw(body.data)
        }
        statusPanel.setSummary(body.data)
    } catch (error) {
        statusPanel.setStatus(`Can't read nodes: ${error.message}`)
    }
}

// ---------------------------------------------------------------- drawing

function draw(nodes) {
    for (const g of Object.values(layers)) g.clearLayers()
    const pos = autoLayout(nodes, SIZE)
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const name = (id) => esc(byId.get(id)?.name ?? `NodeID ${id}`)

    for (const l of buildLinks(nodes)) {
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

    for (const n of nodes) {
        const p = pos.get(n.id)
        if (!p) continue
        L.marker(p, { icon: nodeIcon(n), keyboard: false })
            .bindTooltip(nodeTooltip(n), { direction: 'top', offset: [0, -14] })
            .addTo(layers.nodes)
    }
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

function nodeTooltip(n) {
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
    return lines.join('<br>')
}

function applyLabelZoom() {
    map.getContainer().classList.toggle('ts-labels', map.getZoom() >= labelZoom)
}

// ---------------------------------------------------------------- refresh neighbors

async function refreshNeighbors(button) {
    button.disabled = true
    const done = (msg, cooldown = false) => {
        statusPanel.setStatus(msg)
        if (cooldown) setTimeout(() => { button.disabled = false }, REFRESH_COOLDOWN_MS)
        else button.disabled = false
    }

    let auth
    try {
        const res = await fetch(`${ZUI_BASE}api/auth-enabled`, { cache: 'no-store' })
        const authEnabled = (await res.json()).data === true
        if (authEnabled) {
            const token = storedToken()
            if (!token) {
                return done(`Log in to <a href="${ZUI_BASE}" target="_blank">Z-Wave JS UI</a> in this browser first, then try again.`)
            }
            auth = { token }
        }
    } catch (error) {
        return done(`Can't reach Z-Wave JS UI: ${error.message}`)
    }

    statusPanel.setStatus('Connecting to Z-Wave JS UI…')
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
            : `Can't connect to Z-Wave JS UI: ${error.message}`
        return done(msg)
    }

    statusPanel.setStatus('Reading neighbors from the controller (radio paused briefly)…')
    const result = await new Promise((resolve) => {
        socket.timeout(120_000).emit('ZWAVE_API', { api: 'refreshNeighbors', args: [] }, (err, response) => {
            resolve(err ? { success: false, message: 'timed out waiting for Z-Wave JS UI' } : response)
        })
    })
    socket.disconnect()

    if (!result?.success) return done(`Refresh failed: ${esc(result?.message ?? 'unknown error')}`, /60 seconds/.test(result?.message ?? ''))
    await loadNodes()
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

function addStatusPanel() {
    let summaryEl, statusEl
    const Panel = L.Control.extend({
        onAdd() {
            const div = L.DomUtil.create('div', 'ts-panel')
            div.innerHTML = `<h1>TopoSite</h1>
                <div class="muted" id="ts-summary">Loading…</div>
                <div style="margin-top:6px"><button type="button" id="ts-refresh"
                    title="Asks Z-Wave JS UI to re-read every node's neighbor list from the controller. The radio pauses for a few seconds; allowed once a minute.">Refresh neighbors</button></div>
                <div class="muted" id="ts-status"></div>`
            L.DomEvent.disableClickPropagation(div)
            summaryEl = div.querySelector('#ts-summary')
            statusEl = div.querySelector('#ts-status')
            const btn = div.querySelector('#ts-refresh')
            btn.addEventListener('click', () => refreshNeighbors(btn))
            return div
        },
    })
    new Panel({ position: 'topleft' }).addTo(map)
    return {
        setStatus(html) { statusEl.innerHTML = html },
        setSummary(nodes) {
            const dead = nodes.filter((n) => n.status !== 'ok').length
            const withNb = nodes.filter((n) => n.neighbors.length).length
            summaryEl.textContent = `${nodes.length} nodes · ${dead} dead/failed · neighbors known for ${withNb}`
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
                <div><span class="ln" style="border-top-style:dashed;border-color:#888"></span>backup route</div>`
            return div
        },
    })
    new Legend({ position: 'bottomleft' }).addTo(map)
}

// ---------------------------------------------------------------- helpers

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

/** Placeholder background until floor plans can be uploaded: a light grid. */
function gridImage() {
    const step = SIZE / 20
    let lines = ''
    for (let i = 0; i <= SIZE; i += step) {
        lines += `<line x1="${i}" y1="0" x2="${i}" y2="${SIZE}"/><line x1="0" y1="${i}" x2="${SIZE}" y2="${i}"/>`
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><g stroke="#999" stroke-width="1" opacity="0.35">${lines}</g></svg>`
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// SN: 00001
