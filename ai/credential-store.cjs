const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function psQuote(value) { return `'${String(value).replace(/'/g, "''")}'`; }

class CredentialStore {
  constructor(dataDir, filename = 'ai-key.dpapi') { this.file = path.join(dataDir, 'secrets', filename); this.cached = undefined; }
  has() { return fs.existsSync(this.file) && fs.statSync(this.file).size > 0; }
  save(secret) {
    const value = String(secret || '').trim();
    if (!value) throw new Error('API Key 不能为空');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (process.platform !== 'win32') { fs.writeFileSync(this.file, value, { encoding: 'utf8', mode: 0o600 }); this.cached = value; return; }
    // 加密结果是 ASCII 十六进制文本。Windows PowerShell 5.1 的 UTF8 会写 BOM，
    // BOM 会导致后续 ConvertTo-SecureString 把合法密文判断为格式错误。
    const script = `$s=ConvertTo-SecureString ${psQuote(value)} -AsPlainText -Force; ConvertFrom-SecureString $s | Set-Content -LiteralPath ${psQuote(this.file)} -Encoding ASCII`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    if (result.status !== 0 || !this.has()) throw new Error(`保存 Windows 加密凭据失败：${result.stderr || '未知错误'}`);
    this.cached = value;
  }
  read() {
    if (this.cached !== undefined) return this.cached;
    if (!this.has()) return '';
    if (process.platform !== 'win32') { this.cached = fs.readFileSync(this.file, 'utf8').trim(); return this.cached; }
    // TrimStart 兼容旧版本已经保存的 UTF-8 BOM 凭据文件。
    const script = `$e=(Get-Content -LiteralPath ${psQuote(this.file)} -Raw).Trim(); $e=$e.TrimStart([char]0xFEFF); $s=ConvertTo-SecureString $e; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try {[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)} finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    if (result.status !== 0) throw new Error(`读取 Windows 加密凭据失败：${result.stderr || '未知错误'}`);
    this.cached = result.stdout.trim();
    return this.cached;
  }
  clear() { fs.rmSync(this.file, { force: true }); this.cached = undefined; }
}

module.exports = { CredentialStore };
