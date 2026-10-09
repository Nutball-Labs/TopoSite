# TopoSite

TopoSite is a [Z-Wave JS UI](https://github.com/zwave-js/zwave-js-ui) plugin
that shows where your Z-Wave devices physically are. It places your nodes as
icons on your own floor plan or background image and draws the mesh links
between them. The way each link is drawn shows the health of the mesh, so
problems stand out at a glance: weak or one-way links, nodes with too few
neighbors, and dead or isolated nodes.

Z-Wave JS UI's own mesh graph shows *how* nodes connect; TopoSite shows that
same mesh laid over *where* the devices actually are, so you can see which
room needs a repeater.

---

## Features (planned)

- **Z-Wave mesh on your floor plan** — node locations plus neighbor and route links
- **Battery vs mains at a glance** — node icons show the power source, since mains-powered
  nodes are always listening and repeat traffic for the mesh while battery nodes sleep and don't route
- **Familiar symbols** — the same shapes and colors as Z-Wave JS UI's mesh view
  (hexagon = mains, square = battery, star = controller; color = hop count; link color = data rate)
- **Mesh health at a glance** — link styling flags weak, one-way or missing links and dead or isolated nodes
- **Your own background** — upload a floor plan, site plan or any image
- **Zoom from the sky into a room** — satellite view of the property, then the floor plan, then a
  360° photo of a single room with devices placed where they really are and links shown leaving
  through the walls toward their neighbors (see [ROADMAP.md](ROADMAP.md))
- **Later:** Zigbee (Zigbee2MQTT) and IP device layers on the same map, each toggled independently

---

## Requirements

- Z-Wave JS UI **11.6.0 or newer** (older releases load plugins a different way)
- Node.js 20 or newer (the official Z-Wave JS UI Docker image already has it)

---

## Installing

```bash
cd /path/to/zwave-js-ui/store/plugins     # Docker: the store volume
git clone git@github.com:Nutball-Labs/TopoSite.git toposite
```

Then in Z-Wave JS UI: **Settings → General → Plugins**, add the path to
TopoSite's `index.js` as Z-Wave JS UI sees it (Docker:
`/usr/src/app/store/plugins/toposite/index.js`), press **Enter** so it turns
into a chip, and save. The path must end in `index.js` — a bare directory
won't load.

To check it loaded, turn on **Settings → General → Log enabled** and look for
`Successfully loaded plugin index.js` in Z-Wave JS UI's console output
(`docker logs zwave-js-ui`).

TopoSite's pages are served by Z-Wave JS UI under `/toposite/`.

> **Note:** Z-Wave JS UI's login does not cover plugin pages. Don't expose
> Z-Wave JS UI to untrusted networks while TopoSite is installed.

---

## Usage

*(Fill in when implemented.)*

---

## Project Status

**v0.1.0 — early development.** Plugin skeleton and node API in place; map page next.

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
