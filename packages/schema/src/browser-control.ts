export * as BrowserControl from "./browser-control.js"

import { Schema } from "effect"
import { Browser } from "./browser.js"
import { ascending } from "./identifier.js"
import { SessionID } from "./session-id.js"
import { statics } from "./schema.js"

const RequestIDSchema = Schema.String.check(Schema.isPattern(/^brr_[0-9A-Za-z]+$/))
  .pipe(Schema.brand("BrowserControl.RequestID"))
  .annotate({ identifier: "BrowserControl.RequestID" })

export const RequestID = RequestIDSchema.pipe(
  statics((schema: typeof RequestIDSchema) => ({
    create: () => schema.make("brr_" + ascending()),
  })),
)
export type RequestID = typeof RequestID.Type

export const FromClient = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("browser.control.register"),
    sessionID: SessionID,
  }),
  Schema.Struct({
    type: Schema.Literal("browser.control.state"),
    state: Schema.NullOr(Browser.State),
  }),
  Schema.Struct({
    type: Schema.Literal("browser.control.response"),
    requestID: RequestID,
    outcome: Browser.Outcome,
  }),
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "BrowserControl.FromClient" })
export type FromClient = typeof FromClient.Type

export const FromServer = Schema.Union([
  Schema.Struct({ type: Schema.Literal("browser.control.registered") }),
  Schema.Struct({
    type: Schema.Literal("browser.control.request"),
    requestID: RequestID,
    command: Browser.Command,
  }),
  Schema.Struct({
    type: Schema.Literal("browser.control.cancel"),
    requestID: RequestID,
  }),
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "BrowserControl.FromServer" })
export type FromServer = typeof FromServer.Type
