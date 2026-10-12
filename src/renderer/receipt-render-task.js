(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else root.ReceiptRenderTask = factory(root);
})(typeof window === "object" ? window : globalThis, function (runtime) {
  const canceled = () => new DOMException("小票渲染已取消", "AbortError");
  async function render(receipt, logos, signal) {
    signal.throwIfAborted();
    const copies = {};
    let worker;
    try {
      for (const [name, logo] of Object.entries(logos)) {
        signal.throwIfAborted();
        copies[name] = logo ? await runtime.createImageBitmap(logo) : null;
      }
      signal.throwIfAborted();
      worker = new runtime.Worker("receipt-worker.js");
      return await new Promise((resolve, reject) => {
        const finish = (error, result) => {
          signal.removeEventListener("abort", abort);
          worker.terminate();
          if (error) reject(error); else resolve(result);
        };
        const abort = () => finish(canceled());
        signal.addEventListener("abort", abort, { once: true });
        worker.onmessage = ({ data }) => {
          if (signal.aborted) { data.bitmap?.close(); return; }
          finish(data.error ? new Error(data.error) : null, data);
        };
        worker.onerror = (event) => { event.preventDefault(); finish(new Error("小票绘制失败")); };
        try { worker.postMessage({ receipt, logos: copies }, Object.values(copies).filter(Boolean)); }
        catch (error) { finish(error); }
      });
    } finally {
      // Transferred bitmaps are detached; close also releases untransferred copies on cancellation.
      for (const logo of Object.values(copies)) logo?.close();
    }
  }
  return { render };
});
