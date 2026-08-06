# Chapter 1 — The Object That Owns State

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

## Give the project an address

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

## Class, namespace, object

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

## Names become IDs; IDs become stubs

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

## Follow one request to its owner

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

## A stub is a route, not a running process

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

## Initial placement is not identity

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

## Choose the atom of coordination

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

## Scale by adding owners, not by heating one

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

## Keep the nouns separate

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

## Sources

- Cloudflare, [What are Durable Objects?](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
- Cloudflare, [Durable Object Namespace](https://developers.cloudflare.com/durable-objects/api/namespace/), [ID](https://developers.cloudflare.com/durable-objects/api/id/), and [Stub](https://developers.cloudflare.com/durable-objects/api/stub/) references
- Cloudflare, [Invoke methods](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/) and [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- Cloudflare, [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- Cloudflare, [Data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- Cloudflare, [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
