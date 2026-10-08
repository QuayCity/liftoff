// @ts-check
// The LiftOff Settings page (inside a VS Code webview; see src/settingsPanel.ts).
// Builds the form from the settings it is sent, keeps the edits in `state`, and sends back only
// what changed (`changeOf`, which the unit tests load in Node).

/**
 * @typedef {{ action: 'include' | 'exclude', object: string, pattern: string }} Filter
 * @typedef {{ name: string, engine: string, migrations: string, schemas: string[], history_table: string,
 *   filters: Filter[], lock: 'advisory' | 'table', placeholders: Record<string, string> }} Project
 * @typedef {{ name: string, url: string, user: string | null, role: 'dev' | 'scratch' | 'test' | 'prod',
 *   allow_clean: boolean, placeholders: Record<string, string>, shared: boolean, has_password: boolean }} Env
 * @typedef {{ project: Project, environments: Env[] }} Settings
 * @typedef {Env & { password: string, isNew: boolean }} EnvState
 * @typedef {{ project: Project, environments: EnvState[], removed: string[] }} State
 */

const ENV_FIELDS = /** @type {const} */ (['url', 'user', 'role', 'allow_clean', 'placeholders', 'shared'])
const PROJECT_FIELDS = /** @type {const} */ (['name', 'migrations', 'schemas', 'history_table', 'filters', 'lock', 'placeholders'])
const same = (/** @type {unknown} */ a, /** @type {unknown} */ b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * What to send to `liftoff settings --save`: the project when any of it changed, the environments
 * that are new or changed (a password only when one was typed), and the ones removed.
 * @param {Settings} original
 * @param {State} state
 */
function changeOf(original, state) {
  /** @type {{ project?: Omit<Project, 'engine'>, environments?: object[], remove?: string[] }} */
  const change = {}
  if (PROJECT_FIELDS.some((k) => !same(original.project[k], state.project[k]))) {
    const { engine: _engine, ...project } = state.project
    change.project = project
  }
  const envs = state.environments.filter((e) => {
    const old = original.environments.find((o) => o.name === e.name)
    return e.isNew || !old || e.password !== '' || ENV_FIELDS.some((k) => !same(normal(old)[k], normal(e)[k]))
  })
  if (envs.length) {
    change.environments = envs.map((e) => ({
      name: e.name,
      url: e.url.trim(),
      user: e.user?.trim() ? e.user.trim() : null,
      ...(e.password !== '' ? { password: e.password } : {}),
      role: e.role,
      allow_clean: e.allow_clean,
      placeholders: e.placeholders,
      shared: e.shared,
    }))
  }
  const removed = state.removed.filter((n) => original.environments.some((o) => o.name === n))
  if (removed.length) change.remove = removed
  return change
}

/** @param {Env} e */
const normal = (e) => ({ ...e, user: e.user?.trim() ? e.user.trim() : null })

/**
 * Problems that stop a save, keyed by the id of the field they belong to.
 * @param {State} state
 */
function problemsOf(state) {
  /** @type {Record<string, string>} */
  const p = {}
  if (!state.project.name.trim()) p['project-name'] = 'Give the project a name.'
  if (!state.project.migrations.trim()) p['project-migrations'] = 'Name the folder the scripts are in.'
  else if (state.project.migrations.includes('..') || /^([a-z]:|\/|\\)/i.test(state.project.migrations)) p['project-migrations'] = 'Use a folder inside the project folder.'
  if (!state.project.schemas.length) p['project-schemas'] = 'At least one schema.'
  if (!state.project.history_table.trim()) p['project-history'] = 'Name the history table.'
  state.project.filters.forEach((f, i) => {
    if (!f.pattern.trim()) p[`filter-${i}-pattern`] = 'A name or pattern, e.g. audit_*'
  })
  const names = new Set()
  state.environments.forEach((e, i) => {
    if (!/^[A-Za-z0-9_-]+$/.test(e.name)) p[`env-${i}-name`] = 'Letters, digits, - and _ only.'
    else if (names.has(e.name)) p[`env-${i}-name`] = 'Another environment has this name.'
    names.add(e.name)
    if (!e.url.trim()) p[`env-${i}-url`] = 'The connection URL is needed.'
  })
  return p
}

if (typeof module === 'object') module.exports = { changeOf, problemsOf }

/* ---------- the page ---------- */

if (typeof document !== 'undefined') {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi()
  const app = /** @type {HTMLElement} */ (document.getElementById('app'))
  /** @type {Settings} */
  let original
  /** @type {State} */
  let state
  /** @type {Record<string, string>} */
  let problems = {}
  let status = { text: '', tone: '' }
  /** @type {string | undefined} */
  let openEnv

  const ROLES = {
    dev: 'Dev: changed by hand; compared with the schema model',
    scratch: 'Scratch: rebuilt by LiftOff for comparisons',
    test: 'Test: gets the migrations',
    prod: 'Production: gets the migrations, with confirmation',
  }
  const OBJECTS = ['any', 'table', 'view', 'function', 'type', 'sequence', 'trigger', 'extension']

  /**
   * @param {string} tag
   * @param {Record<string, unknown>} [attrs]
   * @param {(Node | string | false | undefined | null)[]} [children]
   */
  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === false || v === null) continue
      if (k.startsWith('on')) n.addEventListener(k.slice(2), /** @type {EventListener} */ (v))
      else if (k === 'value') /** @type {HTMLInputElement} */ (n).value = String(v)
      else if (k === 'checked') /** @type {HTMLInputElement} */ (n).checked = Boolean(v)
      else if (k === 'text') n.textContent = String(v)
      else n.setAttribute(k, v === true ? '' : String(v))
    }
    for (const c of children) if (c !== undefined && c !== null && c !== false) n.append(c)
    return n
  }

  /**
   * A labelled field: label, control, help, and its problem when there is one.
   * @param {string} id
   * @param {string} label
   * @param {HTMLElement} control
   * @param {string} [help]
   */
  function field(id, label, control, help) {
    control.id = id
    const problem = problems[id]
    const describedBy = [help && `${id}-help`, problem && `${id}-problem`].filter(Boolean).join(' ')
    if (describedBy) control.setAttribute('aria-describedby', describedBy)
    if (problem) control.setAttribute('aria-invalid', 'true')
    return el('div', { class: 'field' }, [
      el('label', { for: id, text: label }),
      control,
      help && el('p', { class: 'help', id: `${id}-help`, text: help }),
      problem && el('p', { class: 'problem', id: `${id}-problem`, text: problem }),
    ])
  }

  /**
   * A text input bound to `get`/`set`; typing does not rebuild the page.
   * @param {string} value
   * @param {(v: string) => void} set
   * @param {Record<string, unknown>} [attrs]
   */
  function input(value, set, attrs = {}) {
    return el('input', { type: 'text', value, spellcheck: 'false', ...attrs, oninput: (/** @type {Event} */ e) => { set(/** @type {HTMLInputElement} */ (e.target).value); touched() } })
  }

  /**
   * @param {string} value
   * @param {Record<string, string>} options
   * @param {(v: string) => void} set
   * @param {boolean} [rebuild]
   * @param {string} [label] an accessible name, when there is no <label> for it
   */
  function select(value, options, set, rebuild = false, label = undefined) {
    return el(
      'select',
      { 'aria-label': label, onchange: (/** @type {Event} */ e) => { set(/** @type {HTMLSelectElement} */ (e.target).value); rebuild ? render() : touched() } },
      Object.entries(options).map(([v, label]) => el('option', { value: v, selected: v === value, text: label })),
    )
  }

  /**
   * Name/value rows for placeholders.
   * @param {string} id
   * @param {Record<string, string>} map
   * @param {(m: Record<string, string>) => void} set
   */
  function placeholderRows(id, map, set) {
    const rows = Object.entries(map)
    const write = (/** @type {[string, string][]} */ r) => set(Object.fromEntries(r))
    return el('div', { class: 'rows' }, [
      rows.length ? null : el('p', { class: 'muted', text: 'None.' }),
      ...rows.map(([k, v], i) =>
        el('div', { class: 'row' }, [
          el('input', { type: 'text', value: k, 'aria-label': `Placeholder ${i + 1} name`, placeholder: 'name', spellcheck: 'false', oninput: (/** @type {Event} */ e) => { rows[i][0] = /** @type {HTMLInputElement} */ (e.target).value; write(rows); touched() } }),
          el('input', { type: 'text', value: v, 'aria-label': `Placeholder ${i + 1} value`, placeholder: 'value', spellcheck: 'false', oninput: (/** @type {Event} */ e) => { rows[i][1] = /** @type {HTMLInputElement} */ (e.target).value; write(rows); touched() } }),
          el('button', { class: 'secondary', type: 'button', text: 'Remove', 'aria-label': `Remove placeholder ${k || i + 1}`, onclick: () => { rows.splice(i, 1); write(rows); render() } }),
        ]),
      ),
      el('button', { class: 'secondary', type: 'button', id, text: 'Add placeholder', onclick: () => { rows.push([`name${rows.length + 1}`, '']); write(rows); render() } }),
    ])
  }

  function projectSection() {
    const p = state.project
    return el('section', { 'aria-labelledby': 'h-project' }, [
      el('h2', { id: 'h-project', text: 'Project' }),
      field('project-name', 'Name', input(p.name, (v) => (p.name = v))),
      field('project-engine', 'Database engine', el('input', { type: 'text', value: p.engine === 'sqlserver' ? 'SQL Server' : 'PostgreSQL', readonly: true }), 'Set when the project was created.'),
      field('project-migrations', 'Migrations folder', input(p.migrations, (v) => (p.migrations = v)), 'Where the V, U, R and B scripts are, relative to the project folder.'),
      field(
        'project-schemas',
        'Schemas',
        input(p.schemas.join(', '), (v) => (p.schemas = v.split(',').map((s) => s.trim()).filter(Boolean))),
        'Comma-separated. LiftOff manages these schemas; the first one holds the history table.',
      ),
      field('project-history', 'History table', input(p.history_table, (v) => (p.history_table = v)), 'The table that records which scripts ran.'),
      field(
        'project-lock',
        'Lock while migrating',
        select(p.lock, { advisory: 'Database lock (the default)', table: 'Lease row in a table (for PgBouncer and other poolers)' }, (v) => (p.lock = /** @type {'advisory' | 'table'} */ (v))),
        'Keeps two runs on the same database from colliding.',
      ),
      el('h3', { text: 'Placeholders' }),
      el('p', { class: 'help', text: 'Replace ${name} in every script. For a secret, use ${env.VARIABLE} as the value. An environment can override them.' }),
      placeholderRows('project-placeholders-add', p.placeholders, (m) => (p.placeholders = m)),
    ])
  }

  function filtersSection() {
    const f = state.project.filters
    const move = (/** @type {number} */ i, /** @type {number} */ d) => {
      ;[f[i], f[i + d]] = [f[i + d], f[i]]
      render()
    }
    return el('section', { 'aria-labelledby': 'h-filters' }, [
      el('h2', { id: 'h-filters', text: 'Comparison filters' }),
      el('p', { class: 'help', text: 'What comparisons, generated migrations and drift checks look at. Filters run in order; the last one that matches an object decides.' }),
      f.length ? null : el('p', { class: 'muted', text: 'No filters: everything in the schemas is compared.' }),
      ...f.map((x, i) =>
        el('div', { class: 'row filter' }, [
          select(x.action, { include: 'Include', exclude: 'Exclude' }, (v) => (x.action = /** @type {'include' | 'exclude'} */ (v)), false, `Filter ${i + 1}: include or exclude`),
          select(x.object, Object.fromEntries(OBJECTS.map((o) => [o, o === 'any' ? 'any object' : `${o}s`])), (v) => (x.object = v), false, `Filter ${i + 1}: kind of object`),
          field(`filter-${i}-pattern`, `Filter ${i + 1} pattern`, input(x.pattern, (v) => (x.pattern = v), { placeholder: 'audit_* or sales.*' })),
          el('button', { class: 'secondary', type: 'button', text: '↑', 'aria-label': `Move filter ${i + 1} up`, disabled: i === 0, onclick: () => move(i, -1) }),
          el('button', { class: 'secondary', type: 'button', text: '↓', 'aria-label': `Move filter ${i + 1} down`, disabled: i === f.length - 1, onclick: () => move(i, 1) }),
          el('button', { class: 'secondary', type: 'button', text: 'Remove', 'aria-label': `Remove filter ${i + 1}`, onclick: () => { f.splice(i, 1); render() } }),
        ]),
      ),
      el('button', { class: 'secondary', type: 'button', text: 'Add filter', onclick: () => { f.push({ action: 'exclude', object: 'table', pattern: '' }); render() } }),
    ])
  }

  /** @param {EnvState} e @param {number} i */
  function environmentCard(e, i) {
    const old = original.environments.find((o) => o.name === e.name)
    const changed = e.isNew || !old || e.password !== '' || ENV_FIELDS.some((k) => !same(normal(old)[k], normal(e)[k]))
    const id = (/** @type {string} */ f) => `env-${i}-${f}`
    const details = el('details', { open: openEnv === e.name || e.isNew || Object.keys(problems).some((k) => k.startsWith(`env-${i}-`)) }, [
      el('summary', {}, [
        el('span', { class: 'env-name', text: e.name || 'New environment' }),
        el('span', { class: 'badge', text: e.role }),
        e.shared ? null : el('span', { class: 'muted', text: 'this computer only' }),
        changed ? el('span', { class: 'unsaved', text: 'unsaved' }) : null,
      ]),
      e.isNew ? field(id('name'), 'Name', input(e.name, (v) => (e.name = v), { placeholder: 'staging' }), 'Letters, digits, - and _. Used as -e <name> on the command line.') : null,
      field(
        id('url'),
        'Connection URL',
        input(e.url, (v) => (e.url = v), { placeholder: state.project.engine === 'sqlserver' ? 'sqlserver://host:1433;databaseName=shop;encrypt=true' : 'postgres://host:5432/shop' }),
        'Use ${env.NAME} to read part of it from an environment variable.',
      ),
      field(id('user'), 'User', input(e.user ?? '', (v) => (e.user = v))),
      field(
        id('password'),
        'Password',
        el('input', {
          type: 'password',
          value: e.password,
          autocomplete: 'off',
          placeholder: e.has_password ? 'Stored. Type a new one to replace it.' : 'None stored.',
          oninput: (/** @type {Event} */ ev) => { e.password = /** @type {HTMLInputElement} */ (ev.target).value; touched() },
        }),
        'Kept in your operating system keychain (or liftoff.user.toml), never in liftoff.toml.',
      ),
      field(id('role'), 'Role', select(e.role, ROLES, (v) => { e.role = /** @type {EnvState['role']} */ (v); if (v === 'prod') e.allow_clean = false }, true)),
      el('div', { class: 'field check' }, [
        el('input', { type: 'checkbox', id: id('clean'), checked: e.allow_clean, disabled: e.role === 'prod', onchange: (/** @type {Event} */ ev) => { e.allow_clean = /** @type {HTMLInputElement} */ (ev.target).checked; touched() } }),
        el('label', { for: id('clean'), text: e.role === 'prod' ? 'Allow clean (never on production)' : 'Allow clean: erase everything in its schemas on request' }),
      ]),
      field(
        id('shared'),
        'Stored in',
        select(e.shared ? 'shared' : 'mine', { shared: 'liftoff.toml: shared with the team through git', mine: 'liftoff.user.toml: this computer only' }, (v) => (e.shared = v === 'shared'), true),
      ),
      el('h3', { text: 'Placeholders for this environment' }),
      placeholderRows(id('placeholders-add'), e.placeholders, (m) => (e.placeholders = m)),
      el('div', { class: 'actions' }, [
        el('button', {
          class: 'secondary',
          type: 'button',
          text: 'Test connection',
          onclick: () => {
            if (changed) setStatus(`Save ${e.name || 'the new environment'} first, then test it.`, 'warn')
            else {
              setStatus(`Connecting to ${e.name}…`, '')
              vscode.postMessage({ type: 'test', name: e.name })
            }
          },
        }),
        el('button', {
          class: 'secondary danger',
          type: 'button',
          text: 'Remove environment',
          onclick: () => {
            state.environments.splice(i, 1)
            if (!e.isNew) state.removed.push(e.name)
            render()
          },
        }),
      ]),
    ])
    details.addEventListener('toggle', () => {
      if (/** @type {HTMLDetailsElement} */ (details).open) openEnv = e.name
    })
    return details
  }

  function environmentsSection() {
    return el('section', { 'aria-labelledby': 'h-envs' }, [
      el('h2', { id: 'h-envs', text: 'Environments' }),
      el('p', { class: 'help', text: 'The databases this project works with. Values set by LIFTOFF_ENV_<NAME>_* variables (for example in CI) win over these.' }),
      ...state.environments.map(environmentCard),
      el('button', {
        class: 'secondary',
        type: 'button',
        text: 'Add environment',
        onclick: () => {
          state.environments.push({ name: '', url: '', user: null, role: 'test', allow_clean: false, placeholders: {}, shared: true, has_password: false, password: '', isNew: true })
          render()
        },
      }),
    ])
  }

  function footer() {
    const dirty = Object.keys(changeOf(original, state)).length > 0
    return el('footer', {}, [
      el('button', { type: 'button', id: 'save', text: 'Save', disabled: !dirty, onclick: save }),
      el('button', { class: 'secondary', type: 'button', id: 'revert', text: 'Discard changes', disabled: !dirty, onclick: () => { load(original); setStatus('Changes discarded.', '') } }),
      el('p', { id: 'status', class: `status ${status.tone}`, role: status.tone === 'error' ? 'alert' : 'status', text: status.text || (dirty ? 'Unsaved changes.' : '') }),
    ])
  }

  function render() {
    app.replaceChildren(el('h1', { text: `LiftOff settings: ${original.project.name}` }), projectSection(), filtersSection(), environmentsSection(), footer())
    app.removeAttribute('aria-busy')
  }

  /** After typing: only the footer changes (the save button and the status). */
  function touched() {
    if (status.tone !== 'error') status = { text: '', tone: '' }
    app.querySelector('footer')?.replaceWith(footer())
  }

  /** @param {string} text @param {string} tone */
  function setStatus(text, tone) {
    status = { text, tone }
    app.querySelector('footer')?.replaceWith(footer())
  }

  function save() {
    problems = problemsOf(state)
    if (Object.keys(problems).length) {
      status = { text: `${Object.keys(problems).length} field(s) need attention before saving.`, tone: 'error' }
      render()
      const first = document.getElementById(Object.keys(problems)[0])
      first?.closest('details')?.setAttribute('open', '')
      first?.focus()
      return
    }
    setStatus('Saving…', '')
    vscode.postMessage({ type: 'save', change: changeOf(original, state) })
  }

  /** @param {Settings} s */
  function load(s) {
    original = s
    state = {
      project: structuredClone(s.project),
      environments: s.environments.map((e) => ({ ...structuredClone(e), password: '', isNew: false })),
      removed: [],
    }
    problems = {}
    render()
  }

  window.addEventListener('message', (/** @type {MessageEvent} */ ev) => {
    const m = ev.data
    if (m.type === 'settings') {
      openEnv = m.focus
      status = { text: '', tone: '' }
      load(m.settings)
      if (m.focus) document.querySelector(`details[open] summary`)?.scrollIntoView()
    } else if (m.type === 'saved') {
      status = { text: 'Saved.', tone: 'ok' }
      load(m.settings)
    } else if (m.type === 'error') {
      if (!original) app.replaceChildren(el('p', { class: 'status error', role: 'alert', text: m.message }))
      else setStatus(m.message, 'error')
    } else if (m.type === 'tested') {
      setStatus(m.message, m.ok ? 'ok' : 'error')
    }
  })
  vscode.postMessage({ type: 'ready' })
}
