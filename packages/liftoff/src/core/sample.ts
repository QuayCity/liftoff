// The sample project (S01, "Try the sample"): a small shop schema to look around in before
// pointing LiftOff at a real database.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { init } from './config.ts'
import { configError } from './errors.ts'

const POSTGRES: Record<string, string> = {
  'V0001__customers.sql': `-- A first table. Versioned scripts run once, in version order.
create table customers (
    id bigint generated always as identity primary key,
    email text not null unique,
    created_at timestamptz not null default now()
);
`,
  'V0002__orders.sql': `create table orders (
    id bigint generated always as identity primary key,
    customer_id bigint not null references customers (id),
    total numeric(10, 2) not null default 0,
    placed_at timestamptz not null default now()
);
`,
  'V0003__orders_by_customer.sql': `-- Runs outside a transaction: CREATE INDEX CONCURRENTLY cannot run inside one.
create index concurrently orders_customer_idx on orders (customer_id);
`,
  'U0003__orders_by_customer.sql': `-- Undo for V0003: \`liftoff undo\` runs it when V0003 is the latest applied script.
drop index if exists orders_customer_idx;
`,
  'R__customer_totals.sql': `-- Repeatable: runs again whenever this file changes.
create or replace view customer_totals as
select c.id, c.email, count(o.id) as orders, coalesce(sum(o.total), 0) as spent
from customers c
left join orders o on o.customer_id = c.id
group by c.id, c.email;
`,
}

/** The same shop in T-SQL. */
const SQLSERVER: Record<string, string> = {
  'V0001__customers.sql': `-- A first table. Versioned scripts run once, in version order.
CREATE TABLE dbo.customers (
    id bigint IDENTITY(1, 1) PRIMARY KEY,
    email nvarchar(320) NOT NULL UNIQUE,
    created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
);
`,
  'V0002__orders.sql': `CREATE TABLE dbo.orders (
    id bigint IDENTITY(1, 1) PRIMARY KEY,
    customer_id bigint NOT NULL REFERENCES dbo.customers (id),
    total decimal(10, 2) NOT NULL DEFAULT 0,
    placed_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
);
`,
  'V0003__orders_by_customer.sql': `-- An index; like every script here, it runs in a transaction and is rolled back if it fails.
CREATE INDEX orders_customer_idx ON dbo.orders (customer_id);
`,
  'U0003__orders_by_customer.sql': `-- Undo for V0003: \`liftoff undo\` runs it when V0003 is the latest applied script.
DROP INDEX IF EXISTS orders_customer_idx ON dbo.orders;
`,
  'R__customer_totals.sql': `-- Repeatable: runs again whenever this file changes.
CREATE OR ALTER VIEW dbo.customer_totals AS
SELECT c.id, c.email, COUNT(o.id) AS orders, COALESCE(SUM(o.total), 0) AS spent
FROM dbo.customers c
LEFT JOIN dbo.orders o ON o.customer_id = c.id
GROUP BY c.id, c.email;
`,
}

const readme = (engine: string) => `# LiftOff sample

Five scripts for a small shop database, in migrations/:

- V0001, V0002 create tables; V0003 adds an index${engine === 'postgresql' ? ' (outside a transaction)' : ''}
- U0003 undoes V0003
- R__customer_totals is a view, run again whenever the file changes

To run them, add an environment (a ${engine === 'sqlserver' ? 'SQL Server' : 'PostgreSQL'} database you may write to), then run the pending
scripts. Change the database by hand and compare it with the scripts to see a migration written for you.
`

/** Writes the sample into `root` (a new or empty folder) and returns it. */
export function createSample(root: string, engine = 'postgresql'): string {
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw configError(`${root} is not empty; pick an empty or new folder for the sample`)
  fs.mkdirSync(root, { recursive: true })
  init(root, 'shop-sample', engine) // refuses an unknown engine before anything else is written
  for (const [file, sql] of Object.entries(engine === 'sqlserver' ? SQLSERVER : POSTGRES)) fs.writeFileSync(path.join(root, 'migrations', file), sql)
  fs.writeFileSync(path.join(root, 'README.md'), readme(engine))
  return root
}
