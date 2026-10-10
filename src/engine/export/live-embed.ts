/**
 * 'live-embed' export target: STUB (M6). Real embed runtime (reconstructs
 * the engine from doc JSON and renders it live inside the exported HTML)
 * lands M8. This proves the export-target plumbing end to end only: a
 * self-contained HTML file carrying the document JSON and a loader
 * placeholder comment.
 */

import type { ExportTargetDef } from '../registry/registry';
import type { ExportRequest, ExportResult } from '../host/protocol';

export const liveEmbedExportTarget: ExportTargetDef = {
  id: 'live-embed',
  label: 'Live Embed (stub)',
  mime: 'text/html',
  async run(reqUnknown): Promise<ExportResult> {
    const req = reqUnknown as ExportRequest;
    // See host/localHost.ts export(): docJson is the doc, JSON-stringified,
    // since ExportRequest.options is scalar-only (frozen protocol).
    const docJson = (req.options?.['docJson'] as string | undefined) ?? '{}';

    const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>gdesign live embed (stub)</title></head>
<body>
<!-- STUB export target (M6). The real embed runtime (reconstructing the
     engine from the doc JSON below and rendering it live) lands M8. -->
<script type="application/json" id="gdesign-doc">${docJson}</script>
<div id="gdesign-embed-root">gdesign live embed: runtime not yet implemented (M8).</div>
</body>
</html>
`;
    return { mime: 'text/html', data: new TextEncoder().encode(html).buffer, fileName: 'gdesign-embed.html' };
  },
};
