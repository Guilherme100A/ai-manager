import { useEffect } from 'react'
import { api } from './lib/api'
import { Layout } from './components/Layout'
import { useRoute, useToken } from './lib/hooks'
import { navigate, type Route } from './lib/router'
import { Alerts } from './pages/Alerts'
import { AiSettingsPage } from './pages/AiSettings'
import { Contacts } from './pages/Contacts'
import { Groups } from './pages/Groups'
import { Home } from './pages/Home'
import { Login } from './pages/Login'
import { NewSession } from './pages/NewSession'
import { SessionDetail } from './pages/SessionDetail'
import { Sessions } from './pages/Sessions'
import { SessionLinks } from './pages/SessionLinks'

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <Home />
    case 'sessions':
      return <Sessions />
    case 'session-links':
      return <SessionLinks />
    case 'new-session':
      return <NewSession />
    case 'session':
      return <SessionDetail key={route.id} id={route.id} />
    case 'proxies':
      // Proxy agora é configurado dentro da sessão (AC-T18-03): a rota antiga redireciona para Sessões.
      return null
    case 'contacts':
      return <Contacts />
    case 'groups':
      return <Groups />
    case 'alerts':
      return <Alerts />
    case 'ai':
      return <AiSettingsPage />
    case 'login':
      return null
    case 'not-found':
      return (
        <div data-testid="page-not-found">
          <h1>Página não encontrada</h1>
          <a href="#/">Voltar ao início</a>
        </div>
      )
  }
}

export function App() {
  const route = useRoute()
  const token = useToken()

  // Página Proxies removida (AC-T18-03): #/proxies vai para #/sessions.
  useEffect(() => {
    if (route.name === 'proxies') navigate({ name: 'sessions' })
  }, [route.name])

  // Token salvo de uma aba anterior: valida uma vez; um 401 limpa o token (request) e volta ao login.
  useEffect(() => {
    if (token) void api.me().catch(() => undefined)
  }, [token])

  // Sem token, toda rota vai para o login (AC-T18-01); com token, o login vai para a home.
  useEffect(() => {
    if (!token && route.name !== 'login') navigate({ name: 'login' })
    else if (token && route.name === 'login') navigate({ name: 'home' })
  }, [token, route.name])

  if (!token || route.name === 'login') return <Login />
  return (
    <Layout route={route}>
      <Page route={route} />
    </Layout>
  )
}
