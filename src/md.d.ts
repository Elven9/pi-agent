// `import text from "./foo.md"` gives the file's contents as a string. esbuild inlines it
// (build.mjs: loader ".md": "text"); tests and `npm run dev` use scripts/md-loader.mjs.
declare module "*.md" {
  const content: string;
  export default content;
}
