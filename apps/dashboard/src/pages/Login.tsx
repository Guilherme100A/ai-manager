// Login do administrador: memoria/sessionStorage por padrao, persistencia apenas com opt-in.
import { useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import { setToken } from '../lib/auth'
import { loginErrorMessage } from '../lib/login'
import { navigate } from '../lib/router'
import { Logo } from '../components/icons'
import { ThemeToggle } from '../components/Layout'

export function Login({ returnToCrm = false }: { returnToCrm?: boolean }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const user = username.trim()
    if (!user || !password) return setError('Informe usuário e senha')
    setBusy(true)
    setError(undefined)
    try {
      const res = await api.login(user, password, remember)
      setToken(res.token, remember ? { remember: true, expiresAt: res.expiresAt } : {})
      setPassword('')
      navigate({ name: returnToCrm ? 'crm' : 'home' })
    } catch (err) {
      setError(loginErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <div className="login-top">
        <ThemeToggle />
      </div>
      <form onSubmit={submit} className="panel login-card">
        <Logo />
        <h1>WA Session Manager</h1>
        <p className="page-subtitle">Entre com sua conta de administrador.</p>
        <label htmlFor="login-username">Usuário</label>
        <input
          id="login-username"
          data-testid="login-username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <label htmlFor="login-password">Senha</label>
        <input
          id="login-password"
          data-testid="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <label className="remember-login" htmlFor="login-remember">
          <input id="login-remember" data-testid="login-remember" type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
          <span>Manter conectado neste dispositivo por 30 dias</span>
        </label>
        <button type="submit" data-testid="login-submit" disabled={busy}>
          Entrar
        </button>
        {error ? (
          <p className="error" role="alert" data-testid="login-error">
            {error}
          </p>
        ) : null}
      </form>
    </div>
  )
}
