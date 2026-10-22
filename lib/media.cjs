'use strict';
// 图片字节识别：按真实文件头判断格式，避免「后缀写 PNG、内容其实是 JPEG」。

function detectImageMime(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) return '';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}
function imageBytesMatchMime(bytes, mime) { return detectImageMime(bytes) === mime; }
function imageExtension(mime) { return mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png'; }

module.exports = { detectImageMime, imageBytesMatchMime, imageExtension };
