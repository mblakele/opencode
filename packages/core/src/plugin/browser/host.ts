export * as BrowserHost from "./host.js"

import { Browser } from "@opencode-ai/schema/browser"
import type { Session } from "@opencode-ai/schema/session"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { Context, Deferred, Effect, Layer, Schema, Scope } from "effect"

export class RequestError extends Schema.TaggedError<RequestError>()("Browser.RequestError", {
  message: Schema.String,
}) {}
export interface Peer {
  readonly request: (command: Browser.Command) => Effect.Effect<Browser.Result, RequestError>
}
export interface Controller {
  readonly closed: Effect.Effect<void>
  readonly state: (state: Browser.State | null) => Effect.Effect<void>
}
type Registration = { peer: Peer; state: Browser.State | null; closed: Deferred.Deferred<void> }

export class Service extends Context.Service<
  Service,
  {
    readonly activate: Effect.Effect<void, never, Scope.Scope>
    readonly register: (id: Session.ID, peer: Peer) => Effect.Effect<Controller, RequestError, Scope.Scope>
    readonly release: (id: Session.ID) => Effect.Effect<void>
    readonly get: (id: Session.ID) => Effect.Effect<({ state: Browser.State | null } & Peer) | undefined>
  }
>()("@opencode/BrowserHost") {}
export type Interface = Context.Service.Shape<typeof Service>

export const layer = Layer.sync(Service, () => {
  let active = false
  const registrations = new Map<Session.ID, Registration>()
  const release = (id: Session.ID) =>
    Effect.gen(function* () {
      const entry = registrations.get(id)
      if (!entry) return
      registrations.delete(id)
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
      if (!active || registrations.has(id)) return yield* new RequestError({ message: "Browser is unavailable." })
      const entry: Registration = { peer, state: null, closed: yield* Deferred.make<void>() }
      yield* Effect.acquireRelease(
        Effect.sync(() => registrations.set(id, entry)),
        () => (registrations.get(id) === entry ? release(id) : Effect.void),
      )
      return {
        closed: Deferred.await(entry.closed),
        state: (state) =>
          Effect.sync(() => {
            entry.state = state
          }),
      }
    }),
    get: (id) =>
      Effect.sync(() => {
        const entry = registrations.get(id)
        if (!entry) return
        return {
          state: entry.state,
          request: (command: Browser.Command) =>
            entry.peer
              .request(command)
              .pipe(
                Effect.raceFirst(
                  Deferred.await(entry.closed).pipe(
                    Effect.andThen(new RequestError({ message: "Browser connection closed." })),
                  ),
                ),
              ),
        }
      }),
  })
})

export const node = makeLocationNode({ service: Service, layer, deps: [] })
