import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'
import { Config, init, saveRules, type Engine } from './config.ts'
import { LiftoffError } from './errors.ts'
import { parseVersion } from './migration.ts'
import { lint, lintScript, NO_RULES, parseRules, type RulesConfig } from './rules.ts'

const v = (text: string) => parseVersion(text)
/** rule:line for each finding, so a test reads like the expected report */
function run(sql: string, engine: Engine = 'postgresql', rules: RulesConfig = NO_RULES, kind: 'versioned' | 'repeatable' = 'repeatable'): string[] {
  return lintScript({ fileName: 'V1__x.sql', sql, kind, version: kind === 'versioned' ? v('1') : undefined }, engine, rules).map(
    (f) => `${f.rule}:${f.line}${f.allowed !== undefined ? ' allowed' : ''}`,
  )
}

test('drop table, drop column and truncate are reported; dropping a constraint or default is not', () => {
  assert.deepEqual(run('DROP TABLE IF EXISTS public.orders, items;'), ['drop-table:1', 'drop-table:1'])
  assert.deepEqual(run('ALTER TABLE t DROP COLUMN a;\nALTER TABLE t DROP b;'), ['drop-column:1', 'drop-column:2'])
  assert.deepEqual(run('ALTER TABLE t DROP CONSTRAINT pk;\nALTER TABLE t ALTER COLUMN c DROP DEFAULT;\nALTER TABLE t ALTER COLUMN c DROP NOT NULL;'), [])
  // SQL Server: a bare DROP is a constraint; DROP COLUMN takes a list
  assert.deepEqual(run('ALTER TABLE t DROP pk_t\nALTER TABLE t DROP COLUMN a, b', 'sqlserver'), ['drop-column:2', 'drop-column:2'])
  assert.deepEqual(run('TRUNCATE TABLE audit;'), ['truncate:1'])
})

test('DELETE and UPDATE without WHERE, also without semicolons; ON DELETE and triggers are not statements', () => {
  assert.deepEqual(run('DELETE FROM t;\nUPDATE t SET a = 1;\nDELETE FROM t WHERE id = 1;\nUPDATE t SET a = 1 WHERE b = 2;'), ['delete-without-where:1', 'update-without-where:2'])
  // T-SQL batches often have no semicolons: the next statement's WHERE must not count
  assert.deepEqual(run('DELETE FROM t\nSELECT a FROM x WHERE a = 1\nUPDATE TOP (10) t SET a = CASE WHEN b = 1 THEN 2 END WHERE c = 3', 'sqlserver'), ['delete-without-where:1'])
  assert.deepEqual(
    run('CREATE TABLE c (id int PRIMARY KEY, p int REFERENCES p ON DELETE CASCADE ON UPDATE SET NULL);\nGRANT SELECT, UPDATE, DELETE ON c TO app;\nSELECT * FROM c FOR UPDATE;'),
    ['permissions:2', 'select-star:3'],
  )
  assert.deepEqual(run("CREATE TRIGGER tr ON t AFTER INSERT, UPDATE AS BEGIN IF UPDATE(a) PRINT 'x' END\nGO\nUPDATE STATISTICS t", 'sqlserver'), [])
})

test('comments, strings, quoted names and function bodies do not count', () => {
  const sql = [
    '-- DROP TABLE a;',
    '/* DELETE FROM a; /* nested */ TRUNCATE a; */',
    "INSERT INTO log VALUES ('DROP TABLE b; DELETE FROM b', E'it\\'s; DROP TABLE c');",
    'CREATE TABLE "delete" (id int PRIMARY KEY, "update" int);',
    'CREATE FUNCTION f() RETURNS void AS $body$ DELETE FROM t; $body$ LANGUAGE sql;',
  ].join('\n')
  assert.deepEqual(run(sql), [])
  assert.deepEqual(run("CREATE TABLE [delete] (id int PRIMARY KEY)\nPRINT 'TRUNCATE TABLE x'", 'sqlserver'), [])
})

test('tables need a primary key, in the statement or later in the script; temporary tables do not', () => {
  assert.deepEqual(run('CREATE TABLE a (id int);'), ['table-without-primary-key:1'])
  assert.deepEqual(run('CREATE TABLE a (id int);\nALTER TABLE a ADD CONSTRAINT pk_a PRIMARY KEY (id);'), [])
  assert.deepEqual(run('CREATE TEMP TABLE a (id int);\nCREATE TABLE b AS SELECT 1 AS x;\nCREATE TABLE p1 PARTITION OF p FOR VALUES IN (1);'), [])
  assert.deepEqual(run('CREATE TABLE #a (id int)', 'sqlserver'), [])
})

test('a NOT NULL column without a default on an existing table', () => {
  assert.deepEqual(run('ALTER TABLE t ADD COLUMN a int NOT NULL;'), ['not-null-without-default:1'])
  assert.deepEqual(run('ALTER TABLE t ADD COLUMN a int NOT NULL DEFAULT 0, ADD COLUMN b bigserial NOT NULL, ADD COLUMN c int;'), [])
  assert.deepEqual(run('ALTER TABLE t ADD a int NULL, b int NOT NULL', 'sqlserver'), ['not-null-without-default:1'])
  // the table is new in this script, so it is empty
  assert.deepEqual(run('CREATE TABLE t (id int PRIMARY KEY);\nALTER TABLE t ADD COLUMN a int NOT NULL;'), [])
  assert.deepEqual(run('ALTER TABLE t ADD CONSTRAINT u UNIQUE (a);'), [])
})

test('select star, grants, users and USE', () => {
  assert.deepEqual(run('CREATE VIEW v AS SELECT * FROM t;\nSELECT count(*) FROM t WHERE EXISTS (SELECT * FROM u);'), ['select-star:1'])
  assert.deepEqual(run('GRANT SELECT ON t TO PUBLIC WITH GRANT OPTION;'), ['grant-option:1', 'grant-to-public:1', 'permissions:1'])
  assert.deepEqual(run('CREATE ROLE reporting;\nALTER USER app WITH PASSWORD NULL;'), ['users-and-roles:1', 'users-and-roles:2'])
  assert.deepEqual(run("USE other\nEXEC sp_addrolemember 'db_owner', 'x'", 'sqlserver'), ['use-database:1', 'users-and-roles:2'])
  assert.deepEqual(run('USE other;'), [], 'USE is a SQL Server rule')
})

test('sensitive column names, naming patterns and the undo-script rule', () => {
  assert.deepEqual(run('CREATE TABLE p (id int PRIMARY KEY, customer_ssn text, DateOfBirth date, iban text, name text);'), [
    'sensitive-columns:1',
    'sensitive-columns:1',
    'sensitive-columns:1',
  ])
  const rules = parseRules({ 'table-names': { pattern: '^[a-z_]+$' }, 'column-names': { severity: 'error', pattern: '^[a-z_]+$' }, 'sensitive-columns': 'off' })
  assert.deepEqual(run('CREATE TABLE Orders (id int PRIMARY KEY, OrderDate date);', 'postgresql', rules), ['column-names:1', 'table-names:1'])
  const undo = parseRules({ 'undo-script': 'warn' })
  assert.deepEqual(run('SELECT 1;', 'postgresql', undo, 'versioned'), ['undo-script:1'])
  assert.deepEqual(lintScript({ fileName: 'V1__x.sql', sql: 'SELECT 1;', kind: 'versioned', version: v('1') }, 'postgresql', undo, [{ kind: 'undo', version: v('1') }]), [])
})

test('severities from liftoff.toml, custom rules and allow comments', () => {
  const rules = parseRules({ 'drop-table': 'error', truncate: 'off', custom: [{ id: 'no-cascade', pattern: 'ON\\s+DELETE\\s+CASCADE', message: 'no cascading deletes' }] })
  const f = lintScript(
    { fileName: 'V2__y.sql', sql: 'DROP TABLE a;\nTRUNCATE b;\nCREATE TABLE c (id int PRIMARY KEY, p int REFERENCES p ON DELETE CASCADE);', kind: 'versioned', version: v('2') },
    'postgresql',
    rules,
  )
  assert.deepEqual(
    f.map((x) => [x.rule, x.severity, x.line]),
    [
      ['drop-table', 'error', 1],
      ['no-cascade', 'warn', 3],
    ],
  )
  assert.deepEqual(run('-- liftoff:allow drop-table, truncate: replaced by the archive table\nDROP TABLE a;\nTRUNCATE b;'), ['drop-table:2 allowed', 'truncate:3 allowed'])
  const allowed = lintScript({ fileName: 'x', sql: '-- liftoff:allow drop-table: gone\nDROP TABLE a;', kind: 'repeatable', version: undefined }, 'postgresql', NO_RULES)
  assert.equal(allowed[0].allowed, 'gone')
  assert.throws(() => run('-- liftoff:allow drop-tabel\nDROP TABLE a;'), (e: LiftoffError) => e.code === 'LIFTOFF_CONFIG' && /drop-tabel/.test(e.message))
  assert.throws(() => parseRules({ 'drop-table': 'loud' }), /off, info, warn or error/)
  assert.throws(() => lintScript({ fileName: 'x', sql: '', kind: 'repeatable', version: undefined }, 'postgresql', parseRules({ nope: 'warn' })), /no rule 'nope'/)
  assert.throws(() => lintScript({ fileName: 'x', sql: '', kind: 'repeatable', version: undefined }, 'postgresql', parseRules({ 'table-names': 'warn' })), /needs a pattern/)
  assert.throws(() => parseRules({ custom: [{ id: 'x', pattern: '(', message: 'm' }] }), /not a valid regular expression/)
})

test('lint reads [rules] from liftoff.toml, skips undo scripts, and --since picks only what the branch adds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-lint-'))
  const git = (...args: string[]) => assert.equal(spawnSync('git', args, { cwd: dir }).status, 0)
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  init(dir, 'shop', 'postgresql')
  fs.appendFileSync(path.join(dir, 'liftoff.toml'), '\n[rules]\ndrop-table = "error"\n')
  const m = (f: string, sql: string) => fs.writeFileSync(path.join(dir, 'migrations', f), sql)
  m('V0001__old.sql', 'DROP TABLE legacy;\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  m('V0002__new.sql', 'TRUNCATE audit;\n')
  m('U0002__new.sql', 'DROP TABLE audit;\n')
  const cfg = Config.load(dir)
  const all = lint(cfg)
  assert.deepEqual(all.scripts, ['V0001__old.sql', 'V0002__new.sql'])
  assert.deepEqual([all.errors, all.warnings], [1, 1])
  const mine = lint(cfg, { since: 'main' })
  assert.deepEqual(mine.scripts, ['V0002__new.sql'])
  assert.deepEqual([mine.errors, mine.warnings], [0, 1])
  assert.throws(() => lint(cfg, { scripts: ['V9__nope.sql'] }), /no script V9__nope.sql/)
})

test('saveRules writes only what differs from the defaults, keeps the rest of liftoff.toml, and refuses a bad pattern', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-rules-'))
  init(dir, 'shop', 'postgresql')
  saveRules(dir, {
    settings: { 'drop-table': { severity: 'error' }, truncate: { severity: 'warn' }, 'table-names': { severity: 'warn', pattern: '^[a-z_]+$' } },
    custom: [{ id: 'no-cascade', pattern: '\bCASCADE\b', message: 'No CASCADE', severity: 'error' }],
  })
  const cfg = Config.load(dir)
  assert.equal(cfg.project.name, 'shop')
  assert.deepEqual(cfg.rules.settings, { 'drop-table': { severity: 'error' }, 'table-names': { severity: 'warn', pattern: '^[a-z_]+$' } })
  assert.equal(cfg.rules.custom[0].pattern, '\bCASCADE\b')
  assert.throws(() => saveRules(dir, { settings: { 'column-names': { severity: 'warn' } }, custom: [] }), /needs a pattern/)
  assert.throws(() => saveRules(dir, { settings: {}, custom: [{ id: 'x', pattern: '(', message: 'm', severity: 'warn' }] }), /not a valid regular expression/)
  saveRules(dir, NO_RULES)
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'liftoff.toml'), 'utf8'), /rules/)
})
