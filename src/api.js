export class ApiError extends Error {
  constructor(message, status, code, current) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.current = current
  }
}
export async function request(path, options = {}) {
  const response = await fetch(`/api/${path.replace(/^\/+/, '')}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const error = data?.error || {}
    throw new ApiError(error.message || `HTTP ${response.status}`, response.status, error.code, error.current)
  }
  return data
}
export const post = (path, data) => request(path, { method: 'POST', body: JSON.stringify(data) })
export const patch = (path, data) => request(path, { method: 'PATCH', body: JSON.stringify(data) })
export const remove = (path, version) => request(path, { method: 'DELETE', body: JSON.stringify({ version }) })
