let e=null;function n(){if(e)return e;const i=window.acquireVsCodeApi;if(typeof i!="function")throw new Error("acquireVsCodeApi unavailable — not in a VSCode webview");return e=i(),e}export{n as g};
