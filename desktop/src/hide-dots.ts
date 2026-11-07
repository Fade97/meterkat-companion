// "Claude · Weekly", "Resets in 2h 10m · 14:30": the middle dot only separates visually. Screen readers would read it
// ("dot"), so every one in rendered text is wrapped in an aria-hidden span; the words around it stay.

/** Hides each "·" in the text under `root` from assistive technology. */
export function hideDots(root: Node) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.data.includes("·") && !node.parentElement?.closest("[aria-hidden='true']")) found.push(node);
  }
  for (const node of found) {
    const parts = node.data.split("·"), fragment = document.createDocumentFragment();
    parts.forEach((part, i) => {
      if (i) { const dot = document.createElement("span"); dot.setAttribute("aria-hidden", "true"); dot.textContent = "·"; fragment.append(dot); }
      if (part) fragment.append(part);
    });
    node.replaceWith(fragment);
  }
}
