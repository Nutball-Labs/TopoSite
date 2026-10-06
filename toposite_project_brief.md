# TopoSite — Project Brief
## For use at the start of new AI sessions to restore context quickly

---

## What It Is

TopoSite is a physical mapping tool for network and Z-Wave devices. A Python
core service (FastAPI + Leaflet web UI) discovers IP devices (ARP, DHCP
leases, nmap), Z-Wave nodes (Z-Wave JS UI WebSocket / openHAB) and Zigbee
devices (Zigbee2MQTT network map over MQTT / openHAB). The user
drags each device onto a floor plan or other background image. A second map
view shows Z-Wave nodes in place with their mesh-neighbor links, styled to
flag mesh problems (weak or one-way links, nodes with too few neighbors, dead
or isolated nodes). Integrations
ship as an openHAB binding and a pfSense package.

Target OS: Alma Linux 9.x (RHEL 9 based).

---

## Developer Background

- Experienced Perl, Python3, bash scripting; Linux sysadmin for government entity.
- Python is home turf; Java (openHAB) and PHP (pfSense) need idiom help.
- Full root on Alma Linux 9.x dev machine. VSCode + vim. Private GitHub repo.
- 40+ years sysadmin experience. Do not over-explain Linux basics.
- Same development paradigm and conventions as the CamClops project.

---

## Source File Map

| Path | Role |
|---|---|
| `src/toposite/__init__.py` | Package root; `__version__` |
| `src/toposite/` | FastAPI service, discovery, data store *(planned)* |
| `src/toposite/web/` | Leaflet front end *(planned)* |
| `pfsense/` | pfSense package, PHP *(planned)* |
| *(openhab-addons worktree)* | openHAB binding, Java — via `/template-openhab` |

---

## Key Design Decisions

- Python core, FastAPI REST API, Leaflet (`L.CRS.Simple`) over a background image.
- One map with three independently toggled layers: IP | Z-Wave | Zigbee. A device goes on the layer of its transport — MQTT devices over IP (Tasmota, ESPHome) are on the IP layer.
- Discovery first; manual entry is the fallback.
- Z-Wave node icons show battery vs mains power at a glance (mains = always-listening repeater; battery = sleeps, doesn't route).
- Z-Wave map copies Z-Wave JS UI's visual language: hexagon = mains, square = battery, star = controller; node color = hops; link color = data rate; link dash = route kind. Full table in CLAUDE.md.
- openHAB + pfSense integrations; check_mk dropped (NagVis covers it).
- Name: TopoSite / `toposite` / `org.openhab.binding.toposite` / `pfSense-pkg-TopoSite`.

---

## SN Convention

Every source file carries a serial number at the bottom:
- `# SN: 00001` — Python, shell, TOML, YAML
- `// SN: 00001` — Java, JavaScript, PHP
- `<!-- SN: 00001 -->` — Markdown, HTML

HWM is currently `00001`. Bump on change; increment HWM on each release.
Run: `scripts/sn_audit.sh` to audit.

---

## Hard Dependencies

| Dep | Install | Required For |
|---|---|---|
| Python 3.9+ | `python3` (Alma base) | All |
| FastAPI, uvicorn | `pip install -e .` | Core service |
| nmap | `dnf install nmap` | Optional active discovery |

---

## GitHub

Repo: `git@github.com:Nutball-Labs/TopoSite.git`
All work on `main` branch.
Commit format: `"Fix/Add/Update description — TopoSite vX.Y.Z (SN NNNNN)"`

---

## Current Status

Version 0.1.0 — scaffolding only; no application code written yet.

<!-- SN: 00001 -->
