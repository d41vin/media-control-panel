// Shell wiring. The list, probe and controls land in the next commits; this
// stub only renders the static chrome (footer hints, empty state) so the
// popup loads as a complete, if inert, surface.

const hintsEl = document.getElementById('hints');
const isMac = /Mac/.test(navigator.userAgent);
hintsEl.textContent = isMac ? '⇧⌘P Pause · ⌘⇧M Mute' : '';
if (!isMac) {
  hintsEl.replaceChildren(
    ...['Alt+Shift+P', ' Pause all · ', 'Alt+Shift+M', ' Mute all'].map((t, i) =>
      i % 2 === 0 ? Object.assign(document.createElement('kbd'), { textContent: t }) : document.createTextNode(t),
    ),
  );
}
