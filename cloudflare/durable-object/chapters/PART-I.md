# Part I — Introducing Durable Objects

*How a globally addressable state owner becomes a durable agent workspace*

A coding agent edits a project, runs a formatter, installs dependencies, and
starts a compiler. Those actions look ordinary inside a VM. They become harder
to explain when the machine is disposable, the project must survive between
sessions, and several clients may issue commands at once.

The usual answer is to begin with compute: keep a container alive and attach a
disk. Durable Objects invite the opposite decomposition. Give each project a
stable identity and one state owner. Bring execution to that owner when work
arrives. Let memory and execution environments disappear, but make accepted
state reconstructible.

Part I develops that model in five steps:

```text
logical project name
        ↓
one globally addressable Durable Object identity
        ↓
disposable JavaScript incarnations over private transactional storage
        ↓
an application-defined virtual filesystem in Durable Object SQLite
        ↓
direct capability access or a synchronized container-side representation
```

The boundary between the platform and the application is essential. Durable
Objects provide identity, routing, execution, coordination, and attached
storage. Cloudflare Computer defines files, directories, fixed-size chunks,
SHA-256 content identities, manifests, synchronization, and FUSE projection.
Those Computer choices are an unusually useful case study; they are not hidden
properties of every Durable Object database.

The running example is `acme/project-42`. Chapter 1 gives it an owner. Chapter
2 makes that owner safe to reconstruct. Chapter 3 makes its storage contract
precise. Chapter 4 follows one file from authoritative SQLite rows to
`/workspace`, through native execution, and back. Chapter 5 measures the
resulting storage and speed trade-offs against the native filesystem.

---

## Chapter 1 — The Object That Owns State

> Evidence scope: Durable Objects platform contract and current platform
> behavior. Platform documentation was verified on 2026-08-06.

At 14:03:12, two people add a task to the same project.

One request enters a Worker in Sydney. The other enters a Worker in Frankfurt.
Both target Acme's project 42. Both handlers authenticate their caller, read the
project's current task sequence from a shared database, see `99`, and prepare
task `100`. Then both write successfully.

The database has not lost data. It has faithfully stored two rows. The
application has nevertheless produced two task 100s, sent two “final slot”
notifications, and violated an invariant that existed only in the handlers'
intent.

```text
client A → Worker A → read 99 ─┐
                               ├→ write task 100 twice
client B → Worker B → read 99 ─┘
```

A transaction, lock, or uniqueness constraint can repair this particular
race. That is not the larger design decision. Before choosing a locking
mechanism, the application must decide *which operations belong to one
coordination domain*. Should every task in one project be ordered together?
Every project in one team? Every project in the product? Which component may
accept a mutation, and which state must it consult before doing so?

A shared database is a place where values can persist. By itself, it does not
name the application's owner for `team/project-42`. Stateless request handlers
can agree through a database, but only after the application supplies a
transaction boundary and a protocol. The missing noun is not “storage.” It is
**owner**.

This chapter makes one decision: the running system will have one
`ProjectWorkspace` Durable Object per project. Its canonical identity follows
the pattern `team/project-42`; for the concrete request in this chapter, the
name is `acme/project-42`.

The decision rests on one invariant:

> **The object identity defines the ownership, serialization, and horizontal
> partitioning boundary.**

Everything else in the chapter—namespaces, names, IDs, stubs, routing,
placement, and scale—follows from that sentence.

### Give the project an address

Cloudflare defines a Durable Object as a special kind of Worker that combines
compute with an identity and attached durable storage. Calls made to the same
object identity are routed to the same logical object, giving otherwise
stateless Workers and clients a coordination point. Each object has private
attached storage; other objects communicate with it rather than opening that
storage directly. Cloudflare describes this as stateful serverless compute,
not as a machine that the application provisions or keeps running. [Cloudflare's
Durable Objects overview](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
documents the identity, coordination, private storage, and serverless execution
model.

The useful shift is from *where did this request run?* to *which identity owns
this request?* Worker invocations may occur in different locations and share no
memory. If both derive `acme/project-42`, both obtain a client for the same
logical owner. The platform routes the calls. The application no longer asks
two unrelated handlers to improvise an ordering protocol around project state.

“One logical owner” is deliberately narrower than “one process forever.” The
object may have an active JavaScript instance when a call arrives, or the
runtime may have to construct one. The identity remains the address either
way. This distinction is the first defense against a common but costly mental
model: a Durable Object is not a tiny, permanently running VM.

<!-- Figure 1.1 placeholder: replace with a rendered diagram using the book's identity, execution, and durability palette. -->

```text
MULTIPLE CALLERS           IDENTITY ROUTING                     LOGICAL OWNERS

Client A ─→ Worker A ─┐
                      ├─→ PROJECT_WORKSPACES namespace
Client B ─→ Worker B ─┘        + "acme/project-42" ─────────→ ProjectWorkspace
                                    │                           acme/project-42
                                    └─ deterministic object ID          │
                                                                       ▼
                                                           private attached SQLite

Client C ─→ Worker C ─────→ same namespace
                              + "acme/project-77" ─────────→ ProjectWorkspace
                                                                  project-77

Client D ─→ Worker D ─────→ same namespace
                              + "northwind/project-9" ──────→ ProjectWorkspace
                                                                  project-9

                             many identities → many peer owners → horizontal scale
```

*Figure 1.1 — The Object That Owns State. Many callers converge on one owner
when they use the same identity; different identities create independent peer
owners, so the ownership boundary is also the horizontal scaling boundary.*

The figure contains no central `ProjectWorkspace` server. It contains a set of
logical objects. Project 42 gets one coordination point because all of its
callers choose one identity. Project 77 and Northwind's project 9 get different
coordination points because their identities differ. Scale comes from the
number and quality of those boundaries, not from turning one identity into an
unbounded singleton.

### Class, namespace, object

Three terms that often collapse into “the Durable Object” have different jobs.

The **class** is the TypeScript behavior. `ProjectWorkspace` defines public RPC
methods such as `addTask()` and, in later chapters, the code that reconstructs
memory and commits project state.

The **namespace** is the set of logical objects backed by that class. A Worker
receives a namespace through a binding—for this book,
`env.PROJECT_WORKSPACES`. Cloudflare's namespace API describes a namespace as a
set containing any number of objects backed by the same Durable Object class.
The namespace is how code derives IDs and obtains stubs; it is not itself one
giant `ProjectWorkspace`. [The official namespace
reference](https://developers.cloudflare.com/durable-objects/api/namespace/)
defines that relationship.

An **object** is one member of the namespace, selected by an object ID. The
class says *how project workspaces behave*. The namespace says *which family of
objects this binding can address*. The ID says *which project owns this call*.

At the 2026-08-06 research date, a new Worker can declare the binding and a
SQLite-backed class in `wrangler.jsonc` like this:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "project-workspaces",
  "main": "src/index.ts",
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

The binding exposes the namespace to the Worker. The `exports` declaration
asks Cloudflare to provision and manage the class namespace and selects SQLite
for its attached storage. This chapter will not use the storage API; Chapter 3
owns that contract. The declaration is shown now only to make the namespace
concrete. Cloudflare's current documentation says the declarative `exports`
flow replaces the older imperative `migrations` array for new Workers, while
both flows remain supported and cannot be mixed in one Worker. Because this is
a recent deployment-surface change, recheck it before publication. [Durable
Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
documents the current configuration.

### Names become IDs; IDs become stubs

The public route contains application identity, not a Durable Object address:

```text
/teams/acme/projects/42/tasks
```

The router first maps that route to an authenticated project record. It then
derives a canonical object name:

```text
acme/project-42
```

In the running example, `acme` is assumed to be an immutable tenant key and
`42` an immutable project key. A mutable display label such as “Acme Launch”
would be a poor object name: renaming the label would derive a different ID and
therefore address a different object. Real systems should canonicalize from
stable internal keys, not blindly concatenate untrusted URL text. The notation
`team/project-42` describes the identity scheme; `acme/project-42` is one value
in that scheme.

The namespace offers two identity strategies.

With a **deterministic name**, `idFromName("acme/project-42")` always derives
the same `DurableObjectId` in the same namespace. That is exactly what a router
needs when every caller can independently compute the project's owner.
`getByName(name)` is the convenient direct route: it derives the named identity
and returns a stub for it. Named objects are the common choice for documents,
rooms, users, games, agents, and projects whose application identity already
exists.

With a **random unique ID**, `newUniqueId()` creates a fresh identity that has
no derivable business name. The application must preserve its string form or
some other mapping if it wants to find that object again. This is useful when
creation itself should allocate a new object—an invitation-only room, a new
game session, or an internal run whose ID will be recorded—rather than route
all callers from an existing natural key. The namespace reference documents
both behaviors and notes that unique IDs must be stored for later reuse.
[Cloudflare's namespace ID methods](https://developers.cloudflare.com/durable-objects/api/namespace/#methods)
are the platform contract for `idFromName()`, `newUniqueId()`, `get()`, and
`getByName()`.

| Need | Identity operation | Routing consequence |
| --- | --- | --- |
| Find the owner from a stable business key | `getByName("acme/project-42")` | Every caller that derives the same name reaches the same object |
| Inspect or retain the platform identity separately | `idFromName(name)`, then `get(id)` | The explicit ID and the convenience path select the same named object |
| Allocate an object with no natural name | `newUniqueId()`, store its string form, then `get(id)` | The stored mapping, not deterministic derivation, makes the object discoverable later |

Names are scoped by their namespace. The string `acme/project-42` in a
`PROJECT_WORKSPACES` namespace is not the same logical entity as the same
string in a `CHAT_ROOMS` namespace. That is why the full routing decision is
not just a name. It is **namespace plus object identity**.

The resulting `DurableObjectId` is the platform identity used to select one
logical object. Cloudflare currently represents it as an opaque 64-digit
hexadecimal value and requires it to be constructed through its namespace. The
hex string is useful for logs and persistence; it is not the active instance,
a hostname, or a public URL. [The Durable Object ID
reference](https://developers.cloudflare.com/durable-objects/api/id/)
describes its construction and round-trip behavior.

A **stub** is a client object bound to that identity. It is the caller's handle
for invoking a public RPC method or the object's `fetch()` handler. The stub is
not a local copy of the object and does not expose the attached database. It is
closer to a typed remote reference: calling `stub.addTask()` sends an
asynchronous RPC to the selected `ProjectWorkspace`.

Cloudflare guarantees ordering for multiple calls made through the same stub,
but not between different stubs. That narrower guarantee matters: two clients
will normally hold different stubs even when both stubs select project 42. The
object remains the shared coordination boundary; a caller must not treat one
stub as a global client-side lock. [The Durable Object stub
reference](https://developers.cloudflare.com/durable-objects/api/stub/)
defines the stub as a remote client and documents its call-ordering scope.

### Follow one request to its owner

Now follow the required mutation without skipping an identity layer:

```text
POST /teams/acme/projects/42/tasks
        │
        ▼
derive stable object name: acme/project-42
        │
        ▼
namespace.getByName("acme/project-42")
        │
        ▼
stub.addTask(...)
        │
        ▼
one ProjectWorkspace owner accepts the mutation
```

The routing slice of the Worker is ordinary TypeScript. The
`ProjectWorkspace.addTask()` implementation is intentionally outside this
excerpt: Chapter 2 will make its event handling safe across reconstruction and
`await`, and Chapter 3 will supply its durable transaction. Here the important
line is the one that chooses the owner.

```ts
import type { ProjectWorkspace } from "./project-workspace";

interface Env {
  PROJECT_WORKSPACES: DurableObjectNamespace<ProjectWorkspace>;
}

interface NewTaskRequest {
  title: string;
}

function projectObjectName(teamKey: string, projectKey: string): string {
  // These keys have already been authenticated, validated, and canonicalized.
  return `${teamKey}/project-${projectKey}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route =
      /^\/teams\/([^/]+)\/projects\/([^/]+)\/tasks$/.exec(url.pathname);

    if (request.method !== "POST" || route === null) {
      return new Response("Not found", { status: 404 });
    }

    const teamKey = decodeURIComponent(route[1]);
    const projectKey = decodeURIComponent(route[2]);
    const objectName = projectObjectName(teamKey, projectKey);

    const workspace = env.PROJECT_WORKSPACES.getByName(objectName);
    const command = (await request.json()) as NewTaskRequest;
    const receipt = await workspace.addTask(command);

    return Response.json(receipt, { status: 201 });
  }
} satisfies ExportedHandler<Env>;
```

The trace has seven identities or representations, each with a distinct role:

| Layer | Value in the trace | What it means |
| --- | --- | --- |
| User-facing project identity | Team `acme`, project `42`, perhaps displayed as “Acme Launch” | Domain identity presented by the API and UI; display text may change |
| Canonical object name | `acme/project-42` | Stable application string used to derive the owner |
| Namespace | `env.PROJECT_WORKSPACES` | Bound family of objects implemented by `ProjectWorkspace` |
| Object ID | The `DurableObjectId` derived from the canonical name | Platform identity of this one logical object |
| Stub | `workspace` | Caller-side remote reference carrying calls to that ID |
| Active JavaScript instance | The current in-memory `ProjectWorkspace` class instance, if one is active | Disposable execution that handles the invocation; not the durable identity |
| Attached database | Project 42's private SQLite database | State attached to the logical object identity, not to the calling Worker or a particular in-memory instance |

The user-facing name and the canonical object name are application choices. The
namespace, ID, and stub are platform routing concepts. The active JavaScript
instance is execution. The attached database is durable state. Calling all of
them “the object” hides exactly the failures the model is meant to prevent.

Suppose the Frankfurt Worker has never seen project 42. It does not need a
registry lookup containing the current host of that project. It derives the
same canonical name and asks the same namespace for a stub. The platform maps
that identity to the logical owner. If a Worker needs the ID explicitly for a
log or another data structure, these two forms express the same named routing
choice:

```ts
const byName = env.PROJECT_WORKSPACES.getByName("acme/project-42");

const id = env.PROJECT_WORKSPACES.idFromName("acme/project-42");
const byId = env.PROJECT_WORKSPACES.get(id);
```

`getByName()` is not a broadcast or a search. It does not scan projects whose
metadata happens to contain that name. It computes one identity in one
namespace and returns a stub for that identity.

### A stub is a route, not a running process

ID creation is lazy. Creating an ID does not construct the Durable Object.
Obtaining a stub also does not send a request or start the object's lifecycle.
Cloudflare's lifecycle documentation says the lifecycle begins when code
invokes a method on the stub. At that point, if no active instance exists, the
runtime constructs the class instance and then runs the invoked method.
[The Durable Object lifecycle
reference](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
distinguishes stub creation from invocation and activation.

That sequence is easy to misread:

```text
derive name → obtain ID → obtain stub       no project code has run
                                  │
                                  ▼
                         invoke addTask()    request is routed
                                  │
                                  ▼
                   construct if needed → run method
```

The logical object can therefore be addressable while having no JavaScript in
memory. “Object creation” is often used casually for several moments: deriving
an ID, obtaining a stub, first invoking a method, constructing an in-memory
instance, or first writing attached storage. They are not one event. For this
chapter, the precise statement is enough: obtaining a reference does not mean
project work has started.

The call can use one of two surfaces. Modern Durable Object classes expose
public methods as Workers RPC methods, so the router can call
`await stub.addTask(command)`. When the application needs an HTTP-shaped
boundary, it can implement the object's `fetch()` handler and call
`await stub.fetch(request)`. Current Cloudflare guidance prefers RPC for new
projects and retains `fetch()` for HTTP request/response flows and legacy
compatibility. Both are calls *through the stub to the selected identity*; the
choice does not alter the ownership boundary. [Cloudflare's method invocation
guide](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/)
documents both paths.

This routing also applies from one Durable Object to another. A project object
can obtain a stub for a document object, an agent object, or another project and
invoke it. The syntax can look like a local method call, but the semantics are
distributed: the callee has a different identity, may be in a different
location, owns different private storage, and can fail independently. Crossing
an object boundary is explicit communication, not shared memory and not a
cross-object transaction. Object-to-object communication is therefore explicit
distributed communication, even when RPC makes it look like an ordinary method
call.

### Initial placement is not identity

A global address does not imply that one object's compute and state exist in
every data center. A given Durable Object runs in one geographic location, and
requests elsewhere are forwarded to it. Identity tells the platform *which
object*. Placement tells it *where that object initially lives*. These are
related routing concerns, not interchangeable identities.

Cloudflare's current default is to place a new object close to the location of
its initial lookup/access. An application can pass a `locationHint` while
obtaining the first stub to suggest a region near the expected users. The hint
applies only to initial placement and is best effort: it is not a pin and does
not guarantee a particular data center. A hint such as `weur` means “optimize
initial placement near Western Europe,” not “this project's identity is
Western Europe.” [Cloudflare's data-location
documentation](https://developers.cloudflare.com/durable-objects/reference/data-location/#provide-a-location-hint)
documents the default, first-call behavior, and best-effort status.

Jurisdictions solve a different problem. A jurisdiction-restricted namespace
constrains where an object's compute runs and data persists for regulatory or
geographic policy. Workers elsewhere may still call that object. Unlike a
location hint, a jurisdiction is a placement constraint, not a latency
preference. A name derived in a jurisdiction-restricted subnamespace can also
represent a different ID from the same name in the unrestricted namespace, so
the jurisdiction choice belongs in identity policy rather than in an
afterthought at the call site. [Cloudflare's jurisdiction
reference](https://developers.cloudflare.com/durable-objects/reference/data-location/#restrict-durable-objects-to-a-jurisdiction)
describes that scope.

As of 2026-08-06, Cloudflare documents that Durable Objects do not dynamically
change geographic locations after creation. The platform may manage hosts and
restart execution, but applications should not promise that an existing hot
project will follow users around the world. Location hints influence initial
placement; jurisdictions constrain permitted placement; neither is a dynamic
geographic migration API. This is current platform behavior and must be
rechecked before publication.

The operational consequence is simple. Let representative production traffic
make the first access, or provide a justified hint. Do not pre-touch every
project from a centralized deployment job and accidentally make that job's
location representative of the entire user base. More importantly, do not use
placement to repair a bad object boundary. A project with mutually dependent
operations still needs one owner even when its collaborators are far apart.

### Choose the atom of coordination

An object boundary should contain the state and operations that must agree
before one of them is accepted. Cloudflare's current design guidance calls this
the application's “atom” of coordination and recommends one object per logical
unit such as a chat room, game session, document, user, or tenant workspace.
[The Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#model-your-durable-objects-around-your-atom-of-coordination)
ties this modeling choice directly to serialization and scale.

For the running system, one project is the right first atom:

- Task numbering, task status transitions, project-level quotas, and the
  project's audit order can be checked by one owner.
- Project metadata and the subset of membership or role information needed to
  authorize project mutations can live with that owner.
- Connected collaborators and project-scoped schedules can route to the same
  identity when later chapters add those capabilities.
- The project's durable workspace will eventually attach to this same owner,
  so file operations and project coordination share an authoritative home.

The last item is a direction, not a Chapter 1 implementation claim. This
chapter establishes the owner; later chapters build its storage and filesystem.

Several categories do *not* belong in `acme/project-42` merely because a
project screen displays them:

- Global user profiles, login sessions, and organization-wide authorization
  policy have lifecycles beyond one project.
- Cross-project search, analytics, and billing aggregation span many owners and
  need a separate indexed or analytical path.
- Public static assets and immutable package content do not require every read
  to pass through the project's coordination point.
- State for another project belongs to that project's identity, even when a
  workflow touches both.

There is no prize for putting the most data behind one ID. The question is
which facts participate in the same invariants. Data needed on every project
mutation may be copied or summarized under an explicit policy; globally
authoritative account data should keep its own owner. A Durable Object's
private storage reinforces this separation: another object calls its methods
rather than reaching into its database.

The boundary can also become finer. If one project contains thousands of
independent collaborative documents, each document may deserve its own object
while the project object owns the directory, policy, and project-wide
invariants. If each agent run has independent high-volume coordination, use one
agent or run object and let the project object track it. Such a split buys
parallelism by turning formerly local coordination into object-to-object
communication. That is a trade, not a free optimization.

A practical test is:

> If two operations must observe and preserve one invariant before either is
> accepted, route them to the same identity. If they are independent and may
> progress in parallel, give them different identities.

This test does not force every related record into one object. It forces the
application to state where agreement happens.

### Scale by adding owners, not by heating one

The namespace makes horizontal scale look almost mundane:

```text
PROJECT_WORKSPACES
  ├── acme/project-42
  ├── acme/project-77
  ├── northwind/project-9
  ├── globex/project-314
  └── ...many independent owners
```

Each identity can be placed and activated independently. Traffic for project
42 does not have to serialize with traffic for project 77. The namespace is
the family; the object ID is the partition key. In this model, identity is not
metadata attached after sharding. Identity *is* the sharding decision.

The failure mode is equally simple:

```ts
const everything = env.PROJECT_WORKSPACES.getByName("global");
```

If every request uses that string, the application has created one global
singleton. All project coordination, synchronous JavaScript work, and access to
that object's private storage converge on one hot owner. Adding more stateless
Workers does not partition the bottleneck because every Worker derives the same
ID. Cloudflare explicitly warns that a single global Durable Object handling
all traffic becomes a bottleneck and recommends sharding by the logical unit of
coordination. [The platform's singleton
guidance](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#do-not-use-a-single-durable-object-as-a-global-singleton)
describes this failure mode.

“Single owner” therefore does not mean “the application has one object.” It
means “one chosen identity has one coordination point.” A healthy application
may have millions of logical entities and therefore many peer owners. Even
within the running system, one project may later split into project, document,
and agent objects when their independent workloads justify the communication
cost.

Nor does one object make every sequence automatically safe. The platform gives
events for an identity one execution context and serializes synchronous
JavaScript work, but asynchronous methods can cross `await` boundaries and
interact with storage and external systems. The ownership boundary tells us
*where* concurrency must be reasoned about; it does not remove that reasoning.
Chapter 2 will examine the exact lifecycle and concurrency model rather than
smuggling a stronger guarantee into the word “single.”

### Keep the nouns separate

The incident at the start becomes straightforward once each layer keeps its
job.

- A **shared database** can durably store rows and can coordinate operations
  when the application uses its transaction and constraint mechanisms. It does
  not, by its mere presence, decide that project 42 is the unit of ownership.
- A **Durable Object namespace** is a family of objects backed by one class. It
  is not one enormous object that serializes the whole family.
- An **object name** is application input to identity derivation. It is not the
  active isolate, host, or attached database file.
- A **stub** is a caller-side route to an object. Obtaining it neither starts
  the object nor proves that a JavaScript instance is in memory.
- A **Durable Object** is not a permanently running VM. It is a durable,
  addressable logical owner whose execution can be activated when needed.
- A **single owner** applies to one identity. The application scales by choosing
  many meaningful identities, not by funneling everything through `global`.

Now replay the request. The client names Acme's project 42. A stateless Worker
authenticates that domain identity and derives `acme/project-42`. The
`PROJECT_WORKSPACES` namespace maps the name to one object ID and returns a
stub. Invoking `addTask()` sends the mutation to the logical project owner. If
necessary, the runtime constructs an active `ProjectWorkspace` instance. The
instance handles the event on behalf of an identity whose private attached
database is distinct from both the calling Worker and the temporary in-memory
instance.

The application has chosen where project coordination lives. It has not yet
answered two questions that the incident makes unavoidable: what happens when
the active JavaScript instance disappears, and what remains serialized when a
method pauses at `await`? Those are lifecycle and concurrency questions. The
next chapter follows the same `acme/project-42` identity through both.

### Sources

- Cloudflare, [What are Durable Objects?](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
- Cloudflare, [Durable Object Namespace](https://developers.cloudflare.com/durable-objects/api/namespace/), [ID](https://developers.cloudflare.com/durable-objects/api/id/), and [Stub](https://developers.cloudflare.com/durable-objects/api/stub/) references
- Cloudflare, [Invoke methods](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/) and [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- Cloudflare, [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- Cloudflare, [Data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- Cloudflare, [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)

---

## Chapter 2 — Identity Persists; Memory Does Not

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

### One identity, many incarnations

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

### One JavaScript stack at a time is not one transaction at a time

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

#### Trace 1: the stale snapshot that deletes an accepted task

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

### Gates protect storage boundaries, not arbitrary intentions

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

#### Block only the initialization that must be complete

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

### The lifecycle is a sequence of reconstructible incarnations

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

#### Trace 2: eviction after acceptance

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

### A connection may survive when its JavaScript does not

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

### Alarms promise another attempt, not exactly one effect

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

### There is no dependable last moment

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

### The one-owner model has a hot-object ceiling

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

### What survives, and what the application must do

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

### Sources

- Cloudflare, [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).
- Cloudflare, [Lifecycle of a Durable Object](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).
- Cloudflare, [Durable Object State](https://developers.cloudflare.com/durable-objects/api/state/).
- Cloudflare, [Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
- Cloudflare, [Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/) and [error handling](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/).
- Cloudflare, [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/).
- Cloudflare Computer, [pinned lifecycle and hibernation status](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/11_lifecycle.md).

---

## Chapter 3 — Durable Storage: From Legacy KV to SQLite

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

### The storage contract belongs to one object

Every Durable Object has attached storage private to that unique object. `acme/project-42` can open its own storage through `this.ctx.storage`; `acme/project-43` cannot open the same database, and a router Worker cannot query it directly. Another object reaches project 42 by calling its stub, then lets the `ProjectWorkspace` object enforce the project's methods and invariants. Cloudflare's Storage API documentation describes this attached storage as transactional and strongly consistent, while the Durable Objects glossary makes the consistency level explicit as serializable. Each storage method is itself atomic and isolated, including a multi-key method. Larger application changes use an explicit transaction boundary. [Cloudflare's SQLite Storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) and [Durable Objects glossary](https://developers.cloudflare.com/durable-objects/reference/glossary/) define this contract.

The scope matters. The guarantee is not a transaction across all Durable Objects in a namespace, across D1, R2, Workers KV, and an external API. It is the attached storage of one object. If project 42 must coordinate with another project or charge a credit card, those are messages or external effects that need a protocol above the local database transaction.

Attached storage is also not the product named **Workers KV**. Both expose key-value operations, but Workers KV is a separate globally distributed service with a separate binding and consistency model. The key-value methods on `ctx.storage` operate on the Durable Object's private, strongly consistent attached storage. A Durable Object can separately bind to Workers KV, but that is an explicit second store, not where `ctx.storage.put()` writes.

Finally, storage outlives an active JavaScript instance; memory does not. Once a write has been confirmed, eviction, hibernation, deployment, or host failure can cause a new `ProjectWorkspace` instance to be constructed without erasing the accepted database state. That does not make every assignment to a class field durable, nor does it create a shutdown opportunity in which memory can be flushed at the last moment. Durable facts must cross the Storage API boundary before they are relied upon.

### Four axes, not one generation label

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

### Provision the running workspace on SQLite

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

### Give `team/project-42` an application schema

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

### Synchronous SQL, cursors, and the `await` boundary

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

### One task change, one synchronous transaction

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

### Synchronous KV and asynchronous compatibility on SQLite

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

### The legacy KV API: maintenance knowledge

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

#### Options are gate and cache controls

Three legacy options alter scheduling or performance, not the private strongly consistent identity of the store.

`allowConcurrency: true` applies to reads and lists. Normally, while an asynchronous storage operation is outstanding, the input gate delays delivery of unrelated events to the object. That makes a natural read-then-write sequence safer from unexpected request interleaving around storage awaits. Opting out can increase concurrency, but then the application accepts responsibility for values changing while the operation is in flight. It does not make a transaction larger or weaken storage consistency; it weakens the event-delivery protection around the calling code.

`allowUnconfirmed: true` applies to asynchronous writes such as `put`, `delete`, and `deleteAll` and to the legacy write-shaped alarm methods. Normally, the output gate holds later outgoing responses and network requests until preceding writes are confirmed. Opting out allows external messages to proceed on the basis of an unconfirmed write. That may be a valid latency tradeoff for disposable hints, but it is wrong for “task completed” unless a later protocol repairs false success.

`noCache: true` is only a performance hint. On a read, it asks not to insert the result into the in-memory cache; an already cached value may still be returned. On a write, it asks that the value be discarded from memory after persistence. The write buffer still supplies a just-written value to a subsequent read, preserving semantics. `noCache` must never be used as a consistency switch.

Input and output gates solve different directions of observation. The input gate controls when code may be resumed or another event delivered while storage I/O is pending. The output gate controls when the outside world may observe messages after writes. Neither turns external I/O into part of a database transaction. [Cloudflare's engineering article on input and output gates](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/) explains the scheduling model; the current API page defines the options.

#### Trace: coalescing versus backpressure

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

#### Explicit asynchronous transactions and rollback

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

#### Alarms and complete deletion

Both backend generations support alarms. An object can have one scheduled alarm at a time. `getAlarm` reads its scheduled Unix-millisecond timestamp or no alarm, `setAlarm` schedules or replaces it, and `deleteAlarm` removes it without canceling a handler already running. Alarm mutations are Storage API operations and follow storage ordering and gating rules. The current SQLite alarm documentation exposes synchronous forms; the legacy KV storage page documents Promise-returning forms and legacy options. The handler itself remains at-least-once work and must be idempotent, as Chapter 2 established. [Cloudflare's Alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/) documents the common behavior.

`deleteAll()` has a much sharper backend distinction. On SQLite it atomically removes the entire private database contents, including application SQL and hidden KV data. On legacy KV, an in-progress deletion can fail after deleting only a subset of keys. Maintenance code cannot interpret a rejected legacy `deleteAll()` as “nothing changed”; it must tolerate and, when appropriate, retry partial cleanup.

Alarm deletion is compatibility-date-sensitive. With compatibility date `2026-02-24` or later, `deleteAll()` also deletes an active alarm. Earlier dates leave the alarm unless `deleteAlarm()` is called separately or the `delete_all_deletes_alarm` flag is enabled. The running system's `2026-08-06` date receives the new behavior, but explicit alarm cleanup can still make destructive intent clear. This date must be preserved in tests because moving it can change deletion semantics.

### Backend capabilities, verified as of 2026-08-06

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

### A synchronous write is not yet an observable success

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

### Three different meanings of size

`ctx.storage.sql.databaseSize` synchronously reports the current SQLite database size in bytes. It is useful for operational thresholds, but it should not be renamed “project bytes” or “monthly billed bytes.” At least three quantities coexist:

| Quantity | What it measures | Typical contents |
| --- | --- | --- |
| Logical application bytes | A metric defined by the application | Task text, attachments, or other selected payload lengths |
| SQLite database size | `databaseSize` at a point in time | Tables, indexes, page overhead, hidden KV data, and database allocation effects |
| Billed storage and operations | Platform metering over time | Stored SQL data plus metered rows read/written and platform metadata under current pricing rules |

Deleting logical rows does not guarantee these numbers move together immediately or by the same amount. Indexes consume database space and add write work. Empty tables and internal metadata can occupy billable bytes. Billing accumulates over time, while `databaseSize` is a current database-level observation. If project 42 needs a quota over user-authored content, maintain that logical metric explicitly instead of treating a SQLite file-size property as an application accounting policy.

> **Dated pricing note — 2026-08-06.** Current pricing meters SQLite-backed Durable Objects by rows read, rows written, and stored data; KV-compatible methods operate through hidden SQLite storage and are metered accordingly. Index updates add row writes, deletes count as writes, and internal metadata contributes to stored data. Rates and included quotas are intentionally omitted here because they are volatile; verify them on [Cloudflare's Durable Objects pricing page](https://developers.cloudflare.com/durable-objects/platform/pricing/) immediately before publication.

### PITR restores a database, not a project story

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

### What is guaranteed, described, and still application work

The platform contract is strong but scoped. One object owns private attached storage. Storage operations are strongly consistent and serializable. Individual methods are atomic and isolated, and explicit transactions group a larger local invariant. Output gates prevent confirmed external success from racing ahead of writes by default. SQLite-backed storage adds SQL, synchronous KV, synchronous transactions, and PITR.

Current product behavior adds dates and limits to that contract: 128-key asynchronous bulk operations, legacy value limits, the `2026-02-24` `deleteAll()` alarm behavior, current backend-creation restrictions, a 30-day PITR window, local-development exclusions, and current billing rules. Those facts belong in dated notes because they can change without invalidating the architecture.

Cloudflare's engineering article describes how embedded SQLite, write-ahead-log interception, relay confirmation, object-storage batches, snapshots, and output gates have been combined. It is useful implementation evidence, but applications should not depend on those physical details as a queryable schema or fixed topology.

The application still chooses table design, indexes, schema migrations, transaction boundaries, idempotent external-effect protocols, logical quotas, audit retention, and user-visible history. Strong storage cannot infer which two statements form a business invariant. PITR cannot infer that one file should be undone while another is preserved. A synchronous API cannot decide which response is safe to expose after an unconfirmed write.

For the `team/project-42` design, concretely `acme/project-42`, the result is now clear. Tasks and audit rows live in private SQLite. One synchronous transaction protects completion. Output gating protects write-to-response visibility. PITR supplies whole-database operational recovery. Legacy KV behavior remains understood without becoming the foundation of new code.

The next question is no longer whether the project can keep durable rows. It is: **how can application-defined SQLite rows become a filesystem?**

### Sources

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

---

## Chapter 4 — From Durable Object to `/workspace`

An agent has just finished the first pass on a small TypeScript service. Through the Workspace API it created `/workspace/project-42/src/index.ts`, wrote a test, and left a short plan in `/workspace/project-42/NOTES.md`. The next step needs a native compiler, so the orchestrator starts a container and runs:

```text
cd /workspace/project-42 && npm test
```

The files are there. The compiler rewrites a generated file, the test process creates a coverage report, and those outputs are visible through the Workspace API after the command completes. It is tempting to describe this as “the Durable Object filesystem is mounted into the container.” That sentence is convenient, and wrong in exactly the way that matters when a command races with another writer, a container restarts, or a sync cursor advances after a partial transfer.

The Durable Object’s SQLite database is not a network block device. FUSE does not issue SQL against it. The container does not hold an open file descriptor into Cloudflare’s storage layer. Instead, Computer maintains an authoritative virtual filesystem in the Durable Object and, for a container backend, constructs a second virtual filesystem inside `computerd`. Synchronization converges the two current states. FUSE exposes the second one at `/workspace`.

That distinction is the organizing invariant for this chapter:

> **The authoritative Computer filesystem lives in Durable Object SQLite. An execution backend either reaches that filesystem directly or works against a synchronized representation.**

This chapter follows `project-42` from the authoritative rows to a container process and back. The source baseline is Cloudflare Computer commit [`76d9e75c5688713b656bce85540d9e0071cece8b`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b), inspected on 2026-08-06. That pin matters because the repository documentation describes both shipped behavior and intended behavior. Where they differ, the pinned implementation and tests are the evidence for what exists.

### The platform boundary

Durable Objects supply the substrate: a globally addressable object identity, colocated execution, private storage, transactions, and recovery across object restarts. Cloudflare describes each object as having its own strongly consistent storage, accessible only within that object, while its in-memory state may disappear when the object goes idle. Those properties make a Durable Object a natural authority for a workspace, but they do not themselves define files, directories, chunks, manifests, or FUSE mounts. Those are application choices made by Computer. See Cloudflare’s [Durable Objects overview](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/) and [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

The boundary is easiest to state as two columns:

| Durable Objects platform provides | Computer application defines |
| --- | --- |
| Object identity and request execution | The `Workspace` abstraction |
| One object’s private SQLite storage | The `vfs_*` relational schema |
| SQL execution and transactional storage | Files, directories, links, chunks, and manifests |
| Durable recovery of committed storage | Revision and synchronization protocols |
| Runtime lifecycle | Runtime adapters, FUSE, and the `/workspace` convention |

Consequently, “the VFS lives in Durable Object SQLite” has a precise and intentionally modest meaning: Computer stores its filesystem rows and byte BLOBs by executing SQL through `ctx.storage.sql`. It does **not** mean that Durable Objects have a hidden proprietary filesystem format, that SQLite pages are mounted into a container, or that Cloudflare’s platform knows what a `vfs_node` represents.

The construction path in the pinned code makes the ownership boundary unusually clear. An application passes the Durable Object storage handle to `new Workspace({ storage: ctx.storage, ... })`. The `Workspace` constructor wraps that handle in Computer’s `Database`, initializes Computer’s schema, and builds a `WorkspaceFilesystem` over the database. `Database` itself exposes the supplied storage’s `.sql` interface. In other words, the chain is:

```text
Durable Object ctx.storage
        │
        ▼
new Workspace({ storage: ctx.storage })
        │
        ├── new Database(storage) ──► storage.sql
        ├── initializeSchema(database)
        └── new WorkspaceFilesystem(database)
```

The three constructor operations are adjacent in [`packages/computer/src/workspace.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/workspace.ts#L298-L300), while the storage adapter assigns the SQL surface in [`packages/dofs/src/storage.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/storage.ts#L9-L25). There is no intervening filesystem service. A call such as `workspace.fs.writeFile(...)` reaches the provider backed by that database.

This also fixes the scope of “a Workspace.” In the common mapping used throughout this book, one logical project—our `project-42`—is owned by one Workspace inside one Durable Object identity. The Durable Object is the durable coordination boundary. Different Durable Objects have private databases; Computer does not use a shared cross-object blob table. That fact will become important when we discuss deduplication.

### A filesystem expressed as relations

The authoritative filesystem is not stored as one serialized tree. Computer decomposes it into metadata, namespace edges, content-addressed objects, and sync bookkeeping. The core and sync schemas are created by the statements in [`schema/core.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/schema/core.ts#L20-L79) and [`schema/sync.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/schema/sync.ts#L6-L58). The names start with `vfs_` because they belong to Computer’s virtual filesystem, not because Durable Objects reserve that prefix.

Here is the conceptual job of each major table at the pinned commit.

| Table | Conceptual role |
| --- | --- |
| `vfs_meta` | Singleton filesystem metadata: the schema version and the next/current logical revision counter used to order mutations. |
| `vfs_nodes` | One row per inode-like object. It records type, mode, modification time, revision, size, symlink target where applicable, mount metadata, and the current file manifest hash. |
| `vfs_dirents` | Directory edges: a parent inode plus a name points to a child inode. This separates names from nodes and permits inode-oriented operations such as links. |
| `vfs_blobs` | The content-addressed object catalogue. A SHA-256 hash identifies a payload and the row records its size and last-seen time. |
| `vfs_blob_bytes` | The actual bytes for an object hash, stored as a SQLite BLOB. Separating catalogue metadata from bytes lets object presence be probed without reading every payload. |
| `vfs_chunks` | The ordered chunk map for each file inode. Chunk index zero, one, two, and so on point at hashes and sizes in the blob store. |
| `vfs_manifests` | Content-addressed encodings of complete current chunk lists. A manifest says which chunk hashes, in which order and sizes, constitute current file content. |
| `vfs_changes` | Explicit change-log records needed for facts that cannot be reconstructed from live rows alone, especially tombstones for deletions. Live files are otherwise materialized from current namespace state. |
| `_vfs_watermark` | Per synchronization peer/backend progress for what local changes have been acknowledged as pushed. |
| `_vfs_fetch_cursor` | Per synchronization peer/backend `(revision, path)` progress for changes fetched from the other side. |
| `_vfs_mounts` | Shipped mount-index bookkeeping: mount root, kind, whether it has been indexed, and read-only/read-write mode. At this pin it supports the narrow eager mount implementation; it is not the richer lazy mount system described as a target in some design documents. |

Several design consequences fall out of this decomposition.

First, a pathname is not the primary identity of a file. Resolving `/workspace/project-42/src/index.ts` means walking `vfs_dirents` from the root to node rows. Renaming a directory edge need not duplicate its child’s content. Hard links can give more than one path to a node, although synchronization still emits a current-state entry for each path that must exist at the destination. Tests explicitly cover that per-path behavior in [`coalesce.test.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/sync/coalesce.test.ts).

Second, file metadata and file bytes have different identities. A `vfs_nodes` row identifies the file object in the namespace; a manifest hash identifies its current ordered content description; chunk hashes identify reusable byte payloads. An update can therefore alter one chunk and one manifest without retransmitting every unchanged chunk.

Third, revisions are ordering coordinates, not retained file versions. A mutating operation advances the logical revision and stamps affected state. Synchronization uses a cursor containing a revision and path so that multiple entries at the same revision can be resumed deterministically. But the inode has only one `manifest_hash`: the current one. The schema does not preserve a chain of prior manifests per path, and current-state coalescing deliberately collapses repeated writes. The tests show five rewrites becoming one outgoing current entry, not five historical states, in [`coalesce.test.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/sync/coalesce.test.ts#L119-L170).

That is why “revision” must not be silently upgraded to “version.” If an agent writes `A`, then `B`, then `C` before a peer fetches, the protocol’s purpose is to make the peer converge on `C`. It is not a time-travel API for retrieving `A` or `B`. Old content objects may remain physically present until garbage collection, but orphaned bytes are an implementation residue, not a supported history model. The manifest tests demonstrate both sides: identical current content reuses one manifest, while overwriting can leave the old manifest orphaned until cleanup ([`manifests.test.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/sync/manifests.test.ts)).

The two cursor tables solve different directions of the same convergence problem. A push watermark answers, “How far through **my** current changes has this backend accepted?” A fetch cursor answers, “How far through **its** snapshot have I applied?” Both are keyed by backend in the shipped schema because one Workspace may interact with more than one runtime handle over time. The path component is not cosmetic: it provides a stable continuation when several paths share a revision. The protocol can restart from a precise boundary without treating a revision as if it named exactly one file.

#### The mount table is real, but the larger mount design is not yet real

The repository’s design documents illustrate a broader mount subsystem: lazy stubs, remote providers, write-back modes, and other policies. At the pinned commit, the code ships a smaller slice. `WorkspaceOptions` accepts mounts, a mount registry is built, mounted trees can be eagerly indexed, and `_vfs_mounts` records the index and mode. An R2-backed provider and write guards exist. The shipped code does not implement every lazy or write-back behavior in the target documents; the implementation itself even rejects non-eager strategies. Compare the target language in [`docs/06_mount_interface.md`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/06_mount_interface.md) with the checks in [`packages/computer/src/mounts/index.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/mounts/index.ts) and schema in [`schema/sync.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/schema/sync.ts#L52-L58).

For this chapter, `_vfs_mounts` belongs in the table tour because it is shipped. The aspirational remote-mount architecture does not belong in the execution trace because `project-42` does not depend on it.

### From a byte stream to content-addressed objects

Suppose the agent writes a file of 1,048,676 bytes: two full 512 KiB regions plus 100 bytes. Computer divides the resulting byte sequence at fixed offsets:

```text
chunk 0: bytes       0 ..   524,287   (524,288 bytes)
chunk 1: bytes 524,288 .. 1,048,575   (524,288 bytes)
chunk 2: bytes 1,048,576 .. 1,048,675 (100 bytes)
```

Each chunk is at most 512 KiB. Computer computes a SHA-256 digest for the chunk bytes, stores the digest as the object identifier, and inserts the payload only if that hash is not already present. The constant, digest construction, and fixed-window loop are visible in [`writeFile.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/writeFile.ts#L23-L112); hash-keyed insertion uses conflict handling to reuse an existing payload in [`writeFile.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/writeFile.ts#L307-L318). Tests pin the boundary by writing a file just over one chunk and asserting one 512 KiB chunk plus the remainder ([`writeFile.test.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/writeFile.test.ts)).

“Content-addressed” means that identity follows bytes. Two all-zero chunks of the same length hash to the same identifier. If two files in `project-42` contain the same chunk, their `vfs_chunks` rows can point to one `vfs_blob_bytes` payload. If an edit leaves chunks zero and two unchanged but replaces chunk one, only the replacement payload is new; the next manifest reuses the other two hashes.

This is deduplication, but its scope needs a boundary. The blob tables are inside one Workspace’s database. Thus the useful claim is **per-Workspace deduplication**, or equivalently deduplication within that Durable Object database. There is no cross-Durable-Object object service in this design. If `project-42` and an unrelated `project-99` are owned by different Durable Objects, identical chunks are stored independently. A document that calls the feature “global dedup” can only safely mean “all paths in this VFS consult the same local content-addressed table,” not “one global payload across Cloudflare.” Cloudflare’s storage isolation—each object’s attached storage is private to that object—reinforces this boundary ([Durable Objects overview](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)).

Nor does deduplication collapse namespace entries. If `/a.txt` and `/b.txt` contain identical bytes, both paths still need nodes and directory entries, and synchronization needs an entry for each path. What they share is the payload object and, for identical full content, potentially the manifest. This corrects another loose shorthand in the repository: “exactly one entry” is true of a hashed object in a content store, not of the two path entries that make two files visible.

#### Manifests describe current content

A manifest is a compact, canonical description of a file’s ordered chunks. Conceptually, the file above has a manifest like:

```text
[(hash-0, 524288), (hash-1, 524288), (hash-2, 100)]
```

The actual encoding is canonical JSON, and the manifest itself is hashed. Whole-file, streaming, and some range-aware paths write that current manifest hash into the file’s node row; buffered file-descriptor paths may leave `manifest_hash` null while the ordered `vfs_chunks` rows remain authoritative. The shipped wire does not send a manifest object or manifest hash: a file `ChangeEntry` carries the ordered chunk hashes and sizes directly. On apply, Computer can compute the corresponding manifest identity for equality checks and can stamp a local manifest. The implementation of canonical encoding and SHA-256 manifest identity is in [`manifests.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/sync/manifests.ts); the actual wire shape is in [`changes.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/sync/changes.ts), with encoding and reuse assertions in [`manifests.test.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/sync/manifests.test.ts).

The manifest is not a commit object. It has no parent pointer, author, branch, or retention promise. When populated, `vfs_nodes.manifest_hash` points only to the current content description; a manifest-producing write replaces that pointer, while a buffered path may clear it and leave current `vfs_chunks` as the content map. If an old manifest remains, garbage collection may eventually reclaim it once it is unreachable; callers must not use accidental retention as file history. Git can of course be used *inside* a Workspace, but Git history and VFS revision bookkeeping are different layers.

#### Fixed chunks, not content-defined chunks

Computer’s shipped algorithm uses fixed boundaries at multiples of 512 KiB. It is not content-defined chunking (CDC). With CDC, a rolling fingerprint chooses boundaries based on local content, so inserting bytes near the beginning often leaves later chunk identities aligned. With fixed chunks, inserting one byte at offset zero shifts every later 512 KiB window. A large suffix that is byte-for-byte the same at a different offset may hash as a different set of chunks.

Fixed chunking is straightforward to implement, reason about, and address for positional I/O. It also gives a hard upper bound on each payload. Its trade-off is poorer deduplication for insertions that shift subsequent boundaries. The docs discuss CDC as a possible future optimization, not current behavior; the pinned write path explicitly “re-windows into fixed `CHUNK_SIZE` pieces” ([`writeFile.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/writeFile.ts#L127-L204)). Calling this merely “chunked” hides a material performance property, so the fixed-versus-CDC distinction should remain explicit.

Fixed boundaries do not imply that every API write buffers the entire input. The implementation supports complete byte writes, streamed writes that are re-windowed as data arrives, and positional/range updates that rebuild affected fixed chunks while retaining unaffected chunk rows. A positional edit near the middle therefore need not manufacture a full-file payload object or retransmit untouched chunks. The test suite asserts that a one-range modification stages only the changed chunk in the relevant case ([`writeFile.test.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/writeFile.test.ts)).

At the tool layer, however, “edit” has a simpler semantic shape: it reads the existing file, applies replacements, and writes the complete resulting content. That is an AI-edit behavior, not a limitation of the underlying VFS. The distinction matters when estimating memory and transfer costs: the storage layer can perform streaming and positional operations, while a higher-level tool may choose a full-result write for correctness and simplicity. The tool path is visible in [`packages/computer/src/tools/fs/edit.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/tools/fs/edit.ts).

### Two stores, one authoritative state

We can now draw the architecture that turns those rows into `/workspace`. The most important feature of the diagram is not FUSE. It is the pair of databases.

```text
               Cloudflare Worker / Durable Object
  ┌──────────────────────────────────────────────────────────────┐
  │  Workspace API                                               │
  │      │                                                       │
  │      ▼                                                       │
  │  WorkspaceFilesystem                                        │
  │      │                                                       │
  │      ▼                                                       │
  │  ctx.storage.sql                                             │
  │  ┌────────────────────────────────────────────────────────┐  │
  │  │ AUTHORITATIVE VFS: nodes, dirents, chunks, manifests, │  │
  │  │ bytes, revisions, changes, and per-backend cursors    │  │
  │  └────────────────────────────────────────────────────────┘  │
  └───────────────────────────┬──────────────────────────────────┘
                              │ capnweb sync RPC
                              │ entries + cursors + hashes;
                              │ missing payloads only
                              ▼
                 Container process: computerd
  ┌──────────────────────────────────────────────────────────────┐
  │  node:sqlite DatabaseSync(":memory:")                         │
  │  ┌────────────────────────────────────────────────────────┐  │
  │  │ PROCESS-LIFETIME VFS: same Computer schema/provider,  │  │
  │  │ independently stored local current state              │  │
  │  └───────────────────────────┬────────────────────────────┘  │
  │                              │ FUSE callbacks                 │
  │                              ▼                                │
  │                       /workspace                              │
  │                              │ POSIX-style file operations    │
  │                              ▼                                │
  │                    compiler, shell, native tools              │
  └──────────────────────────────────────────────────────────────┘

  Direct runtimes take a different route:

  just-bash Dynamic Worker ── Workers RPC ──► Workspace.fs ──► authority
  isolate JavaScript ── host filesystem capability ──────────► authority
```

**Figure 1.4 — Container execution uses a synchronized, process-lifetime VFS; Worker shell and isolate JavaScript use the authoritative Workspace directly.**

The lower database is easy to miss because it reuses the same filesystem abstractions. At the pinned commit, `computerd` calls `createNodeVirtualFileSystem()`. That function constructs `SQLiteTestStorage`, wraps it in the same `Database` adapter, runs the same schema initializer, and creates the same provider-facing virtual filesystem. Despite the testing-oriented class name, this is the shipped computerd path. `SQLiteTestStorage` creates Node’s `DatabaseSync(":memory:")`, so the container-side database is in memory and lasts only as long as that `computerd` process ([`fuse/vfs.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse/vfs.ts#L83-L119), [`testing.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/testing.ts#L14-L56)).

This is current implementation, not an architectural requirement that the replica must always be volatile. A future computerd could persist its local database and still fit the two-store design. At this source pin, however, claims about restart behavior must follow `:memory:`: when the process dies, its local VFS, local revisions, and local object cache die with it. The next process rebuilds current state from the Durable Object through synchronization.

The phrase “same filesystem” appears frequently in examples and docs. It is useful only if read as **the same logical namespace after synchronization**. The two sides use the same schema and provider semantics, and they converge on the same paths and bytes. They are not the same SQLite connection, the same transaction domain, or continuously coherent shared memory. A mutation can exist on one side before its next sync boundary. There is no cross-store transaction that commits a Durable Object row and a container row atomically.

The sync channel is carried over the repository’s RPC layer, with capnweb providing the transport-facing capability machinery. Entries describe current files, directories, symlinks, or deletions. File entries name chunk hashes and sizes but do not inline all bytes. Object-probe calls determine which hashes already exist at the receiver, and object-transfer calls carry only missing payloads. The sync interface is defined in [`packages/rpc/src/interface.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src/interface.ts), while the server’s snapshot-bounded fetch and object-presence methods are implemented in [`packages/rpc/src/server.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src/server.ts#L166-L213).

The wire therefore moves four kinds of knowledge:

1. **Current-state entries:** which path should now be a file, directory, symlink, or deletion, with relevant metadata.
2. **Cursors:** how far each side has cleanly processed a snapshot or acknowledged a push.
3. **Ordered chunk references and hashes:** compact identities for the content a file requires. Manifests remain local content descriptions rather than a separate wire payload at this pin.
4. **Missing payloads:** only the content-addressed objects the destination does not already hold.

That is much closer to incremental state replication than to a remote filesystem protocol. A container process does not block each `read(2)` on a Durable Object round trip. It reads the local VFS. Conversely, an API caller does not wait for the container to service a FUSE callback. It reads the authority.

### What FUSE actually exposes

FUSE—Filesystem in Userspace—lets a userspace program implement filesystem operations that the kernel presents to ordinary processes. With real FUSE active, a tool in the container can call `open`, `read`, `write`, `rename`, `stat`, or `readdir` on `/workspace`. The kernel routes those requests to computerd’s FUSE operations. The mount function is given a `NodeVirtualFileSystem`; its callbacks translate the mount-relative path and invoke that local provider. Tests build the operations over a VFS, write through the mounted surface, and then observe the result in that backing VFS; they also verify mount-point path translation ([`fuse/driver.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse/driver.ts#L959-L1022), [`fuse/driver.test.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse/driver.test.ts)).

The route for a read is thus:

```text
process read("/workspace/project-42/NOTES.md")
  → kernel VFS
  → FUSE callback in computerd
  → computerd's local provider
  → computerd's in-memory SQLite VFS
```

There is no `ctx.storage.sql` arrow in that operation. The Durable Object participated earlier, when sync populated the local copy. This is why FUSE can support familiar native tooling without turning every syscall into a wide-area RPC, and also why an unsynchronized API write is not instantly visible to a process that has already begun executing.

#### Real FUSE, automatic selection, and the shim

The single `FUSE_MOUNT` setting selects the exposure backend. In `auto`, the default, computerd probes the environment: on Linux it checks whether `/dev/fuse` is accessible; on macOS it checks for macFUSE. When a real backend is available, computerd mounts through it. An explicit `fuse` or `macfuse` setting is stricter and fails when its required platform support is absent. `none` skips filesystem exposure. The selection logic and its failure messages live in [`fuse/backend.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse/backend.ts#L1-L82), with real/automatic/fallback cases covered in [`backend.test.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse/backend.test.ts).

If real FUSE is unavailable under `auto`, computerd falls back to a userspace shim. The shim mirrors between the local VFS and an ordinary host directory, watches VFS changes, polls/reconciles disk changes, and offers explicit flush/reconcile hooks around requests. It exists so development and restricted environments can still present files to native processes. The implementation labels itself non-production-grade because two independent writers and polling introduce races that kernel-mediated FUSE does not have ([`shim.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/shim/shim.ts#L1-L18)).

Under the shim, there is effectively one more materialization:

```text
Durable Object authority ⇄ computerd SQLite VFS ⇄ ordinary disk directory
                                                     ▲
                                                     └── native process
```

The logical contract remains “the process works under `/workspace` and sync carries accepted current state,” but the mechanism is weaker. Visibility depends on reconciliation boundaries rather than synchronous FUSE callbacks. The shim deliberately takes a last-writer relaxation when disk and VFS writes overlap. A passing local-shim test therefore does not establish the exact syscall semantics or race behavior of a real FUSE deployment. Treat it as a compatibility path, not a transparent reimplementation of the kernel mount.

#### `/workspace` is a convention with a boundary

`computerd` defaults its mount point to `/workspace`, creates that location in its local VFS, and exposes it through the selected backend ([`computerd.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/cli/computerd.ts#L41-L53), [`computerd.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/cli/computerd.ts#L458-L492)). The name is an execution convention, not a statement that the container’s host root has been imported into the Durable Object. In the VFS itself, `/` is the namespace root; `/workspace` is the path chosen for container work. Computer does not automatically turn arbitrary image contents into Workspace files.

This boundary answers a common debugging question: what happens to paths outside `/workspace`? They are container-local. A process may write `/tmp/cache.bin`, `/var/log/tool.log`, or files elsewhere in its image filesystem. Unless an application explicitly copies them under the synchronized mount or returns them as another artifact, they do not become rows in the authoritative VFS. They disappear according to the container’s own lifecycle, not the Durable Object’s. The inverse is also true: only the configured mounted subtree is made visible to the native process through this mechanism.

For `project-42`, a robust command therefore makes its workspace dependency explicit:

```text
cd /workspace/project-42 && npm test
```

It should not assume that the process starts in the project directory, that `/root/project-42` is synchronized, or that an installer’s cache under `/tmp` will be durable.

### The complete file trace

Now follow one file all the way through the system. Assume an API-facing Worker has obtained the Workspace for `project-42`, the authoritative tree already contains `/workspace/project-42`, and a container backend is available. The agent writes `src/index.ts`, runs a formatter in the container, and then reads the formatted result through the Workspace API.

1. **The API write lands in the authoritative Workspace.** The caller invokes `workspace.fs.writeFile("/workspace/project-42/src/index.ts", bytes)`. Path resolution, inode/chunk updates, and byte staging execute against the `Database` that wraps the Durable Object’s `ctx.storage.sql`. No container is needed for this step. The `Workspace.fs` surface is constructed directly over that database, as shown in [`workspace.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/workspace.ts#L298-L300).

2. **The mutation acquires a revision and content identities.** Computer windows the result into fixed chunks of at most 512 KiB, hashes them with SHA-256, reuses already-present objects, writes the current ordered chunk rows, builds a content-addressed manifest, and updates the node’s current `manifest_hash`, size, metadata, and logical revision. The live namespace is now authoritative. When sync coalesces changes, this path is eligible to become a current-state file entry carrying metadata and chunk references. Repeated pre-sync rewrites may collapse into that one current entry; they do not require a historical event per write.

3. **Before container execution, the Durable Object pushes changes the backend has not acknowledged.** The shell executor calls the Workspace sync hook before invoking remote `exec`. `Workspace.push()` serializes per-backend mutation work and asks the sync driver to send entries after that backend’s watermark. The pre-exec push is visible in [`shell.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/shell.ts#L108-L126); the Workspace routes it to `pushOnce` in [`workspace.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/workspace.ts#L545-L567).

4. **Sender and receiver negotiate objects by hash.** File entries identify the required chunk hashes and sizes. The push driver calls the receiver’s object-presence probe, computes which hashes are missing, and streams only those bytes before sending the current-state entries. Existing objects are not resent merely because another path references them. The push sequence—coalesce, `hasObjects`, `pushObjects`, then `push`—is implemented in [`sync-driver.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src/sync-driver.ts#L290-L348).

5. **Computerd applies the entry to its local SQLite VFS.** The RPC server on the container side accepts the objects and applies file/directory/delete entries through the same database/provider model, but its `Database` wraps `DatabaseSync(":memory:")`, not the Durable Object’s storage. The local node now points to a local manifest and local chunk objects containing the required bytes. The received push is transactionally applied on that server before it reports its accepted cursor ([`server.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src/server.ts)).

6. **The process reads `/workspace` through FUSE.** Once the push completes, computerd starts the requested command. `open("/workspace/project-42/src/index.ts")` and subsequent reads pass through the kernel’s FUSE route into computerd’s local provider. They do not query the Durable Object. The bytes are already present in the process-lifetime local VFS.

7. **The formatter’s write creates a local revision.** The formatter may open the file, perform positional writes, truncate, rename a temporary file over the original, or use another ordinary filesystem sequence. FUSE callbacks translate those operations to the local VFS. When the operation is committed through that provider—potentially at flush/release depending on the syscall pattern—the local database gets new chunk hashes, an updated ordered chunk map, and a new local revision. A buffered descriptor write may temporarily leave the optional node `manifest_hash` null; synchronization can still materialize the file from `vfs_chunks`. At this moment the container sees the result, but the authoritative Workspace may still hold the pre-format content.

8. **After the command’s output stream drains, the Durable Object fetches container changes in bounded batches.** Computer deliberately attaches the post-exec pull to event-stream completion. This prevents the orchestration layer from declaring the filesystem synchronized while stdout/stderr events or process cleanup are still in flight. `withPostPull` runs after the stream reaches its end ([`shell.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/shell.ts#L145-L162), [`shell.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/shell.ts#L187-L247)). The pull driver reads at most 256 entries per batch so working memory is bounded ([`sync-driver.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src/sync-driver.ts#L47-L64)).

9. **Accepted current state lands durably, then the fetch cursor advances.** The Durable Object side receives a snapshot-bounded stream of entries, probes both stores for required hashes, fetches missing payloads, and applies the entries through transactional VFS mutations. After clean processing it records the container fetch cursor. The exact implementation is careful but not magical: on the pull path, individual filesystem applies use transactions and the driver advances its cursor after the processed batch/snapshot; this is not a distributed transaction spanning both SQLite databases. A retry may repeat bounded work, and content identities plus current-state application make that safe. The object negotiation and cursor write appear in [`sync-driver.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src/sync-driver.ts#L178-L270).

10. **A computerd restart discards and rebuilds the local copy.** Because the lower VFS is `:memory:`, restarting computerd loses its local rows and cached payloads. Reconnection reconciles watermarks so a fresh or shorter local history is not mistaken for an up-to-date peer, resets inconsistent progress when required, and re-baselines from the authority. An initial pull populates the new VFS before it is used, and subsequent sync ticks continue convergence ([`fuse/vfs.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse/vfs.ts#L85-L133), [`sync-driver.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src/sync-driver.ts#L380-L409)). No correctness claim depends on recovering the dead process’s RAM. Only changes that reached the Durable Object before the loss are authoritative.

After step nine, `workspace.fs.readFile(...)` returns the formatted content. Between steps seven and nine, the container and Durable Object intentionally held different current states. That interval is not a bug in the architecture; it is the cost and semantics of using a synchronized execution representation.

### Incremental convergence, not coherent shared storage

The trace gives us a more useful consistency statement than “files sync both ways.” For one connected backend, Computer exchanges a snapshot-bounded stream of current-state entries. Cursors let it resume, hashes let it omit known payloads, and transactional local mutations prevent half-formed file structures inside one database. Pre-exec push and post-drain pull place strong, understandable convergence boundaries around the common command workflow.

What the design does **not** provide is equally important:

- It is not NFS, SMB, or another coherent remote filesystem protocol. A read on one side does not necessarily observe a write that has only committed on the other side.
- It is not one SQLite database opened from two processes. Each store has its own connection, revisions, transaction log, and failure boundary.
- It is not a distributed transaction. There is no atomic commit that covers a row in `ctx.storage.sql`, a row in computerd’s `:memory:` database, and a native process write.
- It is not an append-only event archive. Coalescing sends the latest materialized state per path plus required tombstones, not every intermediate write.
- It is not a multi-writer merge system. It converges current paths; it does not understand TypeScript syntax, preserve both versions, or produce conflict markers.

The server opens a fetch against a `currentCursor` captured for that exchange, and the driver drains only through that boundary. Writes after the snapshot opens belong to a later exchange. This avoids chasing a moving tail forever and gives the cursor a concrete meaning: every selected current-state entry through the captured `(revision, path)` boundary has been offered and cleanly processed. It still is not a point-in-time file-history snapshot because coalescing reads current live state and because prior versions are not retained. The snapshot and coalescing behavior are implemented in [`server.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src/server.ts#L166-L202) and [`coalesce.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/sync/coalesce.ts).

The protocol also checks cross-side progress. If a newly connected process reports a history shorter than a stored cursor—exactly what can happen when `computerd` restarts with an empty in-memory database—the driver does not trust the stale watermark and skip the tree. It resets and retries from the baseline. Tests explicitly construct fresh local databases and assert reconciliation and batched cursor advancement in [`sync-driver.test.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src/sync-driver.test.ts). This is a recovery protocol for replicated current state, not recovery of the dead replica itself.

While computerd remains alive, it also drives a periodic sync tick; at the pin the interval is 250 ms ([`fuse/vfs.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src/fuse/vfs.ts#L83-L133)). That improves eventual visibility for work that occurs outside a single shell bracket. It should not be used as a correctness timer—“sleep 300 ms and hope” is not a durable boundary. The explicit Workspace `push()` and `pull()` operations, plus the shell executor’s push/exec/drain/pull bracket, are the semantic tools. The polling interval is an implementation detail that can change.

### Direct runtimes do not take the container route

The second half of Figure 1.4 is as important as the first. Computer supports execution backends whose code can be given a host filesystem capability. Those backends do not need a native mount, so creating a second VFS would add latency and consistency work without adding compatibility.

| Runtime | Filesystem path | Second SQLite VFS? | FUSE? | Push/pull? | Main trade-off |
| --- | --- | --- | --- | --- | --- |
| Container / computerd | Native syscall → `/workspace` → FUSE or shim → local provider → sync → authority | Yes, `node:sqlite :memory:` at this pin | Real when available; shim fallback | Yes | Broad native-tool compatibility with synchronization boundaries |
| Worker shell / just-bash | Dynamic Worker → Workers RPC → `WorkspaceFsAdapter` → authoritative `Workspace.fs` | No | No | No; backend declares `sync: "none"` | Direct durable visibility, but a JavaScript shell rather than arbitrary native binaries |
| Isolate JavaScript | Isolate’s host filesystem capability / Node-style fs shim → authoritative `Workspace.fs` | No | No | No | Direct capability access for JavaScript, not the container’s local disk semantics |

#### just-bash: a shell over the authority

The Worker-shell backend runs just-bash in a Dynamic Worker. That worker obtains the host Workspace through Workers RPC and wraps the remote `.fs` surface in `WorkspaceFsAdapter`. A shell command such as `cat /workspace/project-42/NOTES.md` is interpreted by just-bash, whose filesystem operations delegate through the adapter to the authoritative Workspace. There is one durable filesystem state in this path, so `WorkerShellBackend` returns synchronization mode `"none"` ([`worker-shell.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/backends/worker-shell/worker-shell.ts#L190-L207)). The end-to-end example describes the Dynamic Worker constructing `WorkspaceFsAdapter` from `env.HOST.getWorkspace()` and identifies the single authoritative filesystem ([`examples/worker-shell/README.md`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/examples/worker-shell/README.md#L38-L61)).

“Shell” can mislead here. just-bash provides shell syntax and a JavaScript implementation of commands; it does not make ELF binaries, system packages, or the image’s native toolchain appear. Its advantage for this chapter is architectural: reads and writes are already on the authoritative side. When the shell writes the formatted `src/index.ts`, a subsequent `Workspace.fs.readFile` does not wait for FUSE or a post-exec pull because there is no replica to reconcile.

#### Isolate JavaScript: Node-shaped calls over a host capability

The isolate JavaScript backend follows the same direct principle through a different adapter. When the backend connects, it creates `WorkspaceRuntimeCapability` with the host’s filesystem object. That capability implements file operations by calling the supplied filesystem; the backend wires `this.#host.fs` into it in [`worker-javascript.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/backends/worker-javascript/worker-javascript.ts#L323-L337), and the delegating methods live in [`runtime/capability.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/runtime/capability.ts).

JavaScript running in the isolate can see `node:fs`-shaped APIs through runtime shims, but “Node-style” does not mean “the Node host’s disk” or a general Node environment. The shim translates calls to the granted Workspace capability. It is a security and portability boundary: code receives the filesystem operations Computer chose to expose, and those operations reach the authority. There is no `/dev/fuse`, no computerd `:memory:` database, and no container filesystem outside `/workspace` lurking behind those calls.

This gives a practical backend-selection rule. Choose a direct runtime when its language/tool surface can express the task, because it avoids replicated-state boundaries. Choose a container when the task truly needs native binaries, an OS package, a compiler toolchain, or behavior that expects POSIX-style files. The filesystem abstraction is common at the product level, but the data path is runtime-specific.

### Edge conditions that shape the design

Part II will examine synchronization and operational policy in depth. Four issues are worth naming now because they prevent false conclusions from the architecture diagram.

#### Conflicts: convergence is not intent preservation

Inside one active Durable Object, direct Workspace mutations are serialized by the object’s execution and storage model, and Workspace queues per-backend sync mutations. Across independent container copies, however, two writers can modify the same path without seeing each other first. Each has its own revision space; there is no universal revision clock to decide whose human intent should win.

The shipped policy is current-state, last-applied convergence. Applying an upstream entry performs structural cleanup when necessary—for example, replacing a directory with a file cannot leave impossible children beneath that path—and then installs the incoming state. A later accepted state can overwrite an earlier one without a conflict artifact or merge prompt. The structural behavior is explicit in [`apply.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/sync/apply.ts#L90-L140), and the design’s conflict account is in [`docs/02_sync_protocol.md`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/02_sync_protocol.md#conflicts).

Applications that care about preserving both edits must impose a higher-level policy: serialize agent turns, allocate independent branches or paths, call `pull()` before beginning a turn, or use Git-aware merge workflows. A VFS cursor tells us what state crossed a boundary; it cannot infer whether two edits were semantically compatible.

#### Ignored paths: useful locally can mean absent durably

Container-to-authority fetch can exclude path segments. At the pin, the default ignore list is `['node_modules']`, matched as a whole path segment rather than as a substring ([`ignore.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/sync/ignore.ts#L1-L22)). This prevents a dependency installation performed in the container from filling the authoritative VFS with a large derived tree and consuming sync bandwidth.

Ignored does not mean unavailable to the running container. A compiler can use the local `/workspace/project-42/node_modules` tree. It means the ignored entries do not appear in the synchronized current-state stream and are therefore invisible to authoritative `Workspace.fs`. After computerd restarts, they must be regenerated unless another persistence mechanism exists. Derived caches are good candidates; source files and irreplaceable outputs are not. Customizing the ignore list replaces the default behavior, so callers should explicitly retain `node_modules` if they still intend to ignore it. The pinned protocol document records both the default and the invisibility consequence in [`docs/02_sync_protocol.md`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/02_sync_protocol.md#ignored-entries).

#### Garbage collection: content addressing does not collect content

Replacing a file updates its current chunk map and manifest pointer, but old manifests and blobs may become unreachable. Hashing prevents duplicate storage; it does not discover liveness or delete unreachable objects. Computer includes an internal reachability-based `gc()` that preserves currently referenced objects and uses safety timing around recently staged material. It is intentionally not exposed as a public `Workspace.gc()` operation at this pin ([`gc.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src/fs/gc.ts), [`docs/03_filesystem_schema.md`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/03_filesystem_schema.md#garbage-collection)).

That policy interacts with the absence of history. An orphan may remain readable at the SQL level for a while, but it has no supported path from the filesystem and may be reclaimed. Durability promises attach to reachable authoritative state, not to every digest ever produced.

#### Performance: optimize the crossings that actually exist

The architecture gives us the relevant cost centers without pretending to settle their magnitude. A direct runtime pays capability/RPC and SQL/provider costs but no replica sync. A container pays for current-state enumeration, hash negotiation, missing-object transfer, local apply, and FUSE or shim operations. Fixed chunks make small in-place changes cheap when they touch few windows, but insertions that shift boundaries can create many new hashes. The 256-entry pull batch bounds working memory; it does not bound total transfer for a large tree. Ignoring regenerable directories can remove far more work than micro-optimizing a single SQL statement.

Repository performance notes contain measurements and target ideas, but benchmark numbers depend on runtime version, workload, FUSE availability, object placement, and the rapidly changing preview implementation. They should be treated as evidence for a measured configuration, not timeless product guarantees ([`docs/19_performance.md`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/19_performance.md)). Part II will turn these mechanisms into explicit analyses of batching, backpressure, retries, conflict policy, garbage collection, and workload-shaped optimization.

### Reading repository shorthand precisely

The Computer repository is a fast-moving preview, and its documentation says as much in [`docs/README.md`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/README.md). Compact phrases are useful in a README; a system design needs their scope expanded.

| Shorthand | Precise reading at commit `76d9e75` |
| --- | --- |
| “The same filesystem is mounted in the container.” | The container exposes a second VFS with the same schema/provider semantics and synchronizes its logical current state with the authoritative Workspace. |
| “FUSE mounts the Durable Object.” | FUSE mounts computerd’s process-local VFS. Sync, not FUSE, communicates with the Durable Object. |
| “Changes are immediately visible both ways.” | Local changes are immediate within one store; cross-store visibility follows periodic or explicit push/pull boundaries, especially pre-exec push and post-drain pull. |
| “Global deduplication.” | Hash payloads are shared by paths inside one Workspace database. There is no cross-Durable-Object global blob pool. |
| “One entry for identical content.” | One content-addressed object or manifest may be reused; distinct visible paths still require distinct namespace/current-state entries. |
| “Revision history.” | Revisions order current-state synchronization. The VFS does not retain a supported sequence of prior file contents. |
| “`/workspace` is persistent.” | The authoritative subtree represented by Workspace state is durable. Container-local paths, ignored entries, and unsynchronized writes are not covered. |
| “Mounts are planned.” | The full design is planned; a limited eager implementation and `_vfs_mounts` table already ship at this pin. |

These translations are not pedantry. Each one predicts a different failure mode. Mistaking a replica for a mount produces stale-read bugs. Mistaking local dedup for global dedup produces capacity errors. Mistaking cursors for history produces unrecoverable “rollback” features. Mistaking the shim for real FUSE hides races that appear only under concurrent writes.

### The point

Our `project-42` file began as SQL-backed authoritative state. Computer represented its current content as fixed, SHA-256-addressed chunks and a manifest inside the Durable Object’s private database. For native execution, Computer copied the necessary current-state entries and missing objects over capnweb RPC into a second, process-lifetime SQLite VFS. FUSE exposed that copy at `/workspace`. The formatter changed the copy; after its output stream drained, sync carried the accepted state back to the authority. If computerd disappeared, the lower copy could be rebuilt because it was never the durable source of truth.

just-bash and isolate JavaScript remove the middle copy. They receive filesystem capabilities that lead to `Workspace.fs`, so they neither mount FUSE nor run push/pull. That is not a separate filesystem model; it is the direct branch of the same invariant: execution either reaches the authority or uses a synchronized representation.

Once this distinction is fixed, the system becomes easier to reason about. Durable Objects provide the durable, transactional home. Computer defines what files mean inside that home. Content addressing reduces repeated payload work within one Workspace. Cursors and current-state entries make a volatile execution copy reconstructible. FUSE provides native compatibility without pretending that remote SQL is a local disk.

Chapter 5 measures the seam this chapter has exposed: the interval in which two valid current states differ. It asks where bytes accumulate, where time is spent, which costs come from fixed chunks, which come from FUSE, and which come from synchronization. Part II can then open the implementation with those costs already visible.

### Sources

Research and verification were performed on 2026-08-06 against Cloudflare Computer commit [`76d9e75c5688713b656bce85540d9e0071cece8b`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b). Cloudflare platform behavior was checked against the current [Durable Objects overview](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/), [SQLite-backed storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), and [storage-access guidance](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/).

The complete repository design set was inspected: [`docs/README.md`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/README.md); [`01_vfs`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/01_vfs.md), [`02_sync_protocol`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/02_sync_protocol.md), [`03_filesystem_schema`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/03_filesystem_schema.md), [`04_filesystem_interface`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/04_filesystem_interface.md), [`05_runtime_interface`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/05_runtime_interface.md), [`06_mount_interface`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/06_mount_interface.md), [`07_injected_service`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/07_injected_service.md), [`08_capnweb_interface`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/08_capnweb_interface.md), [`09_tool_interface`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/09_tool_interface.md), and [`10_project_layout`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/10_project_layout.md).

The remaining design documents were also inspected: [`11_lifecycle`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/11_lifecycle.md), [`12_worker_backend`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/12_worker_backend.md), [`13_git_interface`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/13_git_interface.md), [`14_assets_interface`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/14_assets_interface.md), [`15_artifacts_interface`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/15_artifacts_interface.md), [`16_code_execution`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/16_code_execution.md), [`17_isolate_javascript`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/17_isolate_javascript.md), [`18_runtime_migration`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/18_runtime_migration.md), and [`19_performance`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/docs/19_performance.md).

Shipped claims were checked against the pinned Workspace constructor and runtime orchestration in [`workspace.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/workspace.ts) and [`shell.ts`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/shell.ts); storage, schema, write, manifest, coalescing, apply, ignore, and garbage-collection code under [`packages/dofs/src`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src); sync transport and driver code under [`packages/rpc/src`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src); and computerd’s VFS, FUSE, shim, and CLI under [`packages/computerd/src`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src). Corresponding pinned tests in those directories were used to verify chunk boundaries, per-Workspace reuse, manifest behavior, current-state coalescing, cursor/batch recovery, local VFS application, mount translation, FUSE selection, and shim reconciliation.

---

## Chapter 5 — Measuring the Durable Workspace

> Evidence scope: one local end-to-end measurement of the open-source
> Cloudflare Computer implementation at commit
> [`76d9e75`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b).
> These numbers are not measurements of Cloudflare's production network,
> placement, billing, or Container lifecycle.

The previous chapter established how a file moves from authoritative Durable
Object SQLite, through synchronization, into a container-side VFS, through
FUSE, and back. That architecture gives a coding agent something a temporary
container cannot provide by itself: a workspace that survives the machine
running the command.

Durability is not free. The important question is not whether Computer beats
a local filesystem. It did not in this run, and matching local disk is not the
system's purpose. The useful question is what the durable design buys, where
it spends storage, and where it spends time.

This chapter gives a compact answer:

> Exact content reuse and batched edits are Computer's storage strengths.
> Fixed chunk boundaries, delayed reclamation, FUSE metadata crossings, and
> synchronization are its principal costs.

### Proof that the benchmark uses Computer

Before reading any number, we need to know what was measured. A benchmark
that writes to a hand-built SQLite schema or a host directory cannot support
claims about Computer's complete path.

The following file is the smallest proof used by the harness. It is exactly
48 physical lines. The benchmark imports the official Computer packages,
constructs `Workspace` over the Durable Object's `state.storage`, connects an
official RPC client to a local `computerd`, and invokes the public
`Workspace.runtime.exec()` method.

```ts
import { DurableObject } from "cloudflare:workers";
import type { DurableObjectStorageLike } from "@cloudflare/dofs";
import {
  type BackendHandle,
  Workspace,
  type WorkspaceBackend,
} from "@cloudflare/computer";
import { createWorkspaceClient } from "@cloudflare/computer-rpc/client";
interface Env {
  COMPUTERD_URL: string;
}

class LocalComputerdBackend implements WorkspaceBackend {
  readonly id = "local-computerd";
  readonly type = "local-computerd";

  constructor(private readonly url: string) {}

  async connect(): Promise<BackendHandle> {
    const client = createWorkspaceClient({ url: this.url });
    return {
      rpc: client,
      sync: "remote",
      close: () => client.close(),
    };
  }
}

export class ComputerIn48Lines extends DurableObject<Env> {
  readonly #workspace: Workspace;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.#workspace = new Workspace({
      storage: state.storage as unknown as DurableObjectStorageLike,
      backends: [new LocalComputerdBackend(env.COMPUTERD_URL)],
    });
  }

  override async fetch(): Promise<Response> {
    using run = await this.#workspace.runtime.exec(
      "LC_ALL=C ls -lR --time-style=+%s . >/dev/null",
      { backend: "local-computerd", encoding: "utf8" },
    );
    const result = await run.result();
    return Response.json(result);
  }
}
```

The local backend is a small adapter, not a replacement filesystem. It swaps
Computer's production Container startup and reverse connection for a direct
WebSocket to an already-running local `computerd`. Storage, VFS operations,
chunking, synchronization, FUSE, and command execution remain the pinned
Computer implementation. No upstream Computer source file was changed.

This is evidence of **implementation authenticity**, not user authentication.
The run used local workerd, so the listing does not prove a Cloudflare account,
credential, or production deployment was authenticated.

The measured path was:

```text
Durable Object Workspace + SQLite authority
                 │
                 │ pre-command push
                 ▼
       computerd process-local SQLite VFS
                 │
                 │ FUSE projection
                 ▼
          Bash command in /workspace
                 │
                 │ post-command pull and apply
                 ▼
Durable Object Workspace + SQLite verification
```

The full source is preserved as
[`computer-in-48-lines.ts`](../benchmarks/storage/local-pipeline/computer-in-48-lines.ts).

### What the benchmark measures

The corpus contains 6,385 files totaling 274.781 MiB. It combines many small
files with larger sequential files so that metadata operations, content reads,
deduplication, and large-file edits all appear in the same workspace.

The baseline runs the same Bash operations on the native WSL2 filesystem. The
Computer path uses local workerd Durable Object SQLite, the official Workspace
and sync implementations, `computerd`, and a real FUSE mount. The tables keep
two Computer timing boundaries separate:

- **FUSE command** is the time spent by Bash against the mounted workspace.
- **Durable exec** includes `Workspace.runtime.exec()`, its push and pull, and
  command execution, but excludes the final independent verification query.

The results describe this pinned local setup. They establish implementation
behavior and bottlenecks; they do not predict production latency.

### Storage: reuse is excellent, mutation can be expensive

Storage is the more important result because it reveals what accumulates after
the command has finished. `Computer DB` is the size reported by Durable Object
SQLite. `Unique blob` counts hash-addressed payload bytes. `Orphan` counts blob
bytes that are no longer reachable from the current filesystem tree.

| Workspace state | Logical MiB | Computer DB MiB | Unique blob MiB | Orphan MiB |
| --- | ---: | ---: | ---: | ---: |
| Initial unique tree | 274.781 | 282.023 | 274.781 | 0.000 |
| Exact duplicate tree | 549.563 | 283.750 | 274.781 | 0.000 |
| One 10-byte overwrite | 549.563 | 284.250 | 275.281 | 0.000 |
| Five separately synchronized edits | 549.563 | 286.758 | 277.781 | 2.000 |
| Five more edits in one synchronization | 549.563 | 287.258 | 278.281 | 2.000 |
| Prepend 10 bytes to a 32 MiB file | 549.563 | 319.309 | 310.281 | 2.000 |
| Delete every file | 0.000 | 318.785 | 310.281 | 310.281 |

#### Strength: exact deduplication works

Duplicating the complete 274.781 MiB tree doubled the logical file content but
did not add another copy of its payload. Unique blob storage remained 274.781
MiB, while the database grew by only 1.727 MiB for the second namespace and
metadata. This is the design at its best: repeated immutable content is cheap
inside one Workspace database.

The qualification matters. Deduplication is exact and local to one Workspace.
It is not content-defined chunking, and it is not a global blob pool shared by
unrelated Durable Objects.

#### Weakness: a tiny edit can replace a large fixed chunk

Computer divides file data into fixed chunks of at most 512 KiB. Small files
are stored at their actual length; 512 KiB is not a minimum allocation. But a
10-byte in-place overwrite inside a full chunk produced one new 512 KiB blob:
52,428.8 times the changed payload.

Synchronization boundaries also matter. Five 10-byte edits synchronized
separately produced 2.5 MiB of new unique payload. Five edits made within one
command and synchronized once produced only one new 512 KiB chunk. Coalescing
therefore turns batching into a real storage optimization, not merely a speed
optimization.

The worst case is a boundary-shifting edit. Prepending 10 bytes to a 32 MiB
file changed the alignment of every following fixed chunk and created about 32
MiB of new payload. By contrast, appending 10 bytes to the aligned end of a
1 MiB file added exactly 10 payload bytes.

#### Weakness: deletion does not mean immediate reclamation

After every file was deleted, the logical workspace was empty, but the
database still occupied 318.785 MiB and 310.281 MiB of blob payload was
orphaned. At the pinned commit, Computer contains internal garbage-collection
machinery and a safety window, but exposes no public `Workspace.gc()` method
for this benchmark to force reclamation. Applications must not assume that
unlink immediately reduces physical or billed storage.

The storage lesson is simple: Computer is favorable for repeated immutable
content and batched changes. It is unfavorable for frequently rewritten large
files, boundary-shifting edits, and workloads that require immediate space
reclamation.

### Speed: local disk wins, but the location of the cost is clear

| Operation | Native ms | FUSE command ms | Durable exec ms | Durable/native |
| --- | ---: | ---: | ---: | ---: |
| Recursive `ls -lR` | 921.322 | 14,360.184 | 14,491 | 15.73× |
| Read all file content | 197.986 | 7,041.529 | 7,069 | 35.70× |
| Overwrite 10 bytes once | 8.511 | 14.702 | 167 | 19.62× |
| Five edits, five synchronizations | 38.619 | 73.157 | 473 | 12.25× |
| Five edits, one synchronization | 23.390 | 53.617 | 126 | 5.39× |
| Append 10 bytes | 3.618 | 8.014 | 56 | 15.48× |
| Prepend 10 bytes to 32 MiB | 51.126 | 204.673 | 1,596 | 31.22× |

#### Strength: ordinary writes inside FUSE are not the main problem

The 10-byte overwrite took 14.702 ms inside the mounted filesystem versus
8.511 ms natively, a 1.73× command-level difference. Five edits grouped into
one execution completed the full durable path in 126 ms, compared with 473 ms
when each edit crossed its own synchronization boundary. Computer benefits
substantially when a tool performs related work in one command.

#### Weakness: metadata-heavy traversal crosses FUSE repeatedly

Recursive `ls` and full-tree reads spent almost all of their time inside the
FUSE command. Each directory listing, `stat`, open, read, and close crosses the
kernel FUSE boundary into `computerd`'s JavaScript and SQLite VFS. This explains
why `ls` was 15.59× slower at the command boundary and why adding durable sync
changed 14,360 ms to only 14,491 ms. Synchronization was not the main cost for
that operation.

#### Weakness: changed chunks make synchronization visible

For the 32 MiB prepend, the FUSE command itself took 205 ms, but the complete
durable execution took 1,596 ms. Most of the additional time came from pulling
and applying roughly 32 MiB of newly shifted chunks. Here the storage weakness
and the speed weakness are the same event.

One implementation limit also affected the bulk setup. Sending all newly
written hashes in one synchronization exceeded local SQLite's SQL-variable
limit because the pinned Computer batching constants were too large for this
workerd configuration. The final harness kept the upstream implementation
unchanged and opened multiple runtime brackets, each with at most 40 new
hashes. This workaround makes the bulk-create timing useful for diagnosis, but
not a clean headline for normal command latency.

### Strengths and weaknesses

| Strength | Weakness |
| --- | --- |
| Exact hash-based reuse made a second 274.781 MiB tree add no duplicate payload. | A 10-byte overwrite can create a new 512 KiB chunk. |
| One synchronization coalesced five edits into one new chunk. | A small prepend can shift every fixed boundary in a large file. |
| The Durable Object remains authoritative while the FUSE copy is disposable and reconstructible. | Deletes leave unreachable payloads until garbage collection can reclaim them. |
| Native tools can operate on `/workspace` without being rewritten for a storage API. | Metadata-heavy native tools pay repeated FUSE-to-JavaScript-to-SQLite crossings. |
| Push and pull make the durability boundary explicit and measurable. | Small commands can spend more time synchronizing than executing. |

The right conclusion is neither “Computer is slow” nor “deduplication makes
storage free.” Computer purchases persistence, coordination, exact reuse, and
native-tool compatibility with extra layers. It is a good fit when a durable
workspace is more valuable than local-disk latency, especially when content is
reused and mutations can be batched. It needs care when large files are edited
near the front, directories contain thousands of tiny entries, or storage must
shrink immediately after deletion.

Part I began with a logical project name and ended with a measured durable
workspace. Part II can now open the implementation and ask how each of these
costs follows from construction, filesystem operations, synchronization, and
garbage collection.

### Sources and reproducibility

The complete method, timing boundaries, caveats, and interpretation are in the
[`benchmark document`](../benchmarks/storage/BENCHMARK.md). The compact
[`result table`](../benchmarks/storage/results/medium-summary.md) and
[`raw result`](../benchmarks/storage/results/raw/local-medium-d64d142688d0.json)
preserve the reported values. The runnable harness is under
[`benchmarks/storage`](../benchmarks/storage/).

Implementation claims were checked against the pinned Computer
[`Workspace`](https://github.com/cloudflare/computer/blob/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computer/src/workspace.ts),
[`computerd`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b/packages/computerd/src),
[`dofs`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b/packages/dofs/src),
and [`rpc`](https://github.com/cloudflare/computer/tree/76d9e75c5688713b656bce85540d9e0071cece8b/packages/rpc/src)
packages.
