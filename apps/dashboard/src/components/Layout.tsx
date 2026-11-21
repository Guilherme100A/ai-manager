import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react'
import { signOut } from '../lib/signout'
import { navigate, navigateLink, parseHash, type Route } from '../lib/router'
import { getTheme, subscribeTheme, toggleTheme } from '../lib/theme'
import { IconBell, IconBriefcase, IconClose, IconGroups, IconHome, IconLogout, IconMenu, IconMoon, IconPhone, IconSearch, IconSpark, IconSun, IconUsers, Logo } from './icons'

const LINKS: Array<{ route: Route['name']; href: string; label: string; testId: string; icon: () => ReactNode }> = [
  { route: 'home', href: '#/', label: 'Início', testId: 'nav-home', icon: IconHome },
  { route: 'sessions', href: '#/sessions', label: 'Chips', testId: 'nav-sessions', icon: IconPhone },
  { route: 'session-links', href: '#/session-links', label: 'Vínculos de sessões', testId: 'nav-session-links', icon: IconPhone },
  { route: 'contacts', href: '#/contacts', label: 'Contatos', testId: 'nav-contacts', icon: IconUsers },
  { route: 'groups', href: '#/groups', label: 'Grupos', testId: 'nav-groups', icon: IconGroups },
  { route: 'report', href: '#/report', label: 'Relatório', testId: 'nav-report', icon: IconBell },
  { route: 'autoreply', href: '#/autoreply', label: 'Autoresposta', testId: 'nav-autoreply', icon: IconUsers },
  { route: 'alerts', href: '#/alerts', label: 'Alertas', testId: 'nav-alerts', icon: IconBell },
  { route: 'ai', href: '#/ai', label: 'IA / Modelo LLM', testId: 'nav-ai', icon: IconSpark },
  { route: 'spy', href: '#/spy', label: 'Espião', testId: 'nav-spy', icon: IconSearch },
  { route: 'crm', href: '#/crm', label: 'CRM', testId: 'nav-crm', icon: IconBriefcase },
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

export function Layout({ route, children, crmPending = false, onLogout }: { route: Route; children: ReactNode; crmPending?: boolean; onLogout?: () => void }) {
  const active = route.name === 'session' || route.name === 'new-session' ? 'sessions' : route.name
  const [open, setOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const main = useRef<HTMLElement>(null)
  function closeMenu() {
    if (open) {
      setOpen(false)
      main.current?.focus()
    }
  }

  function onNavigate(event: MouseEvent<HTMLAnchorElement>) {
    const wasPrevented = event.defaultPrevented
    navigateLink(event, parseHash(event.currentTarget.hash))
    if (!wasPrevented && event.defaultPrevented && parseHash(event.currentTarget.hash).name !== 'crm') closeMenu()
  }

  // Menu recolhível (< 768px): fecha ao trocar de página.
  useEffect(() => setOpen(false), [route])

  return (
    <div className={active === 'sessions' || active === 'session-links' ? 'layout layout-chips' : 'layout'}>
      <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); main.current?.focus() }}>Pular para o conteúdo</a>
      <aside className="sidebar" data-open={open ? 'true' : 'false'} onKeyDown={(event) => {
        if (event.key === 'Escape' && open) { setOpen(false); menuButton.current?.focus() }
      }}>
        <div className="sidebar-head">
          <a className="brand" href="#/" onClick={onNavigate}>
            <Logo />
            <span>WA Session Manager</span>
          </a>
          <ThemeToggle />
          <button
            type="button"
            className="icon-button nav-toggle"
            data-testid="nav-toggle"
            ref={menuButton}
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
              onClick={onNavigate}
              data-testid={l.testId}
              className={active === l.route ? 'active' : undefined}
              aria-busy={l.route === 'crm' && crmPending ? true : undefined}
              aria-current={active === l.route ? 'page' : undefined}
            >
              <l.icon />
              <span>{l.label}</span>
              {l.route === 'crm' && crmPending && <span className="crm-pending" role="status">Carregando</span>}
            </a>
          ))}
          <div className="nav-foot">
            <button
              type="button"
              className="nav-link"
              data-testid="nav-logout"
              onClick={() => {
                onLogout?.()
                void signOut().then(() => navigate({ name: 'login' }))
              }}
            >
              <IconLogout />
              <span>Sair</span>
            </button>
          </div>
        </nav>
      </aside>
      <main className="main" id="main-content" tabIndex={-1} ref={main}>
        <div className="main-inner">{children}</div>
      </main>
    </div>
  )
}
