import React, { useCallback, useEffect, useState } from 'react'
import { API, AuthRequiredError, authStatus, loadState, login, post, type FleetState, type Identity } from './api.js'

type Selection = { kind: 'session' } | { kind: 'template'; id: string }

export function FleetSidebarTab({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  return <FleetPage sessionId={sessionId} visible={visible} />
}

function FleetPage({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [state, setState] = useState<FleetState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [selected, setSelected] = useState<Selection | null>(null)
  const [managing, setManaging] = useState(false)
  const [name, setName] = useState('')
  const [maxSlots, setMaxSlots] = useState(2)

  const refresh = useCallback(async () => {
    try {
      const next = await loadState(sessionId)
      setState(next)
      setAuthenticated(true)
      setError('')
    } catch (reason) {
      if (reason instanceof AuthRequiredError) setAuthenticated(false)
      else setError(message(reason))
    }
  }, [sessionId])

  useEffect(() => { setSelected(null) }, [sessionId])
  useEffect(() => {
    if (!visible) return
    let live = true
    void authStatus().then((value) => {
      if (!live) return
      setAuthenticated(value)
      if (value) void refresh()
    }).catch((reason) => live && setError(message(reason)))
    return () => { live = false }
  }, [refresh, visible])
  useEffect(() => {
    if (!authenticated || !visible) return
    const timer = window.setInterval(() => { void refresh() }, 4_000)
    return () => window.clearInterval(timer)
  }, [authenticated, refresh, visible])

  const mutate = useCallback(async (label: string, path: string, body: Record<string, unknown> = {}) => {
    setBusy(label)
    setError('')
    try { await post(path, body); await refresh() }
    catch (reason) {
      if (reason instanceof AuthRequiredError) setAuthenticated(false)
      setError(message(reason))
      throw reason
    } finally { setBusy('') }
  }, [refresh])

  useEffect(() => {
    if (!state) return
    if (selected?.kind === 'template' && state.identities.some((identity) => identity.id === selected.id && identity.templateRuntime.running)) return
    if (selected?.kind === 'session' && state.sessionBrowser?.running) return
    if (state.sessionBrowser?.running) setSelected({ kind: 'session' })
    else {
      const template = state.identities.find((identity) => identity.templateRuntime.running)
      setSelected(template ? { kind: 'template', id: template.id } : null)
    }
  }, [selected, state])

  const selectedIdentity = selected?.kind === 'template' ? state?.identities.find((identity) => identity.id === selected.id) : undefined
  const currentIdentity = state?.sessionBrowser ? state.identities.find((identity) => identity.id === state.sessionBrowser?.identityId) : undefined
  const vncSrc = !visible ? '' : selected?.kind === 'session' && state?.sessionBrowser?.running
    ? novncUrl('sessionId', sessionId)
    : selectedIdentity?.templateRuntime.running
      ? novncUrl('identityId', selectedIdentity.id)
      : ''

  if (authenticated === null) return <div className="abf-panel"><div className="abf-loading">Connecting browser…</div></div>
  if (!authenticated) return <LoginPanel onLogin={async (token) => { await login(token); setAuthenticated(true); await refresh() }} error={error} />

  const hasReadyIdentity = state?.identities.some((identity) => identity.templateState === 'READY')
  const selectionValue = selected?.kind === 'session' ? 'session' : selected?.kind === 'template' ? 'template:' + selected.id : ''
  return <div className="abf-panel" aria-label="Browser Fleet">
    <header className="abf-browser-bar">
      <div className="abf-brand"><span aria-hidden="true">◉</span><div><b>Browser</b><small title={sessionId}>Session {sessionId.slice(-8)}</small></div></div>
      <select className="abf-browser-picker" aria-label="Current browser" value={selectionValue} onChange={(event) => setSelected(parseSelection(event.target.value))}>
        <option value="">Choose browser view</option>
        {state?.sessionBrowser ? <option value="session">{currentIdentity?.name ?? 'Session Browser'} · Shared control</option> : null}
        {state?.identities.filter((identity) => identity.templateRuntime.running).map((identity) => <option key={'template:' + identity.id} value={'template:' + identity.id}>{identity.name} · Login setup</option>)}
      </select>
      <button className="abf-icon-button" type="button" title="Manage identities" aria-label="Manage identities" onClick={() => setManaging(true)}>⚙</button>
    </header>

    {error ? <div className="abf-toast abf-error">{error}</div> : null}
    {busy ? <div className="abf-toast abf-busy">{busy}…</div> : null}

    <main className="abf-browser-stage">
      {vncSrc ? <iframe key={vncSrc} src={vncSrc} title="Authenticated noVNC console" allow="clipboard-read; clipboard-write" /> : <div className="abf-stage-empty">
        <span aria-hidden="true">◉</span>
        <b>{state?.identities.length ? hasReadyIdentity ? 'Waiting for the Agent' : 'Finish browser setup' : 'Set up your first browser'}</b>
        <p>{state?.identities.length ? hasReadyIdentity ? 'The Agent can select an Identity with agent_browser_use_identity.' : 'Open an Identity below, sign in, then save its login.' : 'Create an Identity once, sign in, and reuse it from Agent sessions.'}</p>
        <button className="abf-primary-action" type="button" onClick={() => setManaging(true)}>{state?.identities.length ? 'Manage identities' : 'Set up browser'}</button>
      </div>}
    </main>

    <ContextBar sessionRunning={state?.sessionBrowser?.running === true} identity={selectedIdentity} mutate={mutate} />

    {managing ? <ManageDrawer state={state} selected={selected} name={name} maxSlots={maxSlots} setName={setName} setMaxSlots={setMaxSlots} onSelect={(value) => { setSelected(value); setManaging(false) }} mutate={mutate} onClose={() => setManaging(false)} /> : null}
  </div>
}

function ContextBar({ sessionRunning, identity, mutate }: {
  sessionRunning: boolean
  identity?: Identity
  mutate(label: string, path: string, body?: Record<string, unknown>): Promise<void>
}) {
  if (identity) return <footer className="abf-context-bar"><div className="abf-context-copy"><Status value={identity.templateState} /><span>Identity login setup</span></div><div className="abf-context-actions">{identity.templateRuntime.running ? <button className="abf-primary-action" type="button" onClick={() => void mutate('Saving clean snapshot', '/identities/' + identity.id + '/template/snapshot').catch(() => undefined)}>Save login</button> : null}</div></footer>
  if (sessionRunning) return <footer className="abf-context-bar"><div className="abf-context-copy"><Status value="READY" /><span>Shared control · User and Agent can both interact</span></div></footer>
  return <footer className="abf-context-bar"><div className="abf-context-copy"><span>No Session Browser selected</span></div></footer>
}

function ManageDrawer({ state, selected, name, maxSlots, setName, setMaxSlots, onSelect, mutate, onClose }: {
  state: FleetState | null
  selected: Selection | null
  name: string
  maxSlots: number
  setName(value: string): void
  setMaxSlots(value: number): void
  onSelect(value: Selection): void
  mutate(label: string, path: string, body?: Record<string, unknown>): Promise<void>
  onClose(): void
}) {
  return <aside className="abf-manage-drawer" aria-label="Manage identities">
    <header className="abf-drawer-header"><div><b>Browser setup</b><span>Reusable authenticated identities</span></div><button className="abf-icon-button" type="button" aria-label="Close browser management" onClick={onClose}>×</button></header>
    <div className="abf-drawer-scroll">
      <form className="abf-setup-form" onSubmit={(event) => {
        event.preventDefault()
        if (!name.trim()) return
        void mutate('Creating identity', '/identities', { name: name.trim(), maxSlots }).then(() => setName('')).catch(() => undefined)
      }}><input value={name} onChange={(event) => setName(event.target.value)} placeholder="New identity name" /><label>Capacity <input type="number" min={1} max={20} value={maxSlots} onChange={(event) => setMaxSlots(Number(event.target.value))} /></label><button type="submit" disabled={!name.trim()}>Create</button></form>
      <div className="abf-manager-list">
        {state?.identities.map((identity) => <ManagedIdentity key={identity.id} identity={identity} selected={selected} onSelect={onSelect} mutate={mutate} />)}
        {state?.identities.length === 0 ? <div className="abf-empty"><b>No identities yet</b><span>Create one above to begin.</span></div> : null}
      </div>
      <details className="abf-audit"><summary>Recent activity <span>{state?.timeline.length ?? 0}</span></summary><div className="abf-timeline">
        {state?.timeline.slice().reverse().slice(0, 40).map((event) => <article key={event.id}><i className={'abf-dot abf-' + event.actor} /><div><b>{event.summary}</b><span>{new Date(event.at).toLocaleTimeString()} · {event.actor}</span></div></article>)}
        {state?.timeline.length === 0 ? <div className="abf-empty"><span>No activity yet.</span></div> : null}
      </div></details>
    </div>
  </aside>
}

function ManagedIdentity({ identity, selected, onSelect, mutate }: {
  identity: Identity
  selected: Selection | null
  onSelect(value: Selection): void
  mutate(label: string, path: string, body?: Record<string, unknown>): Promise<void>
}) {
  const selectedTemplate = selected?.kind === 'template' && selected.id === identity.id
  return <article className={'abf-manager-identity ' + (selectedTemplate ? 'selected' : '')}>
    <header className="abf-manager-head"><div><span>{identity.name.slice(0, 1).toUpperCase()}</span><div><b>{identity.name}</b><small>{identity.preparedProfiles} prepared · {identity.activeSessions} active · {identity.maxSlots} capacity</small></div></div><Status value={identity.templateState} /></header>
    {identity.error ? <div className="abf-inline-error">{identity.error}</div> : null}
    <div className="abf-manager-actions"><button type="button" onClick={() => void mutate('Opening login setup', '/identities/' + identity.id + '/template/start').then(() => onSelect({ kind: 'template', id: identity.id })).catch(() => undefined)}>{identity.templateRuntime.running ? 'Open setup' : 'Set up login'}</button><button className="abf-primary-action" type="button" disabled={!identity.templateRuntime.running} onClick={() => void mutate('Saving clean snapshot', '/identities/' + identity.id + '/template/snapshot').catch(() => undefined)}>Save login</button></div>
  </article>
}

function LoginPanel({ onLogin, error }: { onLogin(token: string): Promise<void>; error: string }) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  return <div className="abf-panel abf-login-wrap"><form className="abf-login" onSubmit={(event) => { event.preventDefault(); setBusy(true); void onLogin(token).finally(() => setBusy(false)) }}><div className="abf-login-mark">◉</div><h1>Browser access</h1><p>Strict token mode is enabled by the Host administrator.</p>{error ? <div className="abf-error">{error}</div> : null}<input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Access token" autoFocus /><button type="submit" disabled={busy || !token}>{busy ? 'Authenticating…' : 'Continue'}</button></form></div>
}

function Status({ value }: { value: string }) { return <span className={'abf-status status-' + value.toLowerCase()}>{value}</span> }
function parseSelection(value: string): Selection | null { if (value === 'session') return { kind: 'session' }; return value.startsWith('template:') ? { kind: 'template', id: value.slice('template:'.length) } : null }
function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
function novncUrl(key: 'sessionId' | 'identityId', id: string): string { const path = 'api/agent-browser-fleet/novnc/ws?' + key + '=' + encodeURIComponent(id); return API + '/novnc/vnc.html?autoconnect=1&resize=scale&path=' + encodeURIComponent(path) }
