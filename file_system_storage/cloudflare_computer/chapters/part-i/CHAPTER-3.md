# Chapter 3 — Durable Storage: From Legacy KV to SQLite

> Verified against official Cloudflare documentation on 2026-08-06. Evidence scope: platform contract, dated current platform behavior, and Cloudflare's published implementation description.

The project named by the `team/project-42` identity scheme—concretely, `acme/project-42` in the running example—has survived its first reconstruction. The `ProjectWorkspace` constructor ran again, rebuilt its caches, and found the project metadata that the previous instance had accepted. That solved one failure mode from Chapter 2: memory disappeared, but committed attached state did not.

Now the project reaches a more demanding transition. A task changes from `in_progress` to `done`, an audit record must explain who made the change, and the caller must not see a success response unless both facts will survive another reconstruction. Three lines of code can appear to do this while answering three different questions:

```text
UPDATE task             Did SQLite execute this statement?
INSERT task_audit       Did both changes commit as one transaction?
return Response.json    Can an external caller observe success yet?
```

Those questions are related, but they are not interchangeable. A synchronous method can return before persistence is confirmed. An asynchronous KV-shaped method can run on a SQLite backend. A set of individually atomic calls is not necessarily one application-level transaction. And a recovery mechanism for the whole database is not user-visible project history.

The invariant for this chapter is therefore more precise than “the object has a database”:

> **Durable Object storage is private, strongly consistent, and transactional within one object; API shape, backend generation, transaction scope, and durability timing are distinct concepts.**

That sentence is the map. The rest of the chapter makes each boundary concrete.

## The storage contract belongs to one object

Every Durable Object has attached storage private to that unique object. `acme/project-42` can open its own storage through `this.ctx.storage`; `acme/project-43` cannot open the same database, and a router Worker cannot query it directly. Another object reaches project 42 by calling its stub, then lets the `ProjectWorkspace` object enforce the project's methods and invariants. Cloudflare's Storage API documentation describes this attached storage as transactional and strongly consistent, while the Durable Objects glossary makes the consistency level explicit as serializable. Each storage method is itself atomic and isolated, including a multi-key method. Larger application changes use an explicit transaction boundary. [Cloudflare's SQLite Storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) and [Durable Objects glossary](https://developers.cloudflare.com/durable-objects/reference/glossary/) define this contract.

The scope matters. The guarantee is not a transaction across all Durable Objects in a namespace, across D1, R2, Workers KV, and an external API. It is the attached storage of one object. If project 42 must coordinate with another project or charge a credit card, those are messages or external effects that need a protocol above the local database transaction.

Attached storage is also not the product named **Workers KV**. Both expose key-value operations, but Workers KV is a separate globally distributed service with a separate binding and consistency model. The key-value methods on `ctx.storage` operate on the Durable Object's private, strongly consistent attached storage. A Durable Object can separately bind to Workers KV, but that is an explicit second store, not where `ctx.storage.put()` writes.

Finally, storage outlives an active JavaScript instance; memory does not. Once a write has been confirmed, eviction, hibernation, deployment, or host failure can cause a new `ProjectWorkspace` instance to be constructed without erasing the accepted database state. That does not make every assignment to a class field durable, nor does it create a shutdown opportunity in which memory can be flushed at the last moment. Durable facts must cross the Storage API boundary before they are relied upon.

## Four axes, not one generation label

Durable Object storage now has two backend generations and several overlapping interfaces. The overlap is intentional compatibility, but it creates a naming trap:

```text
                         API surface
          ┌──────────────────┴──────────────────┐
          │                                     │
   asynchronous KV                      synchronous APIs
   ctx.storage.get/put/...              ctx.storage.sql
          │                             ctx.storage.kv
          │                                     │
          ├──────── works on SQLite ────────────┤
          │                                     │
          └──────── works on legacy KV          └── SQLite only

                 namespace provisioning chooses
                 the storage backend generation

                 transaction scope chooses
                 which changes commit together

                 output gating / sync chooses
                 when success becomes externally visible
```

*Figure 1.3 — API compatibility does not identify the backend. Backend generation, transaction scope, and durability timing are separate choices.*

The four axes are:

1. **API shape.** Is the program calling synchronous SQL, synchronous KV, or the asynchronous KV-compatible interface?
2. **Backend generation.** Was the class namespace provisioned with legacy KV storage or SQLite storage?
3. **Transaction scope.** Is one method atomic, are adjacent writes automatically coalesced, or does an explicit callback define the unit of commit?
4. **Durability timing.** Has code merely executed, has a local transaction completed, or has persistence been confirmed so an output gate may release a message?

The most important diagnostic consequence is simple: an `await this.ctx.storage.get("x")` call does **not** prove that the object is KV-backed. SQLite-backed objects retain the asynchronous KV interface. To identify a backend, inspect the class's provisioned storage configuration, not the punctuation around a method call.

## Provision the running workspace on SQLite

All new code in this book uses a SQLite-backed namespace. As of 2026-08-06, Cloudflare's current class-lifecycle documentation uses a declarative `exports` map and describes SQLite as the recommended and only backend for a newly provisioned namespace through that flow. The relevant portion of the running system's JSONC configuration is:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "compatibility_date": "2026-08-06",
  "durable_objects": {
    "bindings": [
      {
        "name": "PROJECT_WORKSPACES",
        "class_name": "ProjectWorkspace"
      }
    ]
  },
  "exports": {
    "ProjectWorkspace": {
      "type": "durable-object",
      "storage": "sqlite"
    }
  }
}
```

This chooses the backend for every object in the `ProjectWorkspace` class namespace, including the deterministic object reached as `acme/project-42`. It does not create one shared SQLite database for the namespace: each object identity still has private attached storage.

Older Workers may have a historical Wrangler `migrations` array. In that flow, `new_sqlite_classes: ["ProjectWorkspace"]` provisioned a SQLite-backed class, whereas `new_classes` provisioned a legacy KV-backed class. Current docs say a Worker can use either `migrations` or `exports`, not both. Moving an existing Worker from the former configuration shape to the latter preserves the provisioned namespaces and their data; it is a control-plane configuration migration, not a storage-backend or data migration. The backend must be declared to match what was originally provisioned. [Cloudflare's current Durable Object class exports documentation](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/) documents both forms and the transition.

That distinction prevents a destructive misunderstanding. Changing a word in Wrangler does not convert legacy data into SQLite. The current documentation says a provisioned backend is immutable in place. Existing KV-backed namespaces remain supported, but the documented KV-to-SQLite data-migration path is still future work. Deleting and reprovisioning a namespace can change the backend only by losing the old namespace's data; it is not a migration strategy.

> **Dated product note — 2026-08-06.** Current `exports` documentation says SQLite is the only valid backend for newly provisioned namespaces and accepts `legacy-kv` only for an already existing KV-backed namespace. Current plan documentation says Free accounts use SQLite-backed objects only, while KV-backed storage is confined to Paid accounts that already have a KV namespace. Some storage pages phrase the creation restriction more narrowly, saying accounts without an existing KV-backed namespace cannot create one. The safe publication claim is: use SQLite for all new classes, treat KV as maintenance-only, and recheck account-specific creation policy before publication. Existing KV support, backend immutability, and the unavailable in-place KV-to-SQLite migration path are current product facts, not timeless architecture.

## Give `team/project-42` an application schema

SQLite changes the unit of design from serialized values under keys to rows with relationships and queryable indexes. Chapter 2 deliberately kept project state in one `project_state` row containing a JSON snapshot and revision 42; that was enough to expose a stale-continuation race, but it is not discarded now. It becomes the input to an application-schema migration that introduces project metadata, tasks, and an audit trail. A small schema makes the intended invariants visible:

```ts
import { DurableObject } from "cloudflare:workers";

export interface Env {
  POLICY: Fetcher;
  NOTIFIER: Fetcher;
}

type ProjectBody = {
  name: string;
  tasks: Array<{
    id: string;
    title: string;
    status: "open" | "done";
  }>;
};

type SnapshotRow = {
  snapshot: string;
  revision: number;
};

type TaskRow = {
  id: string;
  title: string;
  status: string;
  assignee_id: string | null;
  updated_at: number;
};

export class ProjectWorkspace extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.migrateSchema();
  }

  private migrateSchema(): void {
    const sql = this.ctx.storage.sql;

    // Preserve Chapter 2's source row while the normalized schema rolls out.
    sql.exec(`
      CREATE TABLE IF NOT EXISTS project_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        snapshot TEXT NOT NULL,
        revision INTEGER NOT NULL
      )
    `);

    sql.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);

    const { version } = sql.exec<{ version: number }>(`
      SELECT COALESCE(MAX(version), 0) AS version
      FROM schema_migrations
    `).one();

    if (version < 1) {
      this.ctx.storage.transactionSync(() => {
        sql.exec(`
          CREATE TABLE project (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            display_name TEXT NOT NULL,
            revision INTEGER NOT NULL
          );

          CREATE TABLE task (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            status TEXT NOT NULL CHECK (
              status IN ('open', 'in_progress', 'done')
            ),
            assignee_id TEXT,
            updated_at INTEGER NOT NULL
          );

          CREATE TABLE task_audit (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL REFERENCES task(id),
            actor_id TEXT NOT NULL,
            action TEXT NOT NULL,
            occurred_at INTEGER NOT NULL
          );

          CREATE INDEX task_by_status_updated
          ON task(status, updated_at DESC);
        `);

        const source = sql.exec<SnapshotRow>(`
          SELECT snapshot, revision
          FROM project_state
          WHERE id = 1
        `).toArray()[0];

        if (source) {
          const body = JSON.parse(source.snapshot) as ProjectBody;
          const migratedAt = Date.now();

          sql.exec(`
            INSERT INTO project(id, display_name, revision)
            VALUES (1, ?, ?)
          `, body.name, source.revision);

          for (const task of body.tasks) {
            sql.exec(`
              INSERT INTO task(id, title, status, assignee_id, updated_at)
              VALUES (?, ?, ?, NULL, ?)
            `, task.id, task.title, task.status, migratedAt);
          }
        }

        sql.exec(
          `INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)`,
          Date.now()
        );
      });
    }
  }

  listOpenTasks(): TaskRow[] {
    return this.ctx.storage.sql.exec<TaskRow>(`
      SELECT id, title, status, assignee_id, updated_at
      FROM task
      WHERE status != 'done'
      ORDER BY updated_at DESC
      LIMIT 100
    `).toArray();
  }
}
```

The constructor may run many times, so the schema check is idempotent. On first activation after this deployment, the transaction copies Chapter 2's accepted name, tasks, and revision into normalized rows; if any statement or JSON conversion fails, no normalized tables are accepted as a completed migration and the version marker is not written. The old `project_state` row remains temporarily for verification and backfill instead of being dropped in the same release. It is not a live replica and therefore not, by itself, a safe rollback path after normalized rows begin changing. A rollback plan would need bounded dual writes or an explicit reverse migration. A later migration can remove the snapshot after no deployed code or rollback plan depends on it.

The `schema_migrations` table records application schema version; it is different from Wrangler's class-lifecycle configuration. The first says which SQL transformations have run inside one object's database. The second says which Durable Object class namespace exists and which backend it was provisioned with.

For later schema versions, keep each migration bounded, synchronous, and transactional. New code may be deployed while millions of different object identities remain inactive; each object can migrate when next activated. That makes backward-compatible rollout planning important. A newly deployed handler should tolerate the schema versions it may encounter until its constructor has completed the local migration. Large rewrites may need an incremental application protocol rather than a long constructor transaction.

Indexes are not decorative. `task_by_status_updated` matches the equality filter and sort direction of `listOpenTasks()`, reducing rows scanned for a common read. They also have a write cost: Cloudflare's current pricing documentation counts index maintenance as additional rows written. Query shape, index shape, and billing shape therefore meet in the schema design. [Cloudflare's storage best practices](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/) recommend indexes for frequently queried columns and note this read/write tradeoff.

## Synchronous SQL, cursors, and the `await` boundary

`ctx.storage.sql.exec(query, ...bindings)` invokes SQLite synchronously and returns a `SqlStorageCursor`. Bind values rather than interpolating user input. The cursor is both iterable and an iterator: code can consume rows with `for...of`, `next()`, `toArray()`, `one()`, or `raw()`. `one()` is intentionally strict—it throws unless exactly one row exists—while `toArray()` consumes all remaining row objects. Cursor counters such as `rowsRead` and `rowsWritten` become final as the cursor is consumed.

Synchronous does not mean “free,” and a cursor is not a durable snapshot object. Current documentation warns that a cursor held across an `await` has no snapshot-isolation guarantee. When resumed, it can observe rows inserted, updated, or deleted after cursor creation, including data from a later implicit transaction that eventually rolls back. Materialize the rows needed for a decision before yielding:

```ts
// Predictable: consume the cursor before external I/O can interleave.
const tasks = this.ctx.storage.sql
  .exec<TaskRow>(`
    SELECT id, title, status, assignee_id, updated_at
    FROM task
    WHERE status = 'in_progress'
    ORDER BY updated_at DESC
  `)
  .toArray();

await fetch("https://audit.example/observe", {
  method: "POST",
  body: JSON.stringify(tasks)
});
```

The unsafe shape creates a cursor, crosses an `await`, and only then calls `toArray()`. The cursor object surviving in memory does not freeze the database state. “Cursor,” “bookmark,” and “version” are three different nouns: a SQL cursor iterates query results, a PITR bookmark names a database recovery point, and an application version is whatever history model the application chooses to store.

## One task change, one synchronous transaction

Changing a task, advancing the project revision established in Chapter 2, and appending an audit record is one application invariant. Separate `sql.exec()` calls are each atomic, but without a containing transaction an exception between them could leave only part of the change. `transactionSync()` supplies the missing scope. Its callback must be synchronous—no `async` declaration, returned Promise, or external `await`—and an exception rolls the entire transaction back. SQL transaction statements such as `BEGIN` and `SAVEPOINT` are not issued through `sql.exec()`; the Storage API owns the transaction boundary.

The running method is:

```ts
completeTask(
  taskId: string,
  actorId: string
): { task: TaskRow; revision: number } {
  const sql = this.ctx.storage.sql;

  return this.ctx.storage.transactionSync(() => {
    const updated = sql.exec<TaskRow>(`
      UPDATE task
      SET status = 'done', updated_at = ?
      WHERE id = ? AND status != 'done'
      RETURNING id, title, status, assignee_id, updated_at
    `, Date.now(), taskId).toArray();

    if (updated.length !== 1) {
      throw new Error(`Task ${taskId} is missing or already done`);
    }

    const { revision } = sql.exec<{ revision: number }>(`
      UPDATE project
      SET revision = revision + 1
      WHERE id = 1
      RETURNING revision
    `).one();

    sql.exec(`
      INSERT INTO task_audit(task_id, actor_id, action, occurred_at)
      VALUES (?, ?, 'completed', ?)
    `, taskId, actorId, Date.now());

    return { task: updated[0], revision };
  });
}
```

The rollback trace makes the guarantee observable. In a test deployment, insert a deliberate `throw new Error("simulated failure")` immediately after the audit insert:

```text
transactionSync begins
  ├─ UPDATE task: in_progress → done
  ├─ UPDATE project: revision 42 → 43
  ├─ INSERT task_audit: completed by user-17
  └─ throw simulated failure
       ↓
transactionSync rolls back
  ├─ task remains in_progress
  ├─ project revision remains 42
  └─ no task_audit row exists
```

The exception does not merely undo the last statement; it aborts the transaction's complete state change. Conversely, when the callback returns, both statements commit together. This is the right place for relational invariants local to project 42. An external email, webhook, or payment cannot be rolled back by SQLite; represent such work with an idempotent outbox row or another explicit protocol rather than performing it inside the synchronous callback.

## Synchronous KV and asynchronous compatibility on SQLite

SQL is not mandatory for every value. SQLite-backed objects expose synchronous key-value methods under `ctx.storage.kv`: single-key `get`, `put`, and `delete`, plus ordered `list`. They are useful for small settings or opaque values that do not benefit from relational queries. The asynchronous compatibility interface remains directly on `ctx.storage`, including its single-key and bulk forms:

```ts
// SQLite-backed object, synchronous KV surface.
this.ctx.storage.kv.put("project:theme", "midnight");
const theme = this.ctx.storage.kv.get<string>("project:theme");

// The same SQLite-backed object, asynchronous compatibility surface.
await this.ctx.storage.put("project:theme", "midnight");
const compatibleTheme = await this.ctx.storage.get<string>("project:theme");
```

Both write into a hidden SQLite table named `__cf_kv`. Cloudflare says the table can appear when tables are listed, but its contents are not accessible through the SQL API. Treat it as platform-owned implementation, not an application schema: do not query it, join it, alter it, or build migrations around it. Use `ctx.storage.kv` or the asynchronous compatibility methods.

This compatibility is valuable when introducing a new SQLite-backed class with existing KV-oriented application code. It does not migrate an already provisioned legacy namespace, and it does not mean the two backends share an implementation. API compatibility preserves a programming surface; backend generation determines capabilities and persistence machinery.

The synchronous and asynchronous KV surfaces are not identical twins. The current synchronous `ctx.storage.kv` surface has single-key `get`, `put`, and `delete` plus `list`; it does not add synchronous multi-key overloads. Its `list` uses the familiar `start`, `startAfter`, `end`, `prefix`, `reverse`, and `limit` range vocabulary and iterates in UTF-8 key order. An unbounded synchronous list can still load too much into memory, so the absence of a Promise does not remove the need for bounded scans. When compatibility code needs a bulk `get`, `put`, or `delete`, it uses the asynchronous `ctx.storage` overloads and their current 128-entry limit.

Every one of these calls has a method-level transaction boundary. A bulk `put` is therefore one atomic and isolated method, and one `list` observes its operation under the Storage API's consistency contract. But three separate method calls do not become one business transaction merely because each is individually atomic. On SQLite, group a multi-call invariant with `transactionSync()`; on legacy storage, use the transaction handle or the documented no-`await` coalescing rule where that narrower rule fits. Serializable storage orders operations—it does not guess where the application's invariant begins and ends.

## The legacy KV API: maintenance knowledge

The remainder of this section is for an existing KV-backed namespace or code that must preserve the asynchronous compatibility contract. It is not the model for new `ProjectWorkspace` code.

The four basic methods have compact but important semantics. Exact overload declarations belong in the API appendix; here the behavior is what matters:

| Operation | Single-key behavior | Bulk or scan behavior |
| --- | --- | --- |
| `get` | Returns the structured-cloned value, or `undefined` when absent | Up to 128 requested keys; returns a `Map`, omits missing keys, and orders present entries by increasing UTF-8 key encoding |
| `put` | Stores one structured-clone-compatible value | Accepts an object of up to 128 key/value pairs |
| `delete` | Returns `true` if the key existed | Accepts up to 128 keys and returns the number deleted |
| `list` | — | Returns a `Map` of matching keys and values in increasing UTF-8 key order by default |

UTF-8 ordering is bytewise key ordering, not locale-aware or numeric ordering. A naming scheme should pad numeric components if their lexical and numeric order must agree. The bulk limit is per call, so a larger maintenance job must batch explicitly.

`list()` without options loads every returned key and value into the object's memory. That is safe only when the data set is known to be small. A bounded scan uses `limit` and resumes with the last key as `startAfter`. The full range vocabulary is:

- `start`: inclusive lower key bound.
- `startAfter`: exclusive lower bound; it cannot be combined with `start`.
- `end`: exclusive upper key bound.
- `prefix`: include only keys beginning with the prefix.
- `reverse`: return descending rather than ascending order.
- `limit`: cap the number of returned entries.

Reversing output does not swap the mathematical meaning of the bounds. `start` is still the inclusive smallest key that may be returned and `end` is still the exclusive largest key considered; reverse changes traversal order. Combining `prefix`, range bounds, and a limit is often safer than an unbounded namespace-shaped scan.

> **Dated limit note — 2026-08-06.** The current legacy KV limit is 2 KiB per key and 128 KiB (131,072 bytes) per serialized value; an oversized `put()` throws before applying the write. Current asynchronous bulk `get`, `put`, and `delete` calls accept at most 128 keys or entries. On SQLite-backed objects, current KV limits say key and value together cannot exceed 2 MB, while the SQL limits list 2 MB for a string, BLOB, or table row. All are product limits and must be rechecked before publication. [Cloudflare's Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) are the authority.

### Options are gate and cache controls

Three legacy options alter scheduling or performance, not the private strongly consistent identity of the store.

`allowConcurrency: true` applies to reads and lists. Normally, while an asynchronous storage operation is outstanding, the input gate delays delivery of unrelated events to the object. That makes a natural read-then-write sequence safer from unexpected request interleaving around storage awaits. Opting out can increase concurrency, but then the application accepts responsibility for values changing while the operation is in flight. It does not make a transaction larger or weaken storage consistency; it weakens the event-delivery protection around the calling code.

`allowUnconfirmed: true` applies to asynchronous writes such as `put`, `delete`, and `deleteAll` and to the legacy write-shaped alarm methods. Normally, the output gate holds later outgoing responses and network requests until preceding writes are confirmed. Opting out allows external messages to proceed on the basis of an unconfirmed write. That may be a valid latency tradeoff for disposable hints, but it is wrong for “task completed” unless a later protocol repairs false success.

`noCache: true` is only a performance hint. On a read, it asks not to insert the result into the in-memory cache; an already cached value may still be returned. On a write, it asks that the value be discarded from memory after persistence. The write buffer still supplies a just-written value to a subsequent read, preserving semantics. `noCache` must never be used as a consistency switch.

Input and output gates solve different directions of observation. The input gate controls when code may be resumed or another event delivered while storage I/O is pending. The output gate controls when the outside world may observe messages after writes. Neither turns external I/O into part of a database transaction. [Cloudflare's engineering article on input and output gates](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/) explains the scheduling model; the current API page defines the options.

### Trace: coalescing versus backpressure

Legacy writes issued without an intervening `await` are automatically coalesced and submitted atomically. Save their Promises, then await after all three have been issued:

```ts
// Legacy KV maintenance example: no await between write initiation.
const p1 = this.ctx.storage.put("task:7:status", "done");
const p2 = this.ctx.storage.put("task:7:actor", "user-17");
const p3 = this.ctx.storage.put("task:7:updated", Date.now());
await Promise.all([p1, p2, p3]);
```

The trace is:

```text
put status ─┐
put actor  ─┼─ no intervening await ─ coalesced atomic submission
put time   ─┘
await all                                  ↓
                                  output gate / confirmation
```

If the process fails at the relevant storage boundary, the coalesced writes are stored together or not stored. That convenience is narrow: an `await` of anything between writes ends the automatic group.

The separately awaited version makes each write apply backpressure:

```ts
// Legacy KV maintenance example: bounded write-buffer growth.
await this.ctx.storage.put("task:7:status", "done");
await this.ctx.storage.put("task:7:actor", "user-17");
await this.ctx.storage.put("task:7:updated", Date.now());
```

Each await gives the storage pipeline an opportunity to drain before more buffered data is produced, which matters in a long, high-volume loop. Current docs warn that continuously issuing writes without waiting can grow the in-memory write buffer enough to threaten the isolate's memory limit. The tradeoff is that separate awaits disable automatic coalescing. Backpressure and atomic grouping are distinct goals; for a large import, batch a bounded number of logically related writes, await the batch, then continue.

Awaiting a legacy `put()` is not the chapter's universal synonym for “durably visible.” The Promise normally interacts with the write buffer and supplies backpressure. `sync()` is the explicit barrier: it returns a Promise that resolves after all prior pending writes—including writes made with `allowUnconfirmed`—have completed persistence, or resolves immediately if none are pending. Use it when code needs an explicit confirmation point before a selected outgoing action.

### Explicit asynchronous transactions and rollback

The legacy `transaction()` method groups asynchronous storage operations into one commit-or-abort unit. The callback receives a transaction handle. On a KV-backed object, every participating `get`, `put`, `delete`, or `list` must be called on that handle, not on top-level `ctx.storage`:

```ts
// Legacy KV maintenance example.
await this.ctx.storage.transaction(async (txn) => {
  const task = await txn.get<{ status: string }>("task:7");
  if (!task || task.status === "done") {
    txn.rollback();
    return;
  }

  await txn.put("task:7", { ...task, status: "done" });
  await txn.put("audit:000042", {
    taskId: "task:7",
    action: "completed"
  });
});
```

`txn.rollback()` explicitly prevents commit; after it is called, further use of the transaction handle throws. A callback failure also aborts rather than publishing a partial transaction. Calling `this.ctx.storage.put()` inside this legacy callback escapes the transaction handle and therefore the intended grouping. On SQLite-backed storage the transaction handle is documented as obsolete: operations on `ctx.storage`, including SQL, join the Storage API transaction, and synchronous SQL code should normally use `transactionSync()`.

### Alarms and complete deletion

Both backend generations support alarms. An object can have one scheduled alarm at a time. `getAlarm` reads its scheduled Unix-millisecond timestamp or no alarm, `setAlarm` schedules or replaces it, and `deleteAlarm` removes it without canceling a handler already running. Alarm mutations are Storage API operations and follow storage ordering and gating rules. The current SQLite alarm documentation exposes synchronous forms; the legacy KV storage page documents Promise-returning forms and legacy options. The handler itself remains at-least-once work and must be idempotent, as Chapter 2 established. [Cloudflare's Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/) documents the common behavior.

`deleteAll()` has a much sharper backend distinction. On SQLite it atomically removes the entire private database contents, including application SQL and hidden KV data. On legacy KV, an in-progress deletion can fail after deleting only a subset of keys. Maintenance code cannot interpret a rejected legacy `deleteAll()` as “nothing changed”; it must tolerate and, when appropriate, retry partial cleanup.

Alarm deletion is compatibility-date-sensitive. With compatibility date `2026-02-24` or later, `deleteAll()` also deletes an active alarm. Earlier dates leave the alarm unless `deleteAlarm()` is called separately or the `delete_all_deletes_alarm` flag is enabled. The running system's `2026-08-06` date receives the new behavior, but explicit alarm cleanup can still make destructive intent clear. This date must be preserved in tests because moving it can change deletion semantics.

## Backend capabilities, verified as of 2026-08-06

The current official storage pages support every row in this table:

| Capability | Legacy KV-backed object | SQLite-backed object |
| --- | --- | --- |
| Asynchronous KV API | Yes | Yes, for compatibility |
| Synchronous KV API | No | Yes, through `ctx.storage.kv` |
| SQL | No | Yes, through `ctx.storage.sql` |
| Synchronous transactions | No | Yes, through `transactionSync()` |
| Asynchronous `transaction()` | Yes | Yes, with the legacy transaction handle obsolete |
| Alarms | Yes | Yes |
| PITR | No | Yes |
| Atomic `deleteAll()` | No; partial deletion is possible on failure | Yes |
| Recommended for a new namespace | No; maintenance backend | Yes |

The table compares capabilities, not consistency quality. Both generations provide private, strongly consistent, transactional attached storage. SQLite adds a relational API, synchronous KV, synchronous transaction callbacks, and recovery bookmarks while retaining the asynchronous KV surface. [Cloudflare's Legacy KV Storage API](https://developers.cloudflare.com/durable-objects/api/legacy-kv-storage-api/) and [SQLite Storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) publish the comparison and method behavior.

## A synchronous write is not yet an observable success

Cloudflare calls the embedded SQL design “zero-latency SQLite.” The useful claim is narrower: SQLite executes as a library colocated with the Durable Object, removing the separate application-to-database network round trip. A hot query can therefore avoid the milliseconds commonly spent crossing that boundary. It still consumes CPU, performs SQLite work, may touch local storage, participates in persistence machinery, and sits behind request routing. End-to-end response time is never literally zero.

Synchronous query execution also does not mean synchronous durability confirmation. `sql.exec()` can update local database state and return control to JavaScript while the platform confirms the write in parallel. The default output gate prevents a later response or outbound request from becoming externally visible before the relevant writes are confirmed.

Follow `completeTask()` into an HTTP or RPC response:

```text
t0  request reaches ProjectWorkspace(acme/project-42)
t1  transactionSync executes UPDATE + INSERT without yielding
t2  transaction callback returns; application constructs success response
t3  output gate holds that outgoing response
t4  persistence layer confirms the transaction
t5  output gate releases the success response to the caller
```

If confirmation fails at `t4`, the success response is discarded or replaced by an error and the object is restarted rather than letting the caller observe a state transition that did not become durable. The application may continue computing between `t2` and `t4`; construction of the response and release of the response are separate moments.

This trace resolves a common vocabulary problem. “The SQL statement returned” describes execution. “The transaction committed” describes atomic database state. “Persistence was confirmed” describes the durability barrier. “The caller saw success” describes external visibility. Output gating connects the last two by default without pretending they occur at the same instant.

Cloudflare's 2024 engineering description explains one implementation behind that contract: SQLite write-ahead-log changes are intercepted by a Storage Relay Service, relayed for confirmation, batched to object storage, and combined with periodic snapshots for reconstruction and PITR. Those details help explain why local SQL execution and durable confirmation can overlap. They are a dated implementation description, not an application-visible SQLite file format or a promise that follower counts, batching thresholds, or physical storage topology will never change. [The “Zero-latency SQLite storage” engineering article](https://blog.cloudflare.com/sqlite-in-durable-objects/) is evidence for that described implementation; the Storage API and output-gate behavior are the contract applications should depend on.

## Three different meanings of size

`ctx.storage.sql.databaseSize` synchronously reports the current SQLite database size in bytes. It is useful for operational thresholds, but it should not be renamed “project bytes” or “monthly billed bytes.” At least three quantities coexist:

| Quantity | What it measures | Typical contents |
| --- | --- | --- |
| Logical application bytes | A metric defined by the application | Task text, attachments, or other selected payload lengths |
| SQLite database size | `databaseSize` at a point in time | Tables, indexes, page overhead, hidden KV data, and database allocation effects |
| Billed storage and operations | Platform metering over time | Stored SQL data plus metered rows read/written and platform metadata under current pricing rules |

Deleting logical rows does not guarantee these numbers move together immediately or by the same amount. Indexes consume database space and add write work. Empty tables and internal metadata can occupy billable bytes. Billing accumulates over time, while `databaseSize` is a current database-level observation. If project 42 needs a quota over user-authored content, maintain that logical metric explicitly instead of treating a SQLite file-size property as an application accounting policy.

> **Dated pricing note — 2026-08-06.** Current pricing meters SQLite-backed Durable Objects by rows read, rows written, and stored data; KV-compatible methods operate through hidden SQLite storage and are metered accordingly. Index updates add row writes, deletes count as writes, and internal metadata contributes to stored data. Rates and included quotas are intentionally omitted here because they are volatile; verify them on [Cloudflare's Durable Objects pricing page](https://developers.cloudflare.com/durable-objects/platform/pricing/) immediately before publication.

## PITR restores a database, not a project story

SQLite-backed objects expose Point-in-Time Recovery through bookmarks. `getCurrentBookmark()` returns the current recovery marker. `getBookmarkForTime(time)` resolves an approximate point for a timestamp within the retained window. `onNextSessionRestoreBookmark(bookmark)` arranges for the whole database to be restored on the next session; the normal flow then restarts the object, commonly with `ctx.abort()`. That method also returns a special pre-recovery bookmark so the recovery itself can be undone.

As of 2026-08-06, the documented window is the previous 30 days. Restoration applies to the entire private SQLite database: application SQL tables and KV data in the hidden table move together. PITR is not supported in local development because the required durable change log is not retained there. A local Wrangler success therefore cannot establish production recovery behavior.

Bookmarks are lexically comparable in time order, but that does not make them business-level commits. A restore is an operational intervention over one object's complete database. If a bad deployment updated 4,000 tasks, PITR can take project 42's database back before the deployment. It cannot selectively restore only task 7 while preserving later valid changes to task 8.

| PITR | Application history |
| --- | --- |
| Restores the whole object database | Restores or compares a selected logical entity or file |
| Operational disaster recovery | User-visible undo, review, or versioning |
| Chooses a time or bookmark | Chooses a named version, commit, revision, or domain event |
| Platform capability | Application data model and policy |
| Includes SQL and hidden KV data together | Includes only the entities the application deliberately versions |

Neither side substitutes for the other. An audit table can explain changes but is not automatically a restorable history. A current manifest, content hash, or synchronization cursor can describe current state or transfer progress without retaining older versions. Conversely, PITR's retained database log should not be exposed as if it were selective Git-like history. Project 42 needs both an operational recovery policy and, if users require undo, a separately designed history model.

The recovery policy for the running system is therefore:

- use PITR for operator-led recovery from broad database corruption within the current documented window;
- record the bookmark and incident boundary before initiating restoration;
- expect the entire project's database to move to the selected point;
- use `task_audit` for accountability, not as proof that arbitrary prior states can be reconstructed;
- add application versions only when the product requires selective undo or named history.

## What is guaranteed, described, and still application work

The platform contract is strong but scoped. One object owns private attached storage. Storage operations are strongly consistent and serializable. Individual methods are atomic and isolated, and explicit transactions group a larger local invariant. Output gates prevent confirmed external success from racing ahead of writes by default. SQLite-backed storage adds SQL, synchronous KV, synchronous transactions, and PITR.

Current product behavior adds dates and limits to that contract: 128-key asynchronous bulk operations, legacy value limits, the `2026-02-24` `deleteAll()` alarm behavior, current backend-creation restrictions, a 30-day PITR window, local-development exclusions, and current billing rules. Those facts belong in dated notes because they can change without invalidating the architecture.

Cloudflare's engineering article describes how embedded SQLite, write-ahead-log interception, relay confirmation, object-storage batches, snapshots, and output gates have been combined. It is useful implementation evidence, but applications should not depend on those physical details as a queryable schema or fixed topology.

The application still chooses table design, indexes, schema migrations, transaction boundaries, idempotent external-effect protocols, logical quotas, audit retention, and user-visible history. Strong storage cannot infer which two statements form a business invariant. PITR cannot infer that one file should be undone while another is preserved. A synchronous API cannot decide which response is safe to expose after an unconfirmed write.

For the `team/project-42` design, concretely `acme/project-42`, the result is now clear. Tasks and audit rows live in private SQLite. One synchronous transaction protects completion. Output gating protects write-to-response visibility. PITR supplies whole-database operational recovery. Legacy KV behavior remains understood without becoming the foundation of new code.

The next question is no longer whether the project can keep durable rows. It is: **how can application-defined SQLite rows become a filesystem?**

## Sources

- [SQLite-backed Durable Object Storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [KV-backed Durable Object Storage API (Legacy)](https://developers.cloudflare.com/durable-objects/api/legacy-kv-storage-api/)
- [Durable Objects glossary](https://developers.cloudflare.com/durable-objects/reference/glossary/)
- [Access Durable Objects Storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- [Durable Object class exports and legacy migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- [Durable Objects Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Objects: Easy, Fast, Correct — Choose Three](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/)
- [Zero-latency SQLite storage in every Durable Object](https://blog.cloudflare.com/sqlite-in-durable-objects/)
