import { build } from 'esbuild';
const r = await build({
	entryPoints: ['src/main.ts'],
	platform: 'browser',
	format: 'esm',
	target: 'es2022',
	outdir: 'out-test',
	write: false,
	bundle: true,
	minify: true,
});
console.log('esbuild full ok, len', r.outputFiles[0].text.length);
