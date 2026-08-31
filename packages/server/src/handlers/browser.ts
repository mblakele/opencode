import { Instance } from "@opencode-ai/core/instance/service"
import { BrowserHost } from "@opencode-ai/core/plugin/browser/host"
import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor-service"
import { Session } from "@opencode-ai/core/session"
import { BrowserControlProtocol } from "@opencode-ai/protocol/browser-control"
import { Deferred, Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { BrowserControlConnection } from "../browser-control-connection"
import { CorsConfig, isAllowedRequestOrigin } from "../cors"

export const BrowserHandler = HttpApiBuilder.group(Api, "server.browser", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instances = yield* Instance.Service
    const cors = yield* CorsConfig
    const register: BrowserHost.Interface["register"] = Effect.fn("Browser.register")(function* (id, peer) {
      const session = yield* sessions
        .get(id)
        .pipe(Effect.mapError(() => new BrowserHost.RequestError({ message: "Session not found." })))
      const ready = yield* Deferred.make<BrowserHost.Controller, BrowserHost.RequestError>()
      // Keep the selected instance alive for the connection, not just registration.
      yield* Effect.gen(function* () {
        const plugins = yield* PluginSupervisor.Service
        yield* plugins.flush
        const browser = yield* BrowserHost.Service
        const controller = yield* browser.register(id, peer)
        yield* Deferred.succeed(ready, controller)
        yield* controller.closed
      }).pipe(
        Effect.scoped,
        instances.provide(session),
        Effect.catchCause((cause) => Deferred.failCause(ready, cause)),
        Effect.forkScoped,
      )
      return yield* Deferred.await(ready)
    })
    return handlers.handleRaw("browser.control.connect", ({ request }) =>
      Effect.gen(function* () {
        if (!isAllowedRequestOrigin(request.headers.origin, request.headers.host, cors)) {
          return HttpServerResponse.empty({ status: 403 })
        }
        if (request.headers["sec-websocket-protocol"] !== BrowserControlProtocol.Subprotocol) {
          return HttpServerResponse.empty({ status: 426 })
        }
        const socket = yield* Effect.orDie(request.upgrade)
        yield* BrowserControlConnection.run(register, socket)
        return HttpServerResponse.empty()
      }),
    )
  }),
)
