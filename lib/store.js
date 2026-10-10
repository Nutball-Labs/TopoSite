// store.js — Where TopoSite keeps its data, and safe JSON/image file writes.
//
// Data lives in Z-Wave JS UI's store dir so it is backed up and persisted with
// Z-Wave JS UI's own data:
//   <store>/toposite/layout.json   plans + placements (ROADMAP.md data model)
//   <store>/toposite/images/       plan images
// It is kept outside the plugin dir so redeploying the plugin never touches it.

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * Find Z-Wave JS UI's store dir: TOPOSITE_STORE_DIR, then STORE_DIR (same
 * variable Z-Wave JS UI uses), then <cwd>/store (Docker: /usr/src/app/store),
 * then the dir two levels above the plugin (plugins usually live in
 * <store>/plugins/toposite). A candidate must contain settings.json.
 * Returns null when none is found.
 */
export function resolveStoreDir(env = process.env, cwd = process.cwd(), pluginDir = PLUGIN_DIR) {
    const candidates = [
        env.TOPOSITE_STORE_DIR,
        env.STORE_DIR,
        path.join(cwd, 'store'),
        path.resolve(pluginDir, '..', '..'),
    ].filter(Boolean)
    return candidates.find((dir) => existsSync(path.join(dir, 'settings.json'))) ?? null
}

/** Read and parse a JSON file; returns `fallback` if it doesn't exist. */
export async function readJSON(file, fallback) {
    try {
        return JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
        if (error.code === 'ENOENT') return fallback
        throw error
    }
}

/** Write a file atomically: temp file in the same dir, then rename over the target. */
export async function writeAtomic(file, data) {
    await mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
        await writeFile(tmp, data)
        await rename(tmp, file)
    } catch (error) {
        await rm(tmp, { force: true })
        throw error
    }
}

// SN: 00002
