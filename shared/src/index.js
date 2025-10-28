// Shared email helpers (ESM)

export function buildHtml(message, links = []) {
  const list = links
    .map(
      (l) =>
        `<li><strong>${escapeHtml(l.label)}:</strong> <a href="${l.url}">${escapeHtml(
          l.key
        )}</a></li>`
    )
    .join("");

  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5;">
      <p>${escapeHtml(message ?? "")}</p>
      ${links.length ? `<p>Downloads:</p><ul>${list}</ul>` : ""}
      <p>If a link expires, re-send from the app to generate a fresh one.</p>
    </div>
  `;
}

export function buildText(message, links = []) {
  const list = links
    .map((l) => `- ${l.label}: ${l.url}  (${l.key})`)
    .join("\n");
  return `${message ?? ""}\n\n${
    links.length ? "Downloads:\n" + list + "\n" : ""
  }If a link expires, re-send from the app to generate a fresh one.\n`;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
