// Универсальное копирование в буфер — работает и на HTTP (не только HTTPS).
// Современный navigator.clipboard доступен только в secure context (HTTPS),
// поэтому для HTTP fallback'имся на старый execCommand через скрытую textarea.
export function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  return Promise.resolve();
}
