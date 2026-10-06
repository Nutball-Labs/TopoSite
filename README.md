# TopoSite

TopoSite shows where your network and Z-Wave devices physically are. It places
IP devices and Z-Wave nodes as icons on your own floor plan or background
image, and draws the Z-Wave mesh-neighbor links between nodes. The way each
link is drawn shows the health of the mesh, so problems stand out at a glance:
weak or one-way links, nodes with too few neighbors, and dead or isolated nodes.

It is for home-automation and small-network admins who know *what* is on their
network but not *where* it is. TopoSite discovers devices from the network
(ARP, DHCP leases, nmap) and from Z-Wave JS UI / openHAB, so you only have to
drag each one to its spot on the map.

---

## Features (planned)

- **IP device map** — discover hosts and place them on a floor plan
- **Z-Wave mesh map** — node locations plus neighbor links from Z-Wave JS UI or openHAB
- **Mesh health at a glance** — link styling flags weak, one-way or missing links and dead or isolated nodes
- **Your own background** — upload a floor plan, site plan or any image
- **Integrations** — openHAB binding and pfSense package

---

## Requirements

**Platform:** Linux. Primary development and testing on Alma Linux 9.x / RHEL 9.

- Python 3.9+
- nmap (optional, for active discovery)

---

## Installing from Source

```bash
git clone git@github.com:Nutball-Labs/TopoSite.git
cd TopoSite
python3 -m venv .venv
. .venv/bin/activate
pip install -e .
```

---

## Usage

*(Fill in when implemented.)*

---

## Project Status

**v0.1.0 — Scaffolding phase.** Application code not yet written.

---

## Development Paradigm

TopoSite is built the same way as its sister projects
[TagGoblin](https://github.com/Nutball-Labs/TagGoblin),
[FlickImp](https://github.com/Nutball-Labs/FlickImp),
[CamClops](https://github.com/Nutball-Labs/CamClops) — a collaboration between
an experienced Linux sysadmin and Claude (Anthropic's AI), which handles the
implementation under continuous human guidance and review. The architecture,
feature decisions, and real-world testing are entirely human-driven.

---

## License

GNU General Public License v3 — see [LICENSE](LICENSE).
Copyright (C) 2026 Nutball Labs / Stephen Berg

<!-- SN: 00001 -->
