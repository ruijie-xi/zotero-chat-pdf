/** Trusted content shell. Only fixed bundled assets are fetched here. */
const hostWindow = window as any;
const asset = (path: string) => fetch(`chrome://chatpdf-visual/content/${path}`);
hostWindow.chatpdfVisualReady = (async () => {
  const script = await (await asset("scripts/sandbox.js")).text();
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  const token = crypto.randomUUID();
  const channel = new MessageChannel();
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const ready = new Promise<void>(resolve => {
    channel.port1.onmessage = event => {
      if (event.data?.token !== token) return;
      if (event.data.type === "ready") resolve();
      const callback = pending.get(event.data.id);
      if (callback) { pending.delete(event.data.id); if (event.data.error) callback.reject(new Error(String(event.data.error))); else callback.resolve(event.data.result); }
    };
  });
  // The only executable script in this opaque-origin frame is our bundled renderer.
  // Only the TeX compiler uses a terminable worker; no model JavaScript is accepted.
  iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${token}' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; worker-src blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"><style>html,body{margin:0;min-height:100%;font:15px system-ui;color:#182637;background:#fff}body{box-sizing:border-box;padding:16px}svg{max-width:100%;height:auto}button,input,select{font:inherit}button{cursor:pointer}*{box-sizing:border-box}</style></head><body><div id="visual"></div><script nonce="${token}">window.visualToken=${JSON.stringify(token)};${script.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
  iframe.addEventListener("load", () => iframe.contentWindow!.postMessage({ token, type: "connect" }, "*", [channel.port2]), { once: true });
  document.body.append(iframe);
  await ready;
  let tikzAssets: Promise<any> | undefined;
  const getTikz = () => tikzAssets ||= Promise.all([asset("vendor/tikzjax/tikzjax.js").then(r => r.text()), asset("vendor/tikzjax/tex.wasm").then(r => r.arrayBuffer()), asset("vendor/tikzjax/core.dump.gz").then(r => r.arrayBuffer())]).then(([script, wasm, core]) => ({ script, wasm, core }));
  const call = async (request: any) => {
    const id = crypto.randomUUID();
    if (request.kind === "tikz") request.assets = await getTikz();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      channel.port1.postMessage({ token, id, request });
    });
  };
  return {
    render: (json: string) => call(JSON.parse(json)),
    close: () => { channel.port1.close(); iframe.remove(); for (const callback of pending.values()) callback.reject(new Error("Visual renderer closed.")); pending.clear(); },
  };
})();
