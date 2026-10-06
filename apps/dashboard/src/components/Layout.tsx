import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { signOut } from '../lib/signout'
import { navigate, type Route } from '../lib/router'
import { getTheme, subscribeTheme, toggleTheme } from '../lib/theme'
import { IconBell, IconClose, IconGroups, IconHome, IconLogout, IconMenu, IconMoon, IconPhone, IconSpark, IconSun, IconUsers, Logo } from './icons'

const LINKS: Array<{ route: Route['name']; href: string; label: string; testId: string; icon: () => ReactNode }> = [
  { route: 'home', href: '#/', label: 'Início', testId: 'nav-home', icon: IconHome },
  { route: 'sessions', href: '#/sessions', label: 'Sessões', testId: 'nav-sessions', icon: IconPhone },
  { route: 'session-links', href: '#/session-links', label: 'Vínculos de sessões', testId: 'nav-session-links', icon: IconPhone },
  { route: 'contacts', href: '#/contacts', label: 'Contatos', testId: 'nav-contacts', icon: IconUsers },
  { route: 'groups', href: '#/groups', label: 'Grupos', testId: 'nav-groups', icon: IconGroups },
  { route: 'report', href: '#/report', label: 'Relatório', testId: 'nav-report', icon: IconBell },
  { route: 'alerts', href: '#/alerts', label: 'Alertas', testId: 'nav-alerts', icon: IconBell },
  { route: 'ai', href: '#/ai', label: 'IA / Modelo LLM', testId: 'nav-ai', icon: IconSpark },
]

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, () => 'light')
  const next = theme === 'dark' ? 'claro' : 'escuro'
  return (
    <button type="button" className="icon-button" data-testid="theme-toggle" aria-label={`Usar tema ${next}`} title={`Tema ${next}`} onClick={toggleTheme}>
      {theme === 'dark' ? <IconSun /> : <IconMoon />}
    </button>
  )
}

export function Layout({ route, children }: { route: Route; children: ReactNode }) {
  const active = route.name === 'session' || route.name === 'new-session' ? 'sessions' : route.name
  const [open, setOpen] = useState(false)

  // Menu recolhível (< 768px): fecha ao trocar de página.
  useEffect(() => setOpen(false), [route])

  return (
    <div className="layout">
      <aside className="sidebar" data-open={open ? 'true' : 'false'}>
        <div className="sidebar-head">
          <a className="brand" href="#/">
            <Logo />
            <span>WA Session Manager</span>
          </a>
          <ThemeToggle />
          <button
            type="button"
            className="icon-button nav-toggle"
            data-testid="nav-toggle"
            aria-controls="app-nav"
            aria-expanded={open}
            aria-label={open ? 'Fechar menu' : 'Abrir menu'}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <IconClose /> : <IconMenu />}
          </button>
        </div>
        <nav className="nav" id="app-nav" data-testid="app-nav" aria-label="Principal">
          {LINKS.map((l) => (
            <a
              key={l.route}
              href={l.href}
              data-testid={l.testId}
              className={active === l.route ? 'active' : undefined}
              aria-current={active === l.route ? 'page' : undefined}
            >
              <l.icon />
              <span>{l.label}</span>
            </a>
          ))}
          <div className="nav-foot">
            <button
              type="button"
              className="nav-link"
              data-testid="nav-logout"
              onClick={() => {
                void signOut().then(() => navigate({ name: 'login' }))
              }}
            >
              <IconLogout />
              <span>Sair</span>
            </button>
          </div>
        </nav>
      </aside>
      <main className="main">
        <div className="main-inner">{children}</div>
      </main>
    </div>
  )
}
