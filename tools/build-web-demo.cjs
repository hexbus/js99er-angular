// Build a static website that can be uploaded to any directory, including
// https://hexbus.com/js99er-ubergrom/. No Node server is needed for the site.
const {execFileSync} = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const run = args => execFileSync(process.execPath, args, {cwd: root, stdio: 'inherit'});
run(['node_modules/assemblyscript/bin/asc.js', 'assembly/index.ts', '--target', 'release',
    '--importMemory', '--memoryBase', '98304', '--runtime', 'stub']);
run(['node_modules/@angular/cli/bin/ng.js', 'build', '--configuration', 'production',
    '--base-href', './']);
console.log('Upload the contents of dist/browser to your website directory.');
