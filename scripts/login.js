const path = require('path');
process.env.STEAM_BOT_ROOT = path.resolve(__dirname, '..', 'release');
require('../patch-fs');
process.argv.push('--login');
require('../dist/index.js');
