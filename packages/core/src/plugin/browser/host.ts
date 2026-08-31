export * as BrowserHost from "./host.js"

import { Browser } from "@opencode-ai/schema/browser"
import type { Session } from "@opencode-ai/schema/session"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { Context, Deferred, Effect, Layer, Schema, Scope } from "effect"

export class RequestError extends Schema.TaggedError<RequestError>()("Browser.RequestError", {
  code: Browser.ErrorCode,
  message: Schema.String,
}) {}

export interface Peer {
  readonly open: Effect.Effect<void, RequestError>
  readonly request: (command: Browser.Command) => Effect.Effect<Browser.Result, RequestError>
}

export interface Controller {
  readonly closed: Effect.Effect<void>
  readonly attach: (state: Browser.State) => Effect.Effect<void>
  readonly state: (state: Browser.State) => Effect.Effect<void>
  readonly detach: Effect.Effect<void>
}

type Attachment = { state: Browser.State; closed: Deferred.Deferred<void> }
type Registration = {
  peer: Peer
  ready: Deferred.Deferred<void>
  closed: Deferred.Deferred<void>
  attachment?: Attachment
}
type Capability =
  | { type: "available"; open: Peer["open"] }
  | { type: "attached"; state: Browser.State; request: Peer["request"] }

export class Service extends Context.Service<
  Service,
  {
    readonly activate: Effect.Effect<void, never, Scope.Scope>
    readonly register: (id: Session.ID, peer: Peer) => Effect.Effect<Controller, RequestError, Scope.Scope>
    readonly release: (id: Session.ID) => Effect.Effect<void>
    readonly get: (id: Session.ID) => Effect.Effect<Capability | undefined>
  }
>()("@opencode/BrowserHost") {}
export type Interface = Context.Service.Shape<typeof Service>

export const layer = Layer.sync(Service, () => {
  let active = false
  const registrations = new Map<Session.ID, Registration>()
  const unavailable = () => new RequestError({ code: "not_attached", message: "Browser is not attached." })
  const detach = (entry: Registration) =>
    Effect.gen(function* () {
      if (entry.attachment) yield* Deferred.succeed(entry.attachment.closed, undefined)
      entry.attachment = undefined
      entry.ready = Deferred.makeUnsafe<void>()
    })
  const release = (id: Session.ID) =>
    Effect.gen(function* () {
      const entry = registrations.get(id)
      if (!entry) return
      registrations.delete(id)
      yield* detach(entry)
      yield* Deferred.succeed(entry.closed, undefined)
    })
  return Service.of({
    activate: Effect.acquireRelease(
      Effect.sync(() => {
        active = true
      }),
      () =>
        Effect.gen(function* () {
          active = false
          yield* Effect.forEach(registrations.keys(), release, { discard: true })
        }),
    ),
    release,
    register: Effect.fn("Browser.register")(function* (id, peer) {
      if (!active || registrations.has(id)) return yield* unavailable()
      const entry: Registration = { peer, ready: yield* Deferred.make<void>(), closed: yield* Deferred.make<void>() }
      yield* Effect.acquireRelease(
        Effect.sync(() => registrations.set(id, entry)),
        () => (registrations.get(id) === entry ? release(id) : Effect.void),
      )
      return {
        closed: Deferred.await(entry.closed),
        attach: (state) =>
          Effect.gen(function* () {
            if (entry.attachment) yield* detach(entry)
            entry.attachment = { state, closed: yield* Deferred.make<void>() }
            yield* Deferred.succeed(entry.ready, undefined)
          }),
        state: (state) =>
          Effect.sync(() => {
            if (entry.attachment) entry.attachment.state = state
          }),
        detach: detach(entry),
      }
    }),
    get: (id) =>
      Effect.sync(() => {
        const entry = registrations.get(id)
        if (!entry) return
        const attachment = entry.attachment
        if (!attachment)
          return {
            type: "available" as const,
            open: entry.peer.open.pipe(
              Effect.andThen(Effect.suspend(() => Deferred.await(entry.ready))),
              Effect.raceFirst(Deferred.await(entry.closed).pipe(Effect.andThen(unavailable()))),
              Effect.timeoutOrElse({ duration: "15 seconds", orElse: unavailable }),
            ),
          }
        return {
          type: "attached" as const,
          state: attachment.state,
          request: (command: Browser.Command) =>
            Effect.suspend(() => {
              if (entry.attachment !== attachment) return unavailable()
              return entry.peer
                .request(command)
                .pipe(Effect.raceFirst(Deferred.await(attachment.closed).pipe(Effect.andThen(unavailable()))))
            }),
        }
      }),
  })
})

export const node = makeLocationNode({ service: Service, layer, deps: [] })
