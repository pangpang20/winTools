const { app, desktopCapturer } = require('electron');
const fs = require('node:fs');

app.whenReady().then(async () => {
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 160, height: 90 } });
  fs.writeFileSync(process.env.CAPTURE_OUTPUT, JSON.stringify(sources.map((source) => ({ id: source.id, name: source.name, size: source.thumbnail.getSize(), image: source.thumbnail.toDataURL().startsWith('data:image/png;base64,') }))));
  app.quit();
}).catch((error) => { fs.writeFileSync(process.env.CAPTURE_OUTPUT, String(error.stack || error)); app.exit(1); });
