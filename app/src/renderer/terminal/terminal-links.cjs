'use strict';

// OSC 8 links in the raw >_ terminal (2026-10-18). xterm 5.5 with no
// linkHandler answers a click on an OSC 8 link with its own default
// (OscLinkProvider.ts defaultActivate): a native confirm() box, then
// window.open() with NO address, which the main window's setWindowOpenHandler
// denies because a blank window is not http(s). So a link in the >_ view never
// opened, and Claude CLI 2.1.302 made every row of a wrapped URL such a link.
// A click now hands the address to window.open as a new-window request, the
// same path a conversation link takes (stage/md.jsx renders them
// target="_blank"): main opens http(s) in the default browser through
// openExternalLink and refuses anything else, and an isolated harness records
// instead of launching. xterm itself ignores non-http(s) OSC 8 links unless
// allowNonHttpProtocols is set, which it is not. CommonJS so the test requires
// it directly.
function terminalLinkHandler(openWindow) {
  return {
    activate(event, uri) {
      if (typeof uri !== 'string' || !uri) return;
      event?.preventDefault?.();
      openWindow(uri, '_blank', 'noopener');
    },
  };
}

module.exports = { terminalLinkHandler };
