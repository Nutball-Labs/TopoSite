// auth.js — Accept exactly the logins Z-Wave JS UI accepts.
//
// TopoSite's routes run before Z-Wave JS UI's auth middleware (and before its
// session middleware), so TopoSite checks Z-Wave JS UI's login token itself,
// mirroring api/app.ts isAuthenticated()/parseJWT():
//   - auth disabled in settings.json (gateway.authEnabled !== true) → allowed,
//     same as Z-Wave JS UI itself
//   - request came in on Z-Wave JS UI's trusted listener (TRUSTED_API_LISTEN) → allowed
//   - otherwise a JWT in `Authorization: Bearer …` or `x-access-token`, signed
//     HS256 with Z-Wave JS UI's session secret, not expired, for a user that
//     still exists in users.json
// Fails closed: if auth is on and the secret or users can't be read, deny.
//
// The browser gets the token from Z-Wave JS UI's login (localStorage 'user').

import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { readJSON } from './store.js'

// Z-Wave JS UI refuses to sign with this placeholder (api/config/app.ts)
const INSECURE_SESSION_SECRET = 'DEFAULT_SESSION_SECRET_CHANGE_ME'

function b64urlDecode(s) {
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/**
 * Verify an HS256 JWT. Returns the payload, or throws.
 * `now` is in seconds (JWT time).
 */
export function verifyJWT(token, secret, now = Math.floor(Date.now() / 1000)) {
    const parts = String(token).split('.')
    if (parts.length !== 3) throw new Error('malformed token')
    const [h, p, sig] = parts
    const header = JSON.parse(b64urlDecode(h).toString('utf8'))
    if (header.alg !== 'HS256') throw new Error(`unsupported alg ${header.alg}`)
    const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest()
    const given = b64urlDecode(sig)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error('bad signature')
    const payload = JSON.parse(b64urlDecode(p).toString('utf8'))
    if (typeof payload.exp === 'number' && payload.exp <= now) throw new Error('token expired')
    if (typeof payload.nbf === 'number' && payload.nbf > now) throw new Error('token not yet valid')
    return payload
}

/** Z-Wave JS UI's session secret: SESSION_SECRET env, else <store>/.session-secret. */
export async function sessionSecret(storeDir, env = process.env) {
    if (env.SESSION_SECRET && env.SESSION_SECRET !== INSECURE_SESSION_SECRET) return env.SESSION_SECRET
    const secret = (await readFile(path.join(storeDir, '.session-secret'), 'utf8')).trim()
    if (!secret || secret === INSECURE_SESSION_SECRET) throw new Error('no usable session secret')
    return secret
}

export async function isAuthEnabled(storeDir) {
    const settings = await readJSON(path.join(storeDir, 'settings.json'), {})
    return settings.gateway?.authEnabled === true
}

/**
 * Z-Wave JS UI's trusted listener bypasses auth; its own record of trusted
 * sockets is private, so recognize the listener by its port or unix path.
 */
export function isTrustedRequest(req, env = process.env) {
    const listen = env.TRUSTED_API_LISTEN?.trim()
    if (!listen || !req?.socket) return false
    if (listen.startsWith('/')) return req.socket.server?.address?.() === listen
    const port = Number(listen.match(/:(\d+)$/)?.[1])
    return Number.isInteger(port) && req.socket.localPort === port
}

export function tokenFrom(req) {
    let token = req.headers?.['x-access-token'] || req.headers?.authorization
    if (Array.isArray(token)) token = token[0]
    if (token?.startsWith('Bearer ')) token = token.slice(7)
    return token || null
}

/**
 * Decide whether a request may use TopoSite's API.
 * Returns { ok: true, user? } or { ok: false, reason }.
 */
export async function authenticate(req, storeDir, env = process.env) {
    if (!storeDir) return { ok: false, reason: 'Z-Wave JS UI store directory not found' }
    try {
        if (!(await isAuthEnabled(storeDir))) return { ok: true }
        if (isTrustedRequest(req, env)) return { ok: true }
        const token = tokenFrom(req)
        if (!token) return { ok: false, reason: 'login required' }
        const payload = verifyJWT(token, await sessionSecret(storeDir, env))
        const users = await readJSON(path.join(storeDir, 'users.json'), [])
        const user = users.find((u) => u.username === payload.username)
        if (!user) return { ok: false, reason: 'user not found' }
        return { ok: true, user: user.username }
    } catch (error) {
        return { ok: false, reason: error.message }
    }
}

// SN: 00002
