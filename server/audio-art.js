import sharp from 'sharp';

// No user text/URLs are interpreted by the image renderer.
export async function audioPlaceholder(destination) {
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#1d275b"/><stop offset="1" stop-color="#7163ca"/></linearGradient></defs><rect width="600" height="600" fill="url(#g)"/><circle cx="300" cy="300" r="208" fill="#ffffff" fill-opacity=".05"/><circle cx="300" cy="300" r="155" fill="none" stroke="#ffffff" stroke-opacity=".12" stroke-width="2"/><path d="M340 195v205m0-205 100-25v190m-100-110 100-25" fill="none" stroke="#f0edff" stroke-width="16" stroke-linejoin="round"/><ellipse cx="312" cy="400" rx="36" ry="26" fill="#f0edff"/><ellipse cx="412" cy="360" rx="36" ry="26" fill="#f0edff"/></svg>';
  await sharp(Buffer.from(svg)).jpeg({quality:85}).toFile(destination);
}
