# Browser Plugin

The browser feature owns its tools, context hooks, and live
attachment state here. Generic agent, session, and tool services contain no
browser policy.

- `index.ts` registers tools and lifecycle hooks through the existing plugin
  context. Everything belongs to `opencode.browser`.
- `host.ts` is an instance-scoped bridge for the plugin and server transport. It
  has no Session store or Bus dependencies. Plugin activation enables it; plugin
  unload revokes registrations and pending requests.
- `tools.ts` owns browser commands, leaf permission checks, and untrusted output
  rendering. Permissions follow the existing agent rules and permission service,
  like other built-in tools. The plugin does not add or change agent defaults.

The server adapter owns the control WebSocket. It validates the Session and selects
its instance before accessing the bridge. Session deletion or movement releases
the old attachment through the plugin's event subscription.

Disable the feature with `plugins: ["-opencode.browser"]`. There are no legacy
plugin IDs, compatibility entrypoints, or process-global browser registrations.

Electron loads pages using the desktop's network. There is no server-side proxy
or generic client/driver API; the desktop implements browser commands directly.
