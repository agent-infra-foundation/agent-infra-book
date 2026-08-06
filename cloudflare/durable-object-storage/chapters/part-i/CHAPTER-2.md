# Chapter 2 — Identity Persists; Memory Does Not

> Evidence scope: Durable Objects platform contract and current platform
> behavior, verified against official Cloudflare documentation on 2026-08-06;
> Cloudflare Computer behavior is pinned to commit
> [`76d9e75`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b).

The last request of the day follows Chapter 1's route to `ProjectWorkspace` at
`acme/project-42`, the concrete name produced by the `team/project-42` identity
scheme. The owner accepts `task-100`, advances the project revision, and
returns an accepted response. The clients disconnect. Nothing calls the object
for a while.

The next morning, the first request produces a log line that looks alarming:
the `ProjectWorkspace` constructor has run again. Its `Set` of open task IDs is
empty. Its cached project summary is gone. Any JavaScript objects representing
connected clients, pending promises, or remote handles are gone with them.

The project has not been deleted. A fresh incarnation reads the committed
project row from the same attached database, rebuilds the task index, and
continues from the accepted revision. The name still routes to the same logical
owner even though none of yesterday's class fields survived.

That distinction is the center of this chapter:

> **Object identity and committed attached state survive; object memory and
> live capabilities are disposable.**

Chapter 1 chose the owner. This chapter asks what that owner can safely promise
when events overlap around an `await`, when the runtime removes its active
JavaScript instance, and when scheduled work must try again.

## One identity, many incarnations

A Durable Object ID identifies a logical object, not a permanent process. For a
given ID, the runtime provides one active object instance at a particular time,
and requests for that ID are delivered to that instance. Cloudflare describes
this directly in its [in-memory state
reference](https://developers.cloudflare.com/durable-objects/reference/in-memory-state/).
That is the coordination model that lets `acme/project-42` act as one owner.

The active instance is only the current **incarnation** of that owner. An
incarnation consists of a JavaScript class instance, its fields, its currently
running handlers, and the live capabilities reachable from them. The runtime
may later discard it and construct another. The new instance receives the same
object identity and access to the same committed attached storage; it does not
receive a heap snapshot of the old instance.

Keep three nouns separate:

- `acme/project-42` is the stable application name used to derive the object
  identity.
- `ProjectWorkspace` is the class whose code implements that kind of object.
- The current `new ProjectWorkspace(...)` value is a replaceable in-memory
  incarnation.

This model is stronger than a stateless handler because all calls for the
project meet at one coordination point. It is weaker than a permanently
running VM because memory is not part of the durability contract. That is not
a contradiction. Durable identity makes reconstruction possible; attached
storage makes reconstruction useful.

## One JavaScript stack at a time is not one transaction at a time

Events delivered to the object include HTTP or RPC calls, inbound WebSocket
messages, and alarms. JavaScript executes the synchronous portion of one
handler at a time. While that portion is running, another handler is not
simultaneously executing JavaScript against the same instance.

An asynchronous handler is not one uninterrupted synchronous portion. At an
`await`, the handler may yield. If the awaited operation cannot complete
immediately—an external `fetch()`, for example—the runtime can deliver another
event. That event runs until it returns or yields; then the first handler may
resume with a world that has changed.

```text
event A: read revision 41 ── await external fetch ───────── resume
                                   │                         │
input may reopen                   ▼                         │
event B:                    add task; commit revision 42 ────┘
```

There are still no two JavaScript stack frames executing at once. There is,
however, cooperative asynchronous **interleaving**. “Single-threaded” therefore
does not mean “every sequence containing `await` is atomic.” The current
[Rules of Durable
Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
make this boundary explicit: synchronous execution is serialized, while an
awaited asynchronous operation can allow other requests to interleave.

### Trace 1: the stale snapshot that deletes an accepted task

Suppose the project state is currently represented by one row containing a
JSON body and an integer revision. The next chapter will examine the storage
model and transaction policy in detail; here the row is enough to expose the
event-ordering bug.

The following method is unsafe. It fully reads the SQL cursor before the
`await`, but it later writes the entire old body without checking whether the
project changed while the policy service was running.

```ts
import { DurableObject } from "cloudflare:workers";

interface Env {
  POLICY: Fetcher;
  NOTIFIER: Fetcher;
}

interface ProjectBody {
  name: string;
  tasks: Array<{
    id: string;
    title: string;
    status: "open" | "done";
  }>;
}

interface ProjectSnapshot extends ProjectBody {
  revision: number;
}

interface SnapshotRow {
  snapshot: string;
  revision: number;
}

export class ProjectWorkspace extends DurableObject<Env> {
  private readProject(): ProjectSnapshot {
    const row = this.ctx.storage.sql.exec<SnapshotRow>(
      `SELECT snapshot, revision
         FROM project_state
        WHERE id = 1`,
    ).one();

    return {
      ...(JSON.parse(row.snapshot) as ProjectBody),
      revision: row.revision,
    };
  }

  async unsafeRenameProject(nextName: string): Promise<number> {
    const observed = this.readProject();

    const verdict = await this.env.POLICY.fetch(
      "https://policy.internal/project-name",
      { method: "POST", body: JSON.stringify({ name: nextName }) },
    );
    if (!verdict.ok) throw new Error("name rejected");

    const next: ProjectBody = {
      name: nextName,
      tasks: observed.tasks,
    };
    const nextRevision = observed.revision + 1;

    this.ctx.storage.sql.exec(
      `UPDATE project_state
          SET snapshot = ?, revision = ?
        WHERE id = 1`,
      JSON.stringify(next),
      nextRevision,
    );
    return nextRevision;
  }
}
```

Follow the two events precisely:

1. Rename request A reads revision 41 with tasks 98 and 99.
2. A awaits the policy service. That external wait permits another event to
   run.
3. Add-task request B reads revision 41, appends task 100, and commits revision
   42. Its success response represents accepted project state.
4. A resumes with its old body, changes only the name, and writes that body as
   revision 42.
5. Task 100 disappears. Every synchronous segment was serialized; the
   application still performed a lost update.

The runtime cannot infer that `snapshot` contains an obsolete logical view. It
sees a valid SQL update from the current owner. Input gates do not turn an
arbitrary external `fetch()` into a lock, and an output gate cannot repair a
bad write.

An invariant-preserving version treats the revision as a precondition:

```ts
async renameProject(
  nextName: string,
): Promise<{ ok: true; revision: number } | { ok: false; conflict: true }> {
  const observed = this.readProject();

  const verdict = await this.env.POLICY.fetch(
    "https://policy.internal/project-name",
    { method: "POST", body: JSON.stringify({ name: nextName }) },
  );
  if (!verdict.ok) throw new Error("name rejected");

  const next: ProjectBody = {
    name: nextName,
    tasks: observed.tasks,
  };

  const applied = this.ctx.storage.sql.exec<{ revision: number }>(
    `UPDATE project_state
        SET snapshot = ?, revision = revision + 1
      WHERE id = 1 AND revision = ?
      RETURNING revision`,
    JSON.stringify(next),
    observed.revision,
  ).toArray();

  if (applied.length === 0) return { ok: false, conflict: true };
  return { ok: true, revision: applied[0].revision };
}
```

Now B's commit makes A's predicate false. A changes nothing and reports a
conflict. It may reread revision 42, run the policy check again, and attempt a
new conditional update. No accepted task is overwritten.

The general pattern is broader than renaming:

```text
read durable version
        ↓
perform work that may yield
        ↓
commit only if the durable version is still the one observed
        ↓
otherwise retry, merge, or reject
```

If the external call itself causes an irreversible effect—charging a card,
sending a notification, or starting a third-party job—the request also needs a
stable operation ID that the receiver treats idempotently. A conditional local
write cannot roll back another system. The trace omits the corresponding local
deduplication row to keep the revision race visible; a production mutation must
record that operation ID so a lost response cannot create a second revision.

## Gates protect storage boundaries, not arbitrary intentions

Cloudflare's runtime uses two complementary gate mechanisms. They solve
important classes of mistakes, but neither is permission to stop reasoning
about event order.

An **input gate** controls when new events and I/O completions may enter the
object. Synchronous JavaScript runs without another event being delivered into
the middle of it. Storage operations receive special input-gate protection, so
the ordinary storage read–continuation–write pattern can be protected by the
runtime. An unrelated awaited operation such as external `fetch()` is outside
that storage sequence and can reopen the object to interleaving. The gate is a
runtime delivery rule, not an application mutex attached to every local
variable.

An **output gate** delays outgoing network messages—including a response that
would tell a caller “accepted”—while storage writes from the event remain
unconfirmed. This closes a dangerous window in which the caller could observe
success and the object could fail before the corresponding write became
durable. The official [input and output gate
guidance](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#understand-how-input-and-output-gates-work)
describes responses and outbound fetches as held until pending storage writes
complete.

The scope matters. An output gate does not create a distributed transaction
between attached storage and an external API. Once an external receiver has
performed an effect, the object cannot recall it. Nor does the gate guarantee
that a client will receive the response; a connection can fail after commit.
Clients may therefore retry a mutation whose first outcome they did not see,
which is another reason to attach an idempotency key to accepted operations.

### Block only the initialization that must be complete

`blockConcurrencyWhile()` is the explicit tool for the rarer case in which an
async region must finish before any unrelated event is delivered. Its natural
home is bounded initialization: create or migrate the schema, read durable
state, and construct the in-memory indexes that every handler assumes exist.

```ts
private openTaskIds = new Set<string>();

constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);

  this.ctx.blockConcurrencyWhile(async () => {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS project_state (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         snapshot TEXT NOT NULL,
         revision INTEGER NOT NULL
       )`,
    );

    const rows = this.ctx.storage.sql.exec<SnapshotRow>(
      `SELECT snapshot, revision
         FROM project_state
        WHERE id = 1`,
    ).toArray();

    const tasks = rows.length === 0
      ? []
      : (JSON.parse(rows[0].snapshot) as ProjectBody).tasks;
    this.openTaskIds = new Set(
      tasks.filter((task) => task.status === "open").map((task) => task.id),
    );
  });
}
```

This callback is deliberately small and storage-local. The SQL operations
shown are synchronous, so they do not themselves yield; constructor ordering
would be sufficient for this exact version. The block becomes load-bearing if
initialization later includes an awaited migration or cache load, because the
constructor itself cannot be `async`. If initialization fails, failing the
incarnation is safer than serving requests with a half-built cache.

Broad use has the opposite effect. Wrapping a slow policy request or an
unbounded remote fetch in `blockConcurrencyWhile()` queues every unrelated
project event behind that dependency. A downstream outage becomes a workspace
outage. A thrown callback resets the object, and, as of 2026-08-06, the
[Durable Object State API](https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile)
documents a 30-second callback timeout followed by a reset. Keep the block
bounded; prefer conditional commits, idempotency, and explicit operation state
for long workflows.

## The lifecycle is a sequence of reconstructible incarnations

The platform's formal states are active in memory, idle in memory (either
eligible or ineligible for hibernation), hibernated, and inactive. “Evicted”
describes removal of the in-memory instance; “restart” describes a cause such
as deployment or a runtime decision; “reconstruction” is what the application
does after the next constructor call. These words overlap in casual speech but
identify different parts of the model.

```text
[FIGURE 1.2 PLACEHOLDER — DURABLE OBJECT LIFECYCLE]

                         next event / alarm / message
      ┌────────────────────────────────────────────────────────┐
      │                                                        ▼
 inactive / evicted ──► constructor ──► active ──► idle in memory
                              ▲                         │       │
                              │                         │       └─ not eligible
                              │                         │          ──► eviction
                              └──── next event ◄────────┘
                                                        │ eligible
                                                        ▼
                                                   hibernated

 MEMORY (disposable):     class fields, caches, promises, handles, closures
 IDENTITY (stable):        acme/project-42 → the same logical object
 ATTACHED STORAGE:         committed project rows persist below every state
 WS ATTACHMENT:            survives hibernation while its WebSocket is healthy
 EXTERNAL SIDE EFFECTS:    survive externally; must be reconciled by protocol
```

*Figure 1.2 — An incarnation may become idle, hibernate, or be evicted; the
safe conclusion is that only identity and committed attached state can be used
to reconstruct the project, while memory and capabilities must be recreated.*

An active object is executing an event. An idle object has no event currently
running but may still occupy memory. If it satisfies the hibernation conditions,
the runtime may discard its memory while preserving eligible incoming
WebSocket connections. If it does not satisfy those conditions, the runtime
may eventually evict it into the inactive state. The next event runs a fresh
constructor before its handler.

**Dated lifecycle note.** The [official lifecycle
page](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/),
last checked 2026-08-06, describes hibernation after 10 seconds of eligible
inactivity and eviction after 70–140 seconds of inactivity for an idle,
non-hibernateable object. Those numbers are current platform behavior, not an
application timer. Code must remain correct if the runtime reconstructs an
object sooner, later, or for another reason such as a deployment or runtime
update.

Hibernation is not a gentler form of persistent memory. The heap is discarded.
Eviction is not an application shutdown sequence. In both cases, correctness
comes from having already recorded every accepted fact needed for recovery.

### Trace 2: eviction after acceptance

Return to task 100 and follow the durability boundary rather than the process:

```text
T0  request reaches acme/project-42
T1  ProjectWorkspace writes task-100 and revision 42 to attached storage
T2  output gate releases the accepted response after the write is confirmed
T3  class field openTaskIds now contains task-100
T4  object becomes idle; the runtime later evicts the incarnation
T5  openTaskIds, promises, handles, and the JavaScript instance disappear
T6  next request arrives; a fresh constructor runs for acme/project-42
T7  constructor reads committed rows and rebuilds openTaskIds
T8  handler serves revision 42 with task-100 present
```

The cache did not survive T5. It did not need to. Its source did. If the
incarnation had failed before the write at T1 committed, the client should not
have received the accepted response at T2. If the write committed but the
response was lost in transit, the client may not know the outcome and must
retry with the same operation ID. “Accepted” is therefore a protocol fact tied
to committed storage, not a memory flag.

Constructor code must respect this lifecycle. It may use `CREATE TABLE IF NOT
EXISTS`, insert an initial row only when no row exists, and derive caches from
stored facts. It must not blindly write defaults on every constructor call.
The constructor can run before a request, a WebSocket message, or an alarm; it
is not a one-time installer.

The inverse rule applies to mutation handlers: update attached state as the
mutation is accepted, then update or invalidate the cache. Never make “we will
flush the cache when the object shuts down” part of the recovery plan.

## A connection may survive when its JavaScript does not

WebSockets make the distinction between identity, memory, and capabilities
especially visible. With the standard WebSocket API, an open connection keeps
the object from qualifying for hibernation. The Hibernation WebSocket API uses
`ctx.acceptWebSocket()` so Cloudflare can keep an incoming client connection at
the network layer while removing the object's JavaScript instance from memory.
When a message arrives, the runtime constructs the object again and delivers a
`webSocketMessage` event.

What survives is not the closure that originally accepted the socket. A
`Map<WebSocket, User>` in a class field is still disposable. The Hibernation
API instead lets the application call `serializeAttachment()` to associate a
small structured-clone value with a connection and recover it later with
`deserializeAttachment()`. The current [WebSocket hibernation
documentation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocketserializeattachment)
says the attachment survives hibernation while the connection remains healthy,
is lost when the connection closes, and is capped at 16,384 bytes as of
2026-08-06. State that must outlive the socket belongs in attached storage; the
attachment should contain a compact key such as `{ memberId, sessionId }`.

That yields four distinct durability classes:

- the project row belongs in attached storage;
- a per-connection resume key may belong in a serialized attachment;
- a derived broadcast index belongs in memory and is rebuilt from the live
  sockets and their attachments;
- an outbound connection, response stream, pending RPC, or promise is a live
  capability and must be reopened or retried.

General Durable Objects hibernation support does not establish that every
application built on Durable Objects hibernates. This matters for Cloudflare
Computer. At the book's pinned commit, Computer's container backend accepts its
long-lived capnweb socket with `server.accept()` and installs ordinary message
listeners. Its own [pinned lifecycle
document](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/11_lifecycle.md#hibernation)
labels the hibernation section forward-looking and states that the Durable
Object does not hibernate yet. Computer's current non-hibernating container
WebSocket is an application implementation fact, not a limitation of the
Durable Objects platform.

## Alarms promise another attempt, not exactly one effect

An alarm is durable scheduling associated with one object. `ProjectWorkspace`
can record that a notification or maintenance job is pending, set an alarm,
become inactive, and later be reconstructed when the alarm fires. If the object
was inactive, its constructor runs before `alarm()`; a constructor that blindly
sets a new alarm can therefore overwrite the schedule that just woke it.

Cloudflare documents alarms as **at-least-once** execution. If an alarm handler
throws, the runtime retries it. As of 2026-08-06, the [Alarms
API](https://developers.cloudflare.com/durable-objects/api/alarms/) documents
exponential backoff beginning at two seconds and up to six retries. Those retry
numbers are dated behavior. The correctness rule is timeless: the same logical
alarm work may run more than once.

Consider a pending `notify-task-100` job. A dangerous alarm handler sends the
notification and then marks the job complete. If the external service accepts
the message but the object fails before the completion write commits, the next
attempt sends it again. `alarmInfo.retryCount` can help with diagnostics; it
does not prove whether the external effect occurred.

The robust protocol gives the work a durable identity:

```text
committed job row: notify-task-100, status=pending
        ↓
alarm reads pending job
        ↓
external request carries Idempotency-Key: notify-task-100
        ↓
receiver returns the same outcome for duplicate keys
        ↓
object conditionally marks notify-task-100 complete
```

A compact handler makes the boundary visible:

```ts
async alarm(): Promise<void> {
  const jobs = this.ctx.storage.sql.exec<{
    id: string;
    taskId: string;
  }>(
    `SELECT id, task_id AS taskId
       FROM notification_jobs
      WHERE status = 'pending'
      ORDER BY id
      LIMIT 20`,
  ).toArray();

  for (const job of jobs) {
    const response = await this.env.NOTIFIER.fetch(
      "https://notify.internal/task-accepted",
      {
        method: "POST",
        headers: { "Idempotency-Key": job.id },
        body: JSON.stringify({ taskId: job.taskId }),
      },
    );
    if (!response.ok) throw new Error(`notification failed: ${job.id}`);

    this.ctx.storage.sql.exec(
      `UPDATE notification_jobs
          SET status = 'complete'
        WHERE id = ? AND status = 'pending'`,
      job.id,
    );
  }
}
```

The receiving service must actually honor the idempotency key; a header alone
provides no guarantee. For a receiver without idempotency support, the project
needs a reconciliation strategy and must accept that exactly-once external
effects are not supplied by an alarm.

The same discipline applies to client retries. Cloudflare's [error-handling
guidance](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/)
marks some errors retryable only when the request itself is idempotent and
warns against retrying overload errors. A caller should create a fresh stub
after an exception, use exponential backoff where retry is appropriate, and
reuse the operation ID rather than inventing a second mutation.

## There is no dependable last moment

An object may be reconstructed because it became idle, because new code was
deployed, because the runtime was updated, or because the platform made a
hosting decision. There is no dependable `beforeShutdown()` callback in which
to flush class fields. The [shutdown behavior
documentation](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/#working-without-shutdown-hooks)
explicitly says shutdown hooks are not provided and recommends writing progress
incrementally.

This corrects two related misconceptions. Hibernation is not a notification
that cleanup should begin; by the time the object is hibernated, its memory is
already absent. Eviction is not a graceful application shutdown; it may happen
without code running at the boundary. A design that requires either callback
has put authoritative state in the wrong place.

Long work should therefore persist its state machine as it progresses:
`pending`, `running` with a durable operation ID, `complete`, or a more precise
application-specific sequence. Caches can lag and be discarded. Accepted
facts, cursors, and deduplication records cannot wait for a final flush.

## The one-owner model has a hot-object ceiling

One identity routes contention to one owner. That is why it coordinates; it is
also why one object cannot be the scaling plan for an entire service. The
object's synchronous JavaScript executes on one thread, requests can queue, and
expensive serialization, storage scans, or external waits reduce throughput.

**Dated limit note.** On 2026-08-06, Cloudflare's [Durable Objects limits
page](https://developers.cloudflare.com/durable-objects/platform/limits/#how-much-work-can-a-single-durable-object-do)
lists a soft limit of 1,000 requests per second for an individual object and
notes that realized throughput depends on the work per request. An overloaded
object may reject requests after attempting to queue them. Treat this as a
current planning input, not a promised benchmark.

The scaling unit is identity. One object per project distributes independent
projects across many owners:

```text
acme/project-41 ──► ProjectWorkspace 41
acme/project-42 ──► ProjectWorkspace 42
acme/project-43 ──► ProjectWorkspace 43
```

Do not “solve” the ceiling by routing every team to one global
`ProjectWorkspace`. If project 42 itself becomes hot, split only the concerns
whose invariants permit it: presence by room, immutable activity pages by
range, or background jobs by durable job identity. Keep the canonical project
metadata with the project owner. Communication among those objects is then
explicit distributed communication, so cross-object ordering and failure must
be designed rather than assumed.

This is the trade: the object boundary is both the coordination boundary and
the horizontal partitioning boundary. Choose it around one atom of consistency,
then create many such atoms.

## What survives, and what the application must do

The lifecycle model can now be stated without relying on metaphors:

| Thing | Survival rule | Application responsibility |
| --- | --- | --- |
| Object identity | Stable across incarnations | Derive and route the same project name consistently |
| Committed attached state | Survives hibernation, eviction, and reconstruction | Commit every accepted fact and define recovery invariants |
| Class fields and caches | Lost with the incarnation | Rebuild or lazily repopulate them |
| Hibernatable incoming WebSocket | Can remain connected through hibernation | Use the Hibernation API and handle wake events |
| Serialized WebSocket attachment | Survives hibernation while that socket is healthy | Keep it small; store durable project state elsewhere |
| Alarm schedule | Can wake an inactive object | Make the handler idempotent and avoid overwriting alarms in the constructor |
| Outbound socket, stream, promise, or RPC handle | Live capability only | Reconnect, resume from durable progress, or retry |
| External side effect | Persists in the external system, outside DO rollback | Send stable idempotency keys and reconcile uncertain outcomes |

The runtime serializes synchronous JavaScript and supplies storage-aware input
and output gates. The application must still protect invariants across
non-storage awaits, reconstruct memory from committed facts, deduplicate
retries, and partition traffic by identity. A constructor is not guaranteed to
run once. A class field is not a recovery mechanism. An alarm is not exactly
once. Hibernation and eviction are not shutdown hooks.

`acme/project-42` is now restart-safe in outline: accepted mutations are tied
to committed state, stale continuations cannot overwrite a newer revision,
alarms carry durable operation identities, and every cache is treated as a
replaceable acceleration structure. But this model rests on phrases we have
not yet unpacked: *committed*, *attached*, *transactional*, *confirmed*, and
*recoverable*.

The next chapter must make those words precise. Identity can tell us where the
project's state belongs, and reconstruction can tell us when it must be read
again. Only the semantics of attached storage can tell us which writes are
atomic, when they are durable, how they are queried, and what can be recovered.

## Sources

- Cloudflare, [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).
- Cloudflare, [Lifecycle of a Durable Object](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).
- Cloudflare, [Durable Object State](https://developers.cloudflare.com/durable-objects/api/state/).
- Cloudflare, [Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
- Cloudflare, [Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/) and [error handling](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/).
- Cloudflare, [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/).
- Cloudflare Computer, [pinned lifecycle and hibernation status](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/11_lifecycle.md).
