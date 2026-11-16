import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { bodyLimit } from 'hono/body-limit'
import { hashPassword } from './password.js'

const clientFields = 'id, name, email, created_at'
const methods = 'GET, POST, PUT, DELETE, OPTIONS'
const fail = (status, message) => { throw new HTTPException(status, { message }) }
const positiveId = (value) => {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    fail(400, 'O ID deve ser um inteiro positivo.')
  }
  return Number(value)
}

async function jsonBody(c) {
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') || '')) {
    fail(415, 'Utilize Content-Type: application/json.')
  }
  let body
  try { body = await c.req.json() }
  catch { fail(400, 'JSON inválido.') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Envie um objeto JSON.')
  return body
}

async function clientInput(c, updating = false) {
  const body = await jsonBody(c)
  if (Object.keys(body).some(key => !['name', 'email', 'password'].includes(key))) {
    fail(400, 'Campos permitidos: name, email e password.')
  }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (name.length < 2 || name.length > 120) fail(400, 'Nome deve ter entre 2 e 120 caracteres.')
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'E-mail inválido.')
  if (!updating || Object.hasOwn(body, 'password')) {
    if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 128) {
      fail(400, 'Senha deve ter entre 8 e 128 caracteres.')
    }
  }
  return { name, email, password: body.password }
}

async function findClient(c) {
  const id = positiveId(c.req.param('id'))
  const client = await c.env.DB.prepare(`SELECT ${clientFields} FROM clients WHERE id = ?`).bind(id).first()
  if (!client) fail(404, 'Cliente não encontrado.')
  return client
}

function constraint(error, pattern) {
  return pattern.test(String(error?.message)) || (error?.cause && pattern.test(String(error.cause.message)))
}

export function createApp(fetcher = globalThis.fetch) {
  const app = new Hono()

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Vary', 'Origin')
    const origin = c.req.header('origin')
    const allowed = (c.env.CORS_ORIGINS || '').split(',').map(value => value.trim())
    if (origin && allowed.includes(origin)) c.header('Access-Control-Allow-Origin', origin)
    if (c.req.method === 'OPTIONS') {
      if (!origin || !allowed.includes(origin)) fail(403, 'Origem não permitida.')
      c.header('Access-Control-Allow-Methods', methods)
      c.header('Access-Control-Allow-Headers', 'Content-Type')
      c.header('Access-Control-Max-Age', '600')
      return c.body(null, 204)
    }
    await next()
  })
  app.use('*', bodyLimit({ maxSize: 16 * 1024, onError: () => fail(413, 'Corpo da requisição muito grande.') }))

  async function external(path, productId) {
    let response
    try {
      response = await fetcher(`https://fakestoreapi.com${path}`, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000),
      })
    }
    catch { fail(502, 'Não foi possível consultar a Fake Store API.') }
    if (response.status === 404 && productId) fail(404, 'Produto não encontrado.')
    if (!response.ok) fail(502, 'A Fake Store API está indisponível.')
    let data
    let raw
    try { raw = await response.text() }
    catch { fail(502, 'Não foi possível ler a resposta da Fake Store API.') }
    if (productId && (!raw.trim() || raw.trim() === 'null')) fail(404, 'Produto não encontrado.')
    try { data = JSON.parse(raw) }
    catch { fail(502, 'A Fake Store API retornou uma resposta inválida.') }
    if (productId) {
      if (!data || typeof data !== 'object' || data.id !== productId || typeof data.title !== 'string') {
        fail(502, 'A Fake Store API retornou um produto inválido.')
      }
    }
    else if (!Array.isArray(data) || (path === '/products/categories'
      ? data.some(item => typeof item !== 'string')
      : data.some(item => !item || !Number.isSafeInteger(item.id) || typeof item.title !== 'string'))) {
      fail(502, 'A Fake Store API retornou uma lista inválida.')
    }
    return data
  }

  app.get('/', c => c.json({ name: 'Ávila Kids API', endpoints: '/clients, /products, /categories' }))

  app.post('/clients', async (c) => {
    const { name, email, password } = await clientInput(c)
    const passwordHash = await hashPassword(password)
    let client
    try {
      client = await c.env.DB.prepare(
        `INSERT INTO clients (name, email, password_hash) VALUES (?, ?, ?) RETURNING ${clientFields}`,
      ).bind(name, email, passwordHash).first()
    }
    catch (error) {
      if (constraint(error, /UNIQUE constraint failed: clients.email/i)) fail(409, 'E-mail já cadastrado.')
      throw error
    }
    c.header('Location', `/clients/${client.id}`)
    return c.json({ data: client }, 201)
  })

  app.get('/clients', async (c) => {
    const { results } = await c.env.DB.prepare(`SELECT ${clientFields} FROM clients ORDER BY id`).all()
    return c.json({ data: results })
  })
  app.get('/clients/:id', async c => c.json({ data: await findClient(c) }))
  app.put('/clients/:id', async (c) => {
    const existing = await findClient(c)
    const { name, email, password } = await clientInput(c, true)
    let client
    try {
      const query = password === undefined
        ? c.env.DB.prepare(`UPDATE clients SET name = ?, email = ? WHERE id = ? RETURNING ${clientFields}`).bind(name, email, existing.id)
        : c.env.DB.prepare(`UPDATE clients SET name = ?, email = ?, password_hash = ? WHERE id = ? RETURNING ${clientFields}`).bind(name, email, await hashPassword(password), existing.id)
      client = await query.first()
    }
    catch (error) {
      if (constraint(error, /UNIQUE constraint failed: clients.email/i)) fail(409, 'E-mail já cadastrado.')
      throw error
    }
    if (!client) fail(404, 'Cliente não encontrado.')
    return c.json({ data: client })
  })
  app.delete('/clients/:id', async (c) => {
    const id = positiveId(c.req.param('id'))
    const deleted = await c.env.DB.prepare('DELETE FROM clients WHERE id = ? RETURNING id').bind(id).first()
    if (!deleted) fail(404, 'Cliente não encontrado.')
    return c.body(null, 204)
  })

  app.get('/products', async c => c.json({ data: await external('/products') }))
  app.get('/products/:id', async (c) => {
    const id = positiveId(c.req.param('id'))
    return c.json({ data: await external(`/products/${id}`, id) })
  })
  app.get('/categories', async c => c.json({ data: await external('/products/categories') }))

  app.post('/clients/:id/favorites', async (c) => {
    const client = await findClient(c)
    const body = await jsonBody(c)
    if (Object.keys(body).some(key => key !== 'product_id') || typeof body.product_id !== 'number') {
      fail(400, 'Envie apenas product_id como inteiro positivo.')
    }
    const productId = positiveId(body.product_id)
    const duplicate = await c.env.DB.prepare('SELECT id FROM favorites WHERE client_id = ? AND product_id = ?').bind(client.id, productId).first()
    if (duplicate) fail(409, 'Produto já favoritado por este cliente.')
    await external(`/products/${productId}`, productId)
    let favorite
    try {
      favorite = await c.env.DB.prepare('INSERT INTO favorites (client_id, product_id) VALUES (?, ?) RETURNING *').bind(client.id, productId).first()
    }
    catch (error) {
      if (constraint(error, /UNIQUE constraint failed: favorites/i)) fail(409, 'Produto já favoritado por este cliente.')
      if (constraint(error, /FOREIGN KEY constraint failed/i)) fail(404, 'Cliente não encontrado.')
      throw error
    }
    c.header('Location', `/clients/${client.id}/favorites`)
    return c.json({ data: favorite }, 201)
  })
  app.get('/clients/:id/favorites', async (c) => {
    const client = await findClient(c)
    const { results } = await c.env.DB.prepare('SELECT * FROM favorites WHERE client_id = ? ORDER BY id').bind(client.id).all()
    // The relationship remains available even during an external service outage.
    return c.json({ data: results })
  })
  app.delete('/clients/:id/favorites/:productId', async (c) => {
    const client = await findClient(c)
    const productId = positiveId(c.req.param('productId'))
    const deleted = await c.env.DB.prepare('DELETE FROM favorites WHERE client_id = ? AND product_id = ? RETURNING id').bind(client.id, productId).first()
    if (!deleted) fail(404, 'Favorito não encontrado para este cliente.')
    return c.body(null, 204)
  })

  app.notFound(c => c.json({ error: { message: 'Rota não encontrada.' } }, 404))
  app.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: { message: error.message } }, error.status)
    // Do not log SQL parameters, password hashes or request bodies.
    console.error('Falha interna na API', c.req.method, c.req.routePath)
    return c.json({ error: { message: 'Erro interno do servidor.' } }, 500)
  })
  return app
}

export default createApp()
