import * as esbuild from "esbuild";
const empty = ["@abstract-foundation/agw-client", "@farcaster/mini-app-solana", "permissionless", "@stripe/stripe-js"];
await esbuild.build({
  entryPoints: ["src/privy.jsx"],
  bundle: true, minify: true, format: "esm", target: "es2020", splitting: true,
  outdir: "../site/privy", entryNames: "privy", chunkNames: "c-[hash]",
  jsx: "automatic", define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  plugins: [{ name: "empty", setup(b) {
    const re = new RegExp("^(" + empty.map(s => s.replace(/[/.]/g, "\$&")).join("|") + ")(/.*)?$");
    b.onResolve({ filter: re }, a => ({ path: a.path, namespace: "empty" }));
    b.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "export default {}; export const __empty = true; export const loadStripe = async () => null;", loader: "js" }));
  } }],
  logLevel: "warning",
});
console.log("ok");
