// The sample project (S01, "Try the sample"): a small shop schema to look around in before
// pointing LiftOff at a real database.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { init } from './config.ts'
import { configError } from './errors.ts'

const SCRIPTS: Record<string, string> = {
  'V1__customers.sql': `-- A first table. Versioned scripts run once, in version order.
create table customers (
    id bigint generated always as identity primary key,
    email text not null unique,
    created_at timestamptz not null default now()
);
`,
  'V2__orders.sql': `create table orders (
    id bigint generated always as identity primary key,
    customer_id bigint not null references customers (id),
    total numeric(10, 2) not null default 0,
    placed_at timestamptz not null default now()
);
`,
  'V3__orders_by_customer.sql': `-- Runs outside a transaction: CREATE INDEX CONCURRENTLY cannot run inside one.
create index concurrently orders_customer_idx on orders (customer_id);
`,
  'U3__orders_by_customer.sql': `-- Undo for V3: \`liftoff undo\` runs it when V3 is the latest applied script.
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

const README = `# LiftOff sample

Five scripts for a small shop database, in migrations/:

- V1, V2 create tables; V3 adds an index (outside a transaction)
- U3 undoes V3
- R__customer_totals is a view, run again whenever the file changes

To run them, add an environment (a PostgreSQL database you may write to), then run the pending
scripts. Change the database by hand and compare it with the scripts to see a migration written for you.
`

/** Writes the sample into `root` (a new or empty folder) and returns it. */
export function createSample(root: string): string {
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw configError(`${root} is not empty; pick an empty or new folder for the sample`)
  fs.mkdirSync(root, { recursive: true })
  init(root, 'shop-sample', 'postgresql')
  for (const [file, sql] of Object.entries(SCRIPTS)) fs.writeFileSync(path.join(root, 'migrations', file), sql)
  fs.writeFileSync(path.join(root, 'README.md'), README)
  return root
}
