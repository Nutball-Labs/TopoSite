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

> **Note:** TopoSite's data and changes are protected by Z-Wave JS UI's own
> login when that login is turned on. With Z-Wave JS UI's auth off, TopoSite —
> like Z-Wave JS UI itself — is open to anyone who can reach it.

---

## Usage

Open `http://<zwave-js-ui-host>:8091/toposite/`.

- **Add image…** uploads a background: a floor plan, site plan or a satellite
  screenshot (PNG, JPEG or WebP, up to 25 MB). Several images can be added and
  switched with the drop-down.
- **New drawing** starts a blank floor plan; **Draw** shows tools for
  rectangles, circles, lines and text labels, plus edit, move and delete.
  You can also draw on top of an uploaded image (e.g. trace walls over a
  satellite view). Drawings save automatically.
- **Drag a node** onto the image to place it; positions are saved in Z-Wave JS
  UI's store (`store/toposite/`), so they're kept with its backups.
  Right-click a placed node to send it back to the automatic layout (faded).
- **Refresh neighbors** asks Z-Wave JS UI to re-read every node's neighbor list
  (the radio pauses for a few seconds; once a minute at most).
- The check boxes at top right toggle routes, backup routes, neighbor lines and nodes.

If Z-Wave JS UI's login is turned on, TopoSite requires the same login: log in
to Z-Wave JS UI in the same browser first.

---

## Project Status

**v0.1.0 — early development.** Node API and a first read-only map page at
`/toposite/` (temporary auto-layout, placeholder background, "Refresh neighbors"
button). Floor-plan upload and dragging nodes into place come next.

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

## Credits

- TopoSite's visual language (node shapes, hop and data-rate colors, route
  styles) follows the Network Graph in
  [Z-Wave JS UI](https://github.com/zwave-js/zwave-js-ui) by Daniel Lando and
  contributors (MIT).
- Bundled: [Leaflet](https://leafletjs.com) 1.9.4 (BSD-2-Clause),
  [Leaflet-Geoman](https://geoman.io) free 2.20.2 (MIT) and the
  [Socket.IO](https://socket.io) 4.8.4 client (MIT); their licenses are in
  `public/vendor/`.

---

## License

GNU General Public License v3 — see [LICENSE](LICENSE).
Copyright (C) 2026 Nutball Labs / Stephen Berg

<!-- SN: 00001 -->
