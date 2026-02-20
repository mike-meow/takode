/**
 * Programmatic conversion of the user-provided paw SVG (552x516 viewBox)
 * to 16x16 and 32x32 viewBoxes for CatIcons.tsx components.
 */

// Original SVG data from user (viewBox 0 0 552 516)
const ORIGINAL_VIEWBOX = { w: 552, h: 516 };

const ellipses = [
  { cx: 215, cy: 115, rx: 53, ry: 64 },   // top-left toe
  { cx: 353, cy: 115, rx: 53, ry: 64 },   // top-right toe
  { cx: 126.5, cy: 228, rx: 53.5, ry: 64 }, // bottom-left toe
  { cx: 441.5, cy: 228, rx: 53.5, ry: 64 }, // bottom-right toe
];

const pathData = "M 281 189.5 C 289.8 187.7 294.2 189.3 301 191.5 C 307.8 193.7 315.9 197.8 322 202.5 C 328.1 207.2 330.8 208.8 337.5 220 C 344.2 231.2 353.2 258.1 362.5 270 C 371.8 281.9 383.8 282.7 393 291.5 C 402.2 300.3 412.4 314.1 417.5 323 C 422.6 331.9 422.8 336.2 423.5 345 C 424.2 353.8 424 366.5 421.5 376 C 419 385.5 414.6 394.6 408.5 402 C 402.4 409.4 396.4 416.1 385 420.5 C 373.6 424.9 357.5 430.5 340 428.5 C 322.5 426.5 296 409 280 408.5 C 264 408 255.7 422.2 244 425.5 C 232.3 428.8 221.3 430.2 210 428.5 C 198.7 426.8 185.8 422.6 176 415.5 C 166.2 408.4 156.4 397.9 151.5 386 C 146.6 374.1 145 356.8 146.5 344 C 148 331.2 150.5 321.2 160.5 309 C 170.5 296.8 194.7 285.7 206.5 271 C 218.3 256.3 224.6 232.4 231.5 221 C 238.4 209.6 239.8 207.8 248 202.5 C 256.2 197.2 272.2 191.3 281 189.5 Z";

function round(n: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

function transformCoordinates(targetSize: number) {
  // Uniform scale: fit the larger dimension into targetSize
  const scale = targetSize / Math.max(ORIGINAL_VIEWBOX.w, ORIGINAL_VIEWBOX.h);

  // Center the smaller dimension
  const scaledW = ORIGINAL_VIEWBOX.w * scale;
  const scaledH = ORIGINAL_VIEWBOX.h * scale;
  const offsetX = (targetSize - scaledW) / 2;
  const offsetY = (targetSize - scaledH) / 2;

  const decimals = targetSize === 16 ? 1 : 1;

  console.log(`\n=== Target: ${targetSize}x${targetSize} ===`);
  console.log(`Scale: ${scale}`);
  console.log(`Scaled dimensions: ${round(scaledW, 2)} x ${round(scaledH, 2)}`);
  console.log(`Offset: (${round(offsetX, 2)}, ${round(offsetY, 2)})`);

  // Transform ellipses
  const transformedEllipses = ellipses.map(e => ({
    cx: round(e.cx * scale + offsetX, decimals),
    cy: round(e.cy * scale + offsetY, decimals),
    rx: round(e.rx * scale, decimals),
    ry: round(e.ry * scale, decimals),
  }));

  console.log("\n--- Ellipses ---");
  transformedEllipses.forEach((e, i) => {
    console.log(`<ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}" />`);
  });

  // Transform path data
  // Parse path: M x y followed by C x1 y1 x2 y2 x y pairs, ending with Z
  const transformed = transformPath(pathData, scale, offsetX, offsetY, decimals);
  console.log("\n--- Path ---");
  console.log(transformed);

  // Generate mirrored version (horizontal flip around center)
  const mirroredEllipses = transformedEllipses.map(e => ({
    ...e,
    cx: round(targetSize - e.cx, decimals),
  }));

  console.log("\n--- Mirrored Ellipses (for CatPawRight) ---");
  mirroredEllipses.forEach((e, i) => {
    console.log(`<ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}" />`);
  });

  const mirroredPath = transformPath(pathData, scale, offsetX, offsetY, decimals, targetSize);
  console.log("\n--- Mirrored Path (for CatPawRight) ---");
  console.log(mirroredPath);

  return { transformedEllipses, transformed, mirroredEllipses, mirroredPath };
}

function transformPath(
  path: string,
  scale: number,
  offsetX: number,
  offsetY: number,
  decimals: number,
  mirrorWidth?: number, // if set, flip X around this width
): string {
  // Tokenize: split on whitespace, handle commands
  const tokens = path.trim().split(/\s+/);
  const result: string[] = [];

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];

    if (token === "M" || token === "Z") {
      result.push(token);
      i++;
      if (token === "M") {
        // Next two tokens are x, y
        let x = parseFloat(tokens[i]) * scale + offsetX;
        let y = parseFloat(tokens[i + 1]) * scale + offsetY;
        if (mirrorWidth !== undefined) x = mirrorWidth - x;
        result.push(round(x, decimals).toString());
        result.push(round(y, decimals).toString());
        i += 2;
      }
    } else if (token === "C") {
      result.push("C");
      i++;
      // C takes 6 values: x1 y1 x2 y2 x y
      for (let j = 0; j < 3; j++) {
        let x = parseFloat(tokens[i]) * scale + offsetX;
        let y = parseFloat(tokens[i + 1]) * scale + offsetY;
        if (mirrorWidth !== undefined) x = mirrorWidth - x;
        result.push(round(x, decimals).toString());
        result.push(round(y, decimals).toString());
        i += 2;
      }
    } else {
      // Shouldn't happen with this path, but just in case
      result.push(token);
      i++;
    }
  }

  return result.join(" ");
}

// Generate for both 16x16 and 32x32
const r16 = transformCoordinates(16);
const r32 = transformCoordinates(32);

// Print ready-to-use JSX
console.log("\n\n========== READY-TO-USE JSX ==========\n");

console.log("--- CatPawAvatar (16x16) ---");
console.log(`<svg viewBox="0 0 16 16" fill="currentColor" className={className}>`);
console.log(`  <path d="${r16.transformed}" />`);
r16.transformedEllipses.forEach(e => {
  console.log(`  <ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}" />`);
});
console.log(`</svg>`);

console.log("\n--- CatPawLeft (16x16, same as avatar) ---");
console.log(`<svg viewBox="0 0 16 16" fill="currentColor" className={className} style={style}>`);
console.log(`  <path d="${r16.transformed}" />`);
r16.transformedEllipses.forEach(e => {
  console.log(`  <ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}" />`);
});
console.log(`</svg>`);

console.log("\n--- CatPawRight (16x16, mirrored) ---");
console.log(`<svg viewBox="0 0 16 16" fill="currentColor" className={className} style={style}>`);
console.log(`  <path d="${r16.mirroredPath}" />`);
r16.mirroredEllipses.forEach(e => {
  console.log(`  <ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}" />`);
});
console.log(`</svg>`);

console.log("\n--- PawStamp (32x32) ---");
console.log(`<svg viewBox="0 0 32 32" fill="currentColor" className={className}>`);
console.log(`  <path d="${r32.transformed}" />`);
r32.transformedEllipses.forEach(e => {
  console.log(`  <ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}" />`);
});
console.log(`</svg>`);
