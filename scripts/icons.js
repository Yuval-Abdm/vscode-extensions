// Génère media/icon.png (256×256, Marketplace : 128×128 minimum) depuis media/icon.svg pour chaque extension.
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

for (const pkg of ['changed-files-explorer', 'ftp-sftp-deploy', 'php-forge']) {
  const dir = path.join(__dirname, '..', 'packages', pkg, 'media');
  const png = new Resvg(fs.readFileSync(path.join(dir, 'icon.svg')), { fitTo: { mode: 'width', value: 256 } }).render().asPng();
  fs.writeFileSync(path.join(dir, 'icon.png'), png);
  console.log(`${pkg}/media/icon.png (${png.length} octets)`);
}
