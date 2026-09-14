// Production Bootstrap Entry for SteamAIReplyBot
// Loads runtime sandbox patch before executing main application
require('./patch-fs');
require('./dist/index.js');
