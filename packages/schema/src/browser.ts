export * as Browser from "./browser.js"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "./schema.js"

export const Ref = Schema.String.check(Schema.isPattern(/^@?e[1-9][0-9]*$/))
  .pipe(Schema.brand("Browser.Ref"))
  .annotate({ identifier: "Browser.Ref" })
export type Ref = typeof Ref.Type

export interface State extends Schema.Schema.Type<typeof State> {}
export const State = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(16_384)),
  title: Schema.String.check(Schema.isMaxLength(1_024)),
  loading: Schema.Boolean,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  generation: NonNegativeInt,
}).annotate({ identifier: "Browser.State" })

export const Key = Schema.Literals([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Space",
]).annotate({ identifier: "Browser.Key" })
export type Key = typeof Key.Type

export const Direction = Schema.Literals(["up", "down", "left", "right"]).annotate({
  identifier: "Browser.Direction",
})
export type Direction = typeof Direction.Type

export const Action = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["open", "snapshot", "screenshot", "back", "forward", "reload", "stop"]) }),
  Schema.Struct({
    type: Schema.Literal("navigate"),
    url: Schema.String.check(Schema.isMaxLength(16_384)),
  }),
  Schema.Struct({ type: Schema.Literal("click"), ref: Ref }),
  Schema.Struct({
    type: Schema.Literal("fill"),
    ref: Ref,
    text: Schema.String.check(Schema.isMaxLength(10_000)),
  }),
  Schema.Struct({ type: Schema.Literal("press"), key: Key }),
  Schema.Struct({
    type: Schema.Literal("scroll"),
    direction: Direction,
    pixels: PositiveInt.check(Schema.isLessThanOrEqualTo(2000)),
  }),
]).annotate({ identifier: "Browser.Action" })
export type Action = typeof Action.Type

export const Command = Schema.Struct({ action: Action, generation: NonNegativeInt }).annotate({
  identifier: "Browser.Command",
})
export type Command = typeof Command.Type

export const Result = Schema.Union([
  Schema.Struct({ type: Schema.Literal("state"), state: State }),
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    state: State,
    content: Schema.String.check(Schema.isMaxLength(100_000)),
  }),
  Schema.Struct({
    type: Schema.Literal("screenshot"),
    state: State,
    data: Schema.Uint8ArrayFromBase64.check(Schema.isMaxLength(5 * 1_024 * 1_024)),
  }),
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Browser.Result" })
export type Result = typeof Result.Type

const Failure = Schema.Struct({
  type: Schema.Literal("failure"),
  message: Schema.String.check(Schema.isMaxLength(1_024)),
}).annotate({ identifier: "Browser.Failure" })

const Success = Schema.Struct({
  type: Schema.Literal("success"),
  result: Result,
}).annotate({ identifier: "Browser.Success" })

export const Outcome = Schema.Union([Success, Failure])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Browser.Outcome" })
export type Outcome = typeof Outcome.Type
