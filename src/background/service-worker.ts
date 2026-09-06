// Service worker entry point. Session registry and command routing arrive in
// an upcoming commit; for now the toolbar button opens the side panel.

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('setPanelBehavior failed', err));
