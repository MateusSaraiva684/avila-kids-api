// Web Crypto PBKDF2 is native to Workers; each password gets an independent salt.
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  )
  const iterations = 100_000
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256,
  )
  const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `pbkdf2-sha256$${iterations}$${hex(salt)}$${hex(new Uint8Array(bits))}`
}
