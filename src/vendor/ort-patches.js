// Build-time patches for ONNX Runtime Web so it runs under the extension's
// Content Security Policy (no eval, no remote or dynamic code loading).
// Each patch must match exactly once; the build fails if an upgrade changes the code.

// 1. Embind creates its JS→WASM method callers with `new Function`. Replace the
//    generated source with a closure that does the same thing.
export const INVOKER_HELPER = `
function aegisCreateInvoker(k, kind) {
  const readers = Object.keys(k).filter((n) => n.startsWith("argFromPtr")).map((n) => k[n]);
  return function (handle, methodName, destructorsRef, args) {
    const argv = readers.map((read, p) => read(args + 8 * p));
    let result;
    switch (kind) {
      case 0: result = k.toValue(handle)(...argv); break;
      case 1: result = k.toValue(handle)[k.getStringOrSymbol(methodName)](...argv); break;
      case 2: result = new (k.toValue(handle))(...argv); break;
      case 3: result = argv[argv.length - 1]; break;
    }
    return k.emval_returnValue ? k.emval_returnValue(k.toReturnWire, destructorsRef, result) : undefined;
  };
}
`;

export const PATCHES = {
  "ort-wasm-simd-threaded.asyncify.mjs": [
    {
      find: "h=`return function (handle, methodName, destructorsRef, args) {\\n  ${h}\\n  }`;c=(new Function(Object.keys(k),h))(...Object.values(k));",
      replace: "c=aegisCreateInvoker(k,c);",
    },
  ],
  // 2. The runtime imports its WASM glue from a URL at run time. Hand it the
  //    statically bundled module instead.
  "ort.webgpu.min.mjs": [
    {
      find: "nn=async t=>(await import(/*webpackIgnore:true*/ /*@vite-ignore*/t)).default",
      replace: "nn=async t=>aegisOrtFactory",
    },
  ],
};

export function ortPatchPlugin() {
  return {
    name: "ort-patches",
    setup(build) {
      build.onLoad({ filter: /onnxruntime-web[\\/]dist[\\/](ort-wasm-simd-threaded\.asyncify|ort\.webgpu\.min)\.mjs$/ }, async (args) => {
        const { readFile } = await import("node:fs/promises");
        const file = args.path.split(/[\\/]/).pop();
        let code = await readFile(args.path, "utf8");
        for (const { find, replace } of PATCHES[file]) {
          const count = code.split(find).length - 1;
          if (count !== 1) throw new Error(`ort-patches: expected 1 match in ${file}, found ${count}. Re-check after upgrading onnxruntime-web.`);
          code = code.replace(find, () => replace);
        }
        if (file.startsWith("ort-wasm")) code = INVOKER_HELPER + code;
        else code = `import aegisOrtFactory from "./ort-wasm-simd-threaded.asyncify.mjs";\n` + code;
        return { contents: code, loader: "js", resolveDir: args.path.replace(/[\\/][^\\/]*$/, "") };
      });
    },
  };
}
