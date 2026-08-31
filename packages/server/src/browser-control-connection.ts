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
  const pending = new Map<BrowserControl.RequestID, Deferred.Deferred<Browser.Result, BrowserHost.RequestError>>()
  let controller: BrowserHost.Controller | undefined
  const send = (message: BrowserControl.FromServer) =>
    write(BrowserControlProtocol.encodeFromServer(message)).pipe(
      Effect.mapError(() => new BrowserHost.RequestError({ message: "Browser connection closed." })),
    )
  const peer: BrowserHost.Peer = {
    request: Effect.fn("Browser.request")(function* (command) {
      const requestID = BrowserControl.RequestID.create()
      const done = yield* Deferred.make<Browser.Result, BrowserHost.RequestError>()
      pending.set(requestID, done)
      return yield* send({ type: "browser.control.request", requestID, command }).pipe(
        Effect.andThen(Deferred.await(done)),
        Effect.onInterrupt(() => send({ type: "browser.control.cancel", requestID }).pipe(Effect.ignore)),
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () => new BrowserHost.RequestError({ message: "Browser request timed out." }),
        }),
        Effect.ensuring(Effect.sync(() => pending.delete(requestID))),
      )
    }),
  }
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
        if (message.type === "browser.control.state") return yield* controller.state(message.state)
        const done = pending.get(message.requestID)
        if (!done) return
        if (message.outcome.type === "failure")
          return yield* Deferred.fail(done, new BrowserHost.RequestError(message.outcome))
        yield* Deferred.succeed(done, message.outcome.result)
      }),
    )
    .pipe(Effect.catch(() => write(new Socket.CloseEvent(1002)).pipe(Effect.ignore)))
})
