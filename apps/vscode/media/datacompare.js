// @ts-check
// The LiftOff Data Compare page (inside a VS Code webview; see src/dataCompare.ts).
// Shows the tables with their counts; a count opens that table's differing rows as a grid, a page
// at a time. Every value is set as text, never as HTML.

// @ts-ignore: provided by VS Code inside the webview
const vscode = acquireVsCodeApi()
const app = /** @type {HTMLElement} */ (document.getElementById('app'))

/** @type {any} the last `liftoff data-compare` result */
let result

const KINDS = /** @type {const} */ ([
  ['only_in_source', 'only in the source'],
  ['only_in_target', 'only in the target'],
  ['different', 'different'],
])

/**
 * @param {string} tag
 * @param {Record<string, string>} [attrs]
 * @param {(Node | string)[]} [children]
 */
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  e.append(...children)
  return e
}

/** @param {string} label @param {() => void} onClick @param {string} [cls] */
function button(label, onClick, cls = '') {
  const b = el('button', cls ? { type: 'button', class: cls } : { type: 'button' }, [label])
  b.addEventListener('click', onClick)
  return b
}

function renderResult() {
  const r = result
  const total = r.tables.reduce((/** @type {number} */ s, /** @type {any} */ t) => s + t.only_in_source + t.only_in_target + t.different, 0)
  const head = el('tr', {}, ['Table', 'Rows (source / target)', ...KINDS.map(([, label]) => label)].map((h) => el('th', { scope: 'col' }, [h])))
  const body = r.tables.map((/** @type {any} */ t) =>
    el('tr', {}, [
      el('th', { scope: 'row' }, [t.table]),
      ...(t.skipped
        ? [el('td', { colspan: '4', class: 'muted' }, [`not compared: ${t.skipped}`])]
        : [
            el('td', { class: 'num' }, [`${t.source_rows} / ${t.target_rows}`]),
            ...KINDS.map(([kind]) =>
              el('td', { class: 'num' }, [t[kind] ? button(String(t[kind]), () => ask(t.table, kind, 0), 'link') : '0']),
            ),
          ]),
    ]),
  )
  app.replaceChildren(
    el('h1', {}, [`${r.target} → ${r.source}`]),
    el('p', { class: 'muted' }, [`${r.engine}, compared in ${(r.ms / 1000).toFixed(1)} s. ${total ? `${total} row(s) differ.` : `The rows of ${r.target} match ${r.source}.`}`]),
    el('div', { class: 'actions' }, [
      button('Compare Again', () => send({ type: 'again' }), 'secondary'),
      button('Swap Source and Target', () => send({ type: 'swap' }), 'secondary'),
      ...(total ? [button('Open the Sync Script', () => send({ type: 'script' }), 'secondary'), button('Apply to the Target…', () => send({ type: 'apply' }))] : []),
    ]),
    el('table', { class: 'grid' }, [el('thead', {}, [head]), el('tbody', {}, body)]),
    el('section', { id: 'rows' }),
  )
  app.removeAttribute('aria-busy')
}

/** @param {string} table @param {string} kind @param {number} offset */
function ask(table, kind, offset) {
  const rows = document.getElementById('rows')
  rows?.replaceChildren(el('p', { class: 'muted' }, ['Reading the rows…']))
  send({ type: 'page', table, kind, offset })
}

/** @param {{ table: string, kind: string, offset: number, limit: number, page: any }} m */
function renderRows(m) {
  const rows = document.getElementById('rows')
  if (!rows || !m.page) return
  const { columns, key, total } = m.page
  const label = KINDS.find(([k]) => k === m.kind)?.[1] ?? m.kind
  const end = m.offset + m.page.rows.length
  /** @param {string} side @param {(string | null)[]} values @param {(string | null)[] | null} other */
  const line = (side, values, other) =>
    el('tr', { class: side }, [
      el('th', { scope: 'row', class: 'muted' }, [side]),
      ...values.map((v, i) => el('td', other && other[i] !== v ? { class: 'changed' } : {}, [v === null ? el('span', { class: 'null' }, ['NULL']) : v])),
    ])
  const body = m.page.rows.flatMap((/** @type {any} */ r) => [
    ...(r.source ? [line('source', r.source, r.target)] : []),
    ...(r.target ? [line('target', r.target, r.source)] : []),
  ])
  rows.replaceChildren(
    el('h2', {}, [`${m.table}: ${label}`]),
    el('div', { class: 'actions' }, [
      el('span', { class: 'muted' }, [total ? `${m.offset + 1}–${end} of ${total}` : 'none']),
      ...(m.offset > 0 ? [button('Previous', () => ask(m.table, m.kind, Math.max(0, m.offset - m.limit)), 'secondary')] : []),
      ...(end < total ? [button('Next', () => ask(m.table, m.kind, end), 'secondary')] : []),
    ]),
    el('div', { class: 'scroll' }, [
      el('table', { class: 'grid' }, [
        el('thead', {}, [el('tr', {}, [el('th', {}, ['']), ...columns.map((/** @type {string} */ c) => el('th', { scope: 'col', ...(key.includes(c) ? { title: 'key' } : {}) }, [key.includes(c) ? `🔑 ${c}` : c]))])]),
        el('tbody', {}, body),
      ]),
    ]),
  )
}

/** @param {unknown} m */
function send(m) {
  vscode.postMessage(m)
}

window.addEventListener('message', (e) => {
  const m = e.data
  if (m.type === 'result') {
    result = m.result
    renderResult()
  } else if (m.type === 'rows') renderRows(m)
  else if (m.type === 'busy') {
    result = undefined
    app.setAttribute('aria-busy', 'true')
    app.replaceChildren(el('p', { class: 'muted' }, [m.text]))
  } else if (m.type === 'error') {
    const where = document.getElementById('rows') ?? app
    where.replaceChildren(el('p', { class: 'problem', role: 'alert' }, [m.message]), ...(result ? [] : [button('Compare Again', () => send({ type: 'again' }))]))
    app.removeAttribute('aria-busy')
  }
})

send({ type: 'ready' })
