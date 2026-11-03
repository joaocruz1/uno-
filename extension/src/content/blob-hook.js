// Runs in the page's own world on the marketplace domains. Seller centers build
// the label PDF as a blob, click a hidden link and revoke the blob right away;
// keeping it alive for a minute lets the extension read the file it is about to
// convert. Nothing else on the page is touched.
(() => {
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = (url) => { setTimeout(() => revoke(url), 60_000); };
})();
