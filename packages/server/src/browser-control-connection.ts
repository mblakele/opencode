export * as BrowserControlConnection from "./browser-control-connection"

import { BrowserHost } from "@opencode-ai/core/plugin/browser/host"
import { BrowserControlProtocol } from "@opencode-ai/protocol/browser-control"
import { Browser } from "@opencode-ai/schema/browser"
import { BrowserControl } from "@opencode-ai/schema/browser-control"
import { Deferred, Effect } from "effect"
import { Socket } from "effect/unstable/socket"

export const run = Effect.fn("BrowserControlConnection.run")(function* (
  register: BrowserHost.Interface["register"],
  socket: Socket.Socket,
) {
  const write = yield* socket.writer
  const pending = new Map<BrowserControl.RequestID, Deferred.Deferred<Browser.Outcome>>()
  let controller: BrowserHost.Controller | undefined
  const send = (message: BrowserControl.FromServer) =>
    write(BrowserControlProtocol.encodeFromServer(message)).pipe(
      Effect.mapError(
        () => new BrowserHost.RequestError({ code: "not_attached", message: "Browser connection closed." }),
      ),
    )
  const peer: BrowserHost.Peer = {
    open: send({ type: "browser.control.open" }),
    request: Effect.fn("Browser.request")(function* (command) {
      const requestID = BrowserControl.RequestID.create()
      const done = yield* Deferred.make<Browser.Outcome>()
      pending.set(requestID, done)
      const outcome = yield* send({ type: "browser.control.request", requestID, command }).pipe(
        Effect.andThen(Deferred.await(done)),
        Effect.onInterrupt(() => send({ type: "browser.control.cancel", requestID }).pipe(Effect.ignore)),
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () => new BrowserHost.RequestError({ code: "timeout", message: "Browser request timed out." }),
        }),
        Effect.ensuring(Effect.sync(() => pending.delete(requestID))),
      )
      if (outcome.type === "failure") return yield* new BrowserHost.RequestError(outcome)
      return outcome.result
    }),
  }
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      pending.values(),
      (done) =>
        Deferred.succeed(done, {
          type: "failure",
          code: "not_attached",
          message: "Browser connection closed.",
        }),
      { discard: true },
    ),
  )
  yield* socket
    .runRaw(
      Effect.fnUntraced(function* (raw) {
        const message = yield* BrowserControlProtocol.decodeFromClient(raw)
        if (message.type === "browser.control.register") {
          if (controller) return yield* Effect.fail(new Error("Browser is already registered."))
          controller = yield* register(message.sessionID, peer)
          yield* controller.closed.pipe(
            Effect.andThen(write(new Socket.CloseEvent(1000))),
            Effect.ignore,
            Effect.forkScoped,
          )
          return yield* send({ type: "browser.control.registered" })
        }
        if (!controller) return yield* Effect.fail(new Error("Browser is not registered."))
        if (message.type === "browser.control.attach") return yield* controller.attach(message.state)
        if (message.type === "browser.control.state") return yield* controller.state(message.state)
        if (message.type === "browser.control.detach") return yield* controller.detach
        const done = pending.get(message.requestID)
        if (done) yield* Deferred.succeed(done, message.outcome)
      }),
    )
    .pipe(Effect.catch(() => write(new Socket.CloseEvent(1002)).pipe(Effect.ignore)))
})
