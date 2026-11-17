export const LOGIN_VERIFICATION_ORIGIN = 'https://crm.148.113.255.144.sslip.io'

export function secureClient(origin, fetcher = globalThis.fetch, env = process.env) {
  const url = new URL(origin)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('Validated HTTPS origin required; credentials withheld')
  return (path, options = {}) => {
    const target = new URL(path, url)
    if (target.origin !== url.origin) throw new Error('Cross-origin smoke request refused; credentials withheld')
    return fetcher(target.href, { ...options, redirect: 'error' })
  }
}

/** Always attempt every credential, including after a partial failure. Return only non-sensitive evidence. */
export async function revokeTemporarySessions(request, sessions, crmCookies) {
  let panelTokens401 = true, crmCookiesRevoked = true, panelChecked = 0, crmChecked = 0
  for (const cookie of crmCookies) {
    try {
      await request('/crm/api/auth/logout', { method: 'POST', headers: { cookie: 'crm_session=' + cookie, 'x-requested-with': 'crm', 'content-type': 'application/json' }, body: '{}' })
      if ((await request('/crm/api/auth/profile', { headers: { cookie: 'crm_session=' + cookie } })).status !== 401) crmCookiesRevoked = false
    } catch { crmCookiesRevoked = false }
    crmChecked++
  }
  for (const session of sessions) {
    try {
      await request('/api/auth/logout', { method: 'POST', headers: { authorization: 'Bearer ' + session.token } })
      if ((await request('/api/auth/me', { headers: { authorization: 'Bearer ' + session.token } })).status !== 401) panelTokens401 = false
    } catch { panelTokens401 = false }
    panelChecked++
  }
  return { panelTokens401, crmCookiesRevoked, panelChecked, crmChecked }
}
