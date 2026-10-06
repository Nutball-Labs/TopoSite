# TopoSite — Project Brief
## For use at the start of new AI sessions to restore context quickly

---

## What It Is

TopoSite is a Z-Wave JS UI plugin (Node.js, ES modules) that places Z-Wave
nodes on a floor plan or other background image, using Z-Wave JS UI's own
shapes and colors, and draws neighbor and route links styled to flag mesh
problems (weak or one-way links, nodes with too few neighbors, dead or isolated
nodes). The map page is Leaflet, served by the plugin under `/toposite/`.
Zigbee (Zigbee2MQTT) and IP layers are planned for later, on the same map,
each toggled independently.

Target: wherever Z-Wave JS UI runs (Docker, Home Assistant add-on, bare Node).
Dev machine: Alma Linux 9.x.

---

## Developer Background

- Experienced Perl, Python3, bash scripting; Linux sysadmin for government entity.
- JavaScript/Node idioms need help.
- Full root on Alma Linux 9.x dev machine. VSCode + vim. Private GitHub repo.
- 40+ years sysadmin experience. Do not over-explain Linux basics.
- Same development paradigm and conventions as the CamClops project.

---

## Source File Map

| Path | Role |
|---|---|
| `index.js` | Plugin entry; routes under `/toposite/` |
| `lib/mesh.js` | Only reader of Z-Wave JS UI's internal `ZUINode`; maps to TopoSite node model |
| `public/` | Leaflet map page *(planned)* |
| `test/` | `node:test` tests (`npm test`) |

---

## Key Design Decisions

- Z-Wave JS UI plugin is the product (2026-10-06); Python core and openHAB-binding-first plans dropped.
- Z-Wave first; Zigbee and IP layers later.
- Three zoom levels designed in from the start: satellite → floor plan → 360° room panorama (links exit through walls toward neighbors; click to walk a route room by room). Built floor plan → panoramas → satellite. Positions stored in plan coordinates + height; satellite and panorama views are derived. Full design: `ROADMAP.md`.
- Node icons follow Z-Wave JS UI: hexagon = mains, square = battery, star = controller; node color = hops; link color = data rate; link dash = route kind. Full table in CLAUDE.md.
- Plugin routes bypass Z-Wave JS UI auth — read-only until TopoSite has its own auth.
- Visual details (mesh-health flags) settled after the user reviews a rendered map.
- Name: TopoSite / `toposite`.

---

## SN Convention

Every source file carries a serial number at the bottom:
- `// SN: 00001` — JavaScript
- `# SN: 00001` — shell, YAML
- `<!-- SN: 00001 -->` — Markdown, HTML

HWM is currently `00001`. Bump on change; increment HWM on each release.
Run: `scripts/sn_audit.sh` to audit.

---

## GitHub

Repo: `git@github.com:Nutball-Labs/TopoSite.git`
All work on `main` branch.
Commit format: `"Fix/Add/Update description — TopoSite vX.Y.Z (SN NNNNN)"`

---

## Current Status

Version 0.1.0 — plugin skeleton with `GET /toposite/api/nodes` and unit tests;
not yet run inside a live Z-Wave JS UI. Map page is next.

<!-- SN: 00001 -->
