import { expect } from "bun:test"
import { BrowserHost } from "@opencode-ai/core/plugin/browser/host"
import { Browser } from "@opencode-ai/schema/browser"
import { Session } from "@opencode-ai/schema/session"
import { Effect, Exit, Scope } from "effect"
import { testEffect } from "../lib/effect"

const it = testEffect(BrowserHost.layer)

it.effect("scopes the desktop browser registration to plugin activation", () =>
  Effect.gen(function* () {
    const browser = yield* BrowserHost.Service
    const sessionID = Session.ID.make("ses_browser")
    const state: Browser.State = {
      url: "http://localhost/",
      title: "Page",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      generation: 0,
    }
    const peer: BrowserHost.Peer = {
      open: Effect.void,
      request: () => Effect.succeed({ type: "snapshot", state, format: "opencode.semantic.v1", content: "Page" }),
    }
    expect((yield* browser.register(sessionID, peer).pipe(Effect.flip)).code).toBe("not_attached")
    const scope = yield* Scope.make()
    yield* browser.activate.pipe(Scope.provide(scope))
    const connection = yield* browser.register(sessionID, peer)
    expect((yield* browser.get(sessionID))?.type).toBe("available")
    yield* connection.attach(state)
    const attached = yield* browser.get(sessionID)
    if (attached?.type !== "attached") return yield* Effect.die("Expected attached browser")
    expect(yield* attached.request({ type: "snapshot", generation: 0 })).toMatchObject({ content: "Page" })
    yield* Scope.close(scope, Exit.void)
    yield* connection.closed
    expect(yield* browser.get(sessionID)).toBeUndefined()
  }),
)
