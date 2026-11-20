import { useEffect } from 'react'
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
import { metaProfilesDestination } from './pages/Crm.logic'
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
  const metaDestination = metaProfilesDestination(window.location.search)
  // A raiz autenticada abre o CRM; as rotas explícitas do gerenciador continuam acessíveis.
  useEffect(() => {
    if (token && route.name === 'home' && !window.location.hash) navigate({ name: 'crm' })
  }, [token, route.name])

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
    else if (token && route.name === 'login') navigate({ name: new URLSearchParams(window.location.search).get('return') === 'sessions' && !metaDestination ? 'sessions' : 'crm' })
    else if (token && route.name !== 'crm' && metaDestination) {
      const url = new URL(window.location.href)
      for (const key of ['meta_oauth', 'meta_workspace', 'meta_message']) url.searchParams.delete(key)
      window.history.replaceState(window.history.state, '', url)
    }
  }, [token, route.name, metaDestination])

  if (!token || route.name === 'login') return <Login returnToSessions={new URLSearchParams(window.location.search).get('return') === 'sessions' && !metaDestination} />
  // CRM = outra parte do site: tela cheia, sem o menu lateral do painel (a barra do topo leva de volta).
  if (route.name === 'crm') return <Crm flowId={route.flowId} metaDestination={metaDestination} />
  return (
    <Layout route={route}>
      <Page route={route} />
    </Layout>
  )
}
