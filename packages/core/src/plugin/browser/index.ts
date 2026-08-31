export * as BrowserPlugin from "./index.js"

import { define } from "@opencode-ai/plugin/effect/plugin"
import { Effect, Stream } from "effect"
import { Permission } from "../../permission.js"
import { BrowserHost } from "./host.js"
import { BrowserTools } from "./tools.js"

export const Plugin = define({
  id: "opencode.browser",
  effect: Effect.fn("BrowserPlugin")(function* (ctx) {
    const browser = yield* BrowserHost.Service
    const permission = yield* Permission.Service
    yield* browser.activate
    yield* ctx.tool.transform((draft) => BrowserTools.register(draft, browser, permission)).pipe(Effect.orDie)
    yield* ctx.session.hook("context", (event) =>
      browser.get(event.sessionID).pipe(
        Effect.map((current) => {
          for (const name of BrowserTools.names) {
            if (!current || (name === "browser_open") !== (current.type === "available")) delete event.tools[name]
          }
        }),
      ),
    )
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "session.deleted" || event.type === "session.moved"),
      Stream.runForEach((event) => browser.release(event.data.sessionID)),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
