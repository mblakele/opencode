export * as BrowserHost from "./host.js"

import { Browser } from "@opencode-ai/schema/browser"
import { Session } from "@opencode-ai/schema/session"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { Context, Deferred, Effect, Layer, Schema, Scope } from "effect"

export class RegistrationError extends Schema.TaggedError<RegistrationError>()("BrowserHost.RegistrationError", {
  reason: Schema.Literals(["disabled", "unknown_session", "already_registered", "stale_registration", "stale_lease"]),
  message: Schema.String,
}) {}
export class RequestError extends Schema.TaggedError<RequestError>()("BrowserHost.RequestError", {
  code: Browser.ErrorCode,
  message: Schema.String,
}) {}
export interface Peer {
  readonly open: Effect.Effect<void, RequestError>
  readonly request: (command: Browser.Command, leaseID: Browser.LeaseID) => Effect.Effect<Browser.Result, RequestError>
}
export interface Controller {
  readonly closed: Effect.Effect<void>
  readonly attach: (leaseID: Browser.LeaseID, state: Browser.State) => Effect.Effect<void, RegistrationError>
  readonly state: (leaseID: Browser.LeaseID, state: Browser.State) => Effect.Effect<void, RegistrationError>
  readonly detach: (leaseID: Browser.LeaseID) => Effect.Effect<void, RegistrationError>
}
export interface Available {
  readonly type: "available"
  readonly open: Effect.Effect<void, RequestError>
}
export interface Attached {
  readonly type: "attached"
  readonly leaseID: Browser.LeaseID
  readonly state: Browser.State
  readonly revoked: Effect.Effect<void>
  readonly request: (command: Browser.Command) => Effect.Effect<Browser.Result, RequestError>
}
export type Capability = Available | Attached
export interface Interface {
  readonly activate: Effect.Effect<void, never, Scope.Scope>
  readonly release: (sessionID: Session.ID) => Effect.Effect<void>
  readonly register: (sessionID: Session.ID, peer: Peer) => Effect.Effect<Controller, RegistrationError, Scope.Scope>
  readonly get: (sessionID: Session.ID) => Effect.Effect<Capability | undefined>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/BrowserHost") {}

type Registration = {
  readonly peer: Peer
  readonly closed: Deferred.Deferred<void>
  ready: Deferred.Deferred<void>
  attachment?: { readonly leaseID: Browser.LeaseID; readonly revoked: Deferred.Deferred<void>; state: Browser.State }
}

export function make() {
  return Effect.sync(() => {
    let active = false
    const registrations = new Map<Session.ID, Registration>()
    const deferred = () => Deferred.makeUnsafe<void>()
    const resolve = (value: Deferred.Deferred<void>) => Deferred.doneUnsafe(value, Effect.void)
    const failed = (code: Browser.ErrorCode = "not_attached") =>
      new RequestError({ code, message: `Browser request ${code.replaceAll("_", " ")}.` })
    const invalid = (reason: RegistrationError["reason"]) =>
      new RegistrationError({ reason, message: `Browser registration ${reason.replaceAll("_", " ")}.` })
    const release = (id: Session.ID, expected?: Registration) =>
      Effect.sync(() => {
        const current = registrations.get(id)
        if (!current || (expected && expected !== current)) return
        registrations.delete(id)
        resolve(current.closed)
        if (current.attachment) resolve(current.attachment.revoked)
      })

    return Service.of({
      activate: Effect.acquireRelease(
        Effect.sync(() => {
          active = true
        }),
        () =>
          Effect.gen(function* () {
            active = false
            yield* Effect.forEach(registrations.keys(), (id) => release(id), { discard: true })
          }),
      ),
      release,
      register: Effect.fn("BrowserHost.register")(function* (id, peer) {
        const registration = yield* Effect.acquireRelease(
          Effect.suspend(() => {
            if (!active) return invalid("disabled")
            if (registrations.has(id)) return invalid("already_registered")
            const current: Registration = { peer, closed: deferred(), ready: deferred() }
            registrations.set(id, current)
            return Effect.succeed(current)
          }),
          (current) => release(id, current),
        )
        const update = (lease: Browser.LeaseID, existing: boolean, change: () => void) =>
          Effect.suspend(() => {
            if (registrations.get(id) !== registration) return invalid("stale_registration")
            if (existing && registration.attachment?.leaseID !== lease) return invalid("stale_lease")
            change()
            return Effect.void
          })
        return {
          closed: Deferred.await(registration.closed),
          attach: (leaseID, state) =>
            update(leaseID, false, () => {
              if (registration.attachment) resolve(registration.attachment.revoked)
              registration.attachment = { leaseID, state, revoked: deferred() }
              resolve(registration.ready)
            }),
          state: (leaseID, state) =>
            update(leaseID, true, () => {
              if (registration.attachment) registration.attachment.state = state
            }),
          detach: (leaseID) =>
            update(leaseID, true, () => {
              if (registration.attachment) resolve(registration.attachment.revoked)
              registration.attachment = undefined
              registration.ready = deferred()
            }),
        }
      }),
      get: (id) =>
        Effect.sync((): Capability | undefined => {
          const current = registrations.get(id)
          if (!current) return
          const attachment = current.attachment
          if (attachment) {
            return {
              type: "attached",
              leaseID: attachment.leaseID,
              state: attachment.state,
              revoked: Deferred.await(attachment.revoked),
              request: (command) =>
                Effect.suspend(() => {
                  if (registrations.get(id) !== current || current.attachment !== attachment) return failed()
                  return current.peer.request(command, attachment.leaseID).pipe(
                    Effect.raceFirst(Deferred.await(attachment.revoked).pipe(Effect.andThen(failed()))),
                    Effect.flatMap((result) =>
                      result.type === command.type ? Effect.succeed(result) : failed("protocol"),
                    ),
                  )
                }),
            }
          }
          const ready = current.ready
          return {
            type: "available",
            open: Effect.suspend(() => {
              if (registrations.get(id) !== current || current.ready !== ready || current.attachment) return failed()
              return current.peer.open.pipe(
                Effect.andThen(Deferred.await(ready)),
                Effect.raceFirst(Deferred.await(current.closed).pipe(Effect.andThen(failed()))),
                Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => failed("timeout") }),
              )
            }),
          }
        }),
    })
  })
}

export const layer = Layer.effect(Service, make())
export const node = makeLocationNode({ service: Service, layer, deps: [] })
