import type { BrowserPaneCommand, BrowserPaneLayout, BrowserPaneTarget } from "@opencode-ai/app/desktop"
import { BrowserControlProtocol } from "@opencode-ai/protocol/browser-control"
import { Browser } from "@opencode-ai/schema/browser"
import type { BrowserControl } from "@opencode-ai/schema/browser-control"
import { SessionID } from "@opencode-ai/schema/session-id"
import type { BrowserWindow } from "electron"
import { Effect, Schema } from "effect"
import WebSocket from "ws"
import { BrowserPaneEvent } from "../shared/ipc-rpc/events"
import { createBrowserPage, destinationOrigin, initialBrowserState, type BrowserPage } from "./browser-chromium"
import { emitIpcEvent } from "./ipc-events"

type Entry = {
  bindingID: string
  win: BrowserWindow
  socket: WebSocket
  registered: PromiseWithResolvers<void>
  requests: Map<BrowserControl.RequestID, AbortController>
  cleanup?: () => void
  page?: BrowserPage
  attached: boolean
}

export function createBrowserPane() {
  const entries = new Map<string, Entry>()
  let disposed = false
  return {
    async register(win: BrowserWindow, bindingID: string, target: BrowserPaneTarget) {
      if (disposed || !destinationOrigin(target.endpoint.url)) throw new Error("browser.pane.registration.invalid")
      if (target.endpoint.username && !target.endpoint.password) throw new Error("browser.pane.endpoint.invalid")
      if (entries.has(bindingID)) throw new Error("browser.pane.owner.invalid")
      if (win.isDestroyed() || win.webContents.isDestroyed()) throw new Error("browser.pane.owner.unavailable")
      const sessionID = SessionID.make(target.sessionID)
      const url = new URL(BrowserControlProtocol.Path, target.endpoint.url)
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      const socket = new WebSocket(url, BrowserControlProtocol.Subprotocol, {
        headers: target.endpoint.password
          ? {
              Authorization: `Basic ${Buffer.from(`${target.endpoint.username ?? "opencode"}:${target.endpoint.password}`).toString("base64")}`,
            }
          : {},
        handshakeTimeout: 10_000,
        maxPayload: BrowserControlProtocol.MaxMessageBytes,
        perMessageDeflate: false,
      })
      const entry: Entry = {
        bindingID,
        win,
        socket,
        attached: false,
        registered: Promise.withResolvers(),
        requests: new Map(),
      }
      const stop = () => close(entry)
      socket.on("error", stop)
      socket.on("close", stop)
      socket.once("open", () => send(entry, { type: "browser.control.register", sessionID }))
      socket.on("message", async (data, binary) => {
        try {
          if (binary) return stop()
          const message = Effect.runSync(BrowserControlProtocol.decodeFromServer(data.toString()))
          if (message.type === "browser.control.registered") return entry.registered.resolve()
          if (message.type === "browser.control.open") return publish(entry, { type: "open" })
          if (message.type === "browser.control.cancel") return entry.requests.get(message.requestID)?.abort()
          const abort = new AbortController()
          entry.requests.set(message.requestID, abort)
          const outcome: Browser.Outcome = await Promise.resolve()
            .then(() => {
              if (!entry.attached || !entry.page) throw new Error("not_attached")
              return entry.page.execute(message.command, abort.signal)
            })
            .then(
              (result) => ({ type: "success" as const, result }),
              (error: unknown) => {
                const code = abort.signal.aborted
                  ? "aborted"
                  : error instanceof Error && Schema.is(Browser.ErrorCode)(error.message)
                    ? error.message
                    : "internal"
                return { type: "failure" as const, code, message: code }
              },
            )
          entry.requests.delete(message.requestID)
          send(entry, { type: "browser.control.response", requestID: message.requestID, outcome })
        } catch {
          stop()
        }
      })
      const navigate = (event: Electron.Event<{ isMainFrame: boolean; isSameDocument: boolean }>) => {
        if (event.isMainFrame && !event.isSameDocument) stop()
      }
      win.webContents.once("destroyed", stop)
      win.webContents.on("did-start-navigation", navigate)
      entry.cleanup = () => {
        win.webContents.off("destroyed", stop)
        win.webContents.off("did-start-navigation", navigate)
      }
      entries.set(bindingID, entry)
      await entry.registered.promise
      if (entries.get(bindingID) !== entry) throw new Error("browser.pane.registration.closed")
      publish(entry, { type: "state", state: { ...initialBrowserState } })
    },
    layout(win: BrowserWindow, bindingID: string, value?: BrowserPaneLayout) {
      update(owned(win, bindingID), value)
    },
    async command(win: BrowserWindow, bindingID: string, command: BrowserPaneCommand) {
      const entry = owned(win, bindingID)
      if (!entry.attached || !entry.page) throw new Error("browser.pane.attachment.unavailable")
      await entry.page.command(command)
    },
    async close(win: BrowserWindow, bindingID: string) {
      close(owned(win, bindingID))
    },
    async dispose() {
      disposed = true
      entries.forEach(close)
    },
  }

  function owned(win: BrowserWindow, bindingID: string) {
    const entry = entries.get(bindingID)
    if (!entry || entry.win !== win) throw new Error("browser.pane.unavailable")
    return entry
  }

  function publish(entry: Entry, event: BrowserPaneEvent["event"]) {
    if (!entries.has(entry.bindingID) || entry.win.isDestroyed() || entry.win.webContents.isDestroyed()) return
    emitIpcEvent(entry.win.webContents, new BrowserPaneEvent({ bindingID: entry.bindingID, event }))
  }

  function close(entry: Entry) {
    if (entries.get(entry.bindingID) !== entry) return
    publish(entry, { type: "state", state: { ...initialBrowserState, error: "browser.pane.registration.closed" } })
    entries.delete(entry.bindingID)
    entry.registered.reject(new Error("browser.pane.registration.closed"))
    entry.cleanup?.()
    detach(entry)
    entry.socket.terminate()
  }

  function detach(entry: Entry) {
    if (entry.attached) send(entry, { type: "browser.control.detach" })
    entry.attached = false
    entry.requests.forEach((request) => request.abort())
    entry.requests.clear()
    entry.page?.dispose()
    entry.page = undefined
  }

  function update(entry: Entry, layout?: BrowserPaneLayout) {
    const bounds = layout?.visible ? layout.bounds : undefined
    if (!bounds || bounds.width <= 0 || bounds.height <= 0 || entry.win.isDestroyed()) return detach(entry)
    if (!entry.page) {
      const fail = () => {
        if (entry.page !== page) return
        detach(entry)
        publish(entry, { type: "state", state: { ...initialBrowserState, error: "page_crashed" } })
      }
      const page = createBrowserPage(
        entry.win,
        (state, error) => {
          if (entry.page !== page || !entry.attached) return
          send(entry, { type: "browser.control.state", state })
          publish(entry, { type: "state", state: { ...state, ready: true, error } })
        },
        fail,
      )
      entry.page = page
      void page.ready
        .then(() => {
          if (entry.page !== page) return
          entry.attached = true
          send(entry, { type: "browser.control.attach", state: page.state() })
          publish(entry, { type: "state", state: { ...page.state(), ready: true } })
        })
        .catch(fail)
    }
    entry.page?.view.setBounds(bounds)
    entry.page?.view.setVisible(true)
  }

  function send(entry: Entry, message: BrowserControl.FromClient) {
    if (entry.socket.readyState === WebSocket.OPEN) entry.socket.send(BrowserControlProtocol.encodeFromClient(message))
  }
}
