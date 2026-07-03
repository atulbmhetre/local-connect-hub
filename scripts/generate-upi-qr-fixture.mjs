import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const payload = 'upi://pay?pa=fixture-vendor@okhdfcbank&pn=FixtureShop';
const out = path.join(__dirname, '..', 'tests', 'fixtures', 'upi-qr-okhdfcbank.png');

await fs.promises.mkdir(path.dirname(out), { recursive: true });
await QRCode.toFile(out, payload, { type: 'png', width: 256, margin: 2 });
console.log(`Wrote ${out}`);
