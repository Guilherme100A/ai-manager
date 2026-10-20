import { useEffect, useRef } from 'react'
import { api } from './lib/api'
import { Layout } from './components/Layout'
import { useRoute, useToken } from './lib/hooks'
import { navigate, type Route } from './lib/router'
import { Alerts } from './pages/Alerts'
import { Report } from './pages/Report'
import { AutoReply } from './pages/AutoReply'
import { AiSettingsPage } from './pages/AiSettings'
import { Contacts } from './pages/Contacts'
import { Crm } from './pages/Crm'
import { backRoute } from './pages/Crm.logic'
import { Groups } from './pages/Groups'
import { Home } from './pages/Home'
import { Login } from './pages/Login'
import { NewSession } from './pages/NewSession'
import { SessionDetail } from './pages/SessionDetail'
import { Sessions } from './pages/Sessions'
import { SessionLinks } from './pages/SessionLinks'
import { Spy } from './pages/Spy'

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <Home />
    case 'sessions':
      return <Sessions />
    case 'session-links':
      return <SessionLinks />
    case 'spy':
      return <Spy />
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
    case 'report':
      return <Report />
    case 'autoreply':
      return <AutoReply />
    case 'ai':
      return <AiSettingsPage />
    case 'crm':
      // Renderizado fora do Layout (tela cheia), em App.
      return null
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
  // Última página do painel antes de entrar no CRM: destino do "Voltar ao painel".
  const lastPanelRoute = useRef<Route | null>(null)
  useEffect(() => {
    if (route.name !== 'crm' && route.name !== 'login') lastPanelRoute.current = route
  }, [route])

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
  // CRM = outra parte do site: tela cheia, sem o menu lateral do painel (a barra do topo leva de volta).
  if (route.name === 'crm') return <Crm back={backRoute(lastPanelRoute.current)} />
  return (
    <Layout route={route}>
      <Page route={route} />
    </Layout>
  )
}
